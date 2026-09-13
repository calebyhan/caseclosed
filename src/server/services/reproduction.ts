import { eq } from "drizzle-orm";
import type { InfraErrorReason } from "../../contracts/lifecycle";
import { AppContext, ReproSpec, type ResolvedPlan } from "../../contracts/repro";
import type { ActionRecord, ReproductionRunResult, RunObservations } from "../../contracts/run";
import { classifyReproduction } from "../../domain/classify";
import { sha256Hash } from "../../domain/identity";
import { runReproduction, type ReproductionRunOutput } from "../browser/runner";
import type { StagingEnvironment } from "../browser/environment";
import type { BrowserLauncher, RunClock } from "../browser/session";
import type { Db } from "../db/client";
import { reproSpecs, runs } from "../db/schema";
import { reproductionArtifacts, writeRunEvidence, type WrittenEvidence } from "../evidence/collector";
import type { ClaimedJob } from "../jobs/queue";
import type { StepResolver } from "../model/resolve-step";
import type { REPRODUCTION_BUDGETS } from "../../contracts/run";
import { finalizeRun, journalAction, recordRunModelCalls, type FinalizedRun, type PersistedAction } from "./runs";

// Reproduction job: load the immutable experiment, run the semantic browser
// loop, classify the recorded facts deterministically, write evidence, and
// finalize everything in one transaction. The model never decides the result.

export type ReproductionDeps = {
  db: Db;
  /** The currently configured AppContext; drift from the stored snapshot is INCONCLUSIVE. */
  appContext: AppContext;
  environment: StagingEnvironment;
  launcher: BrowserLauncher;
  resolver: StepResolver;
  artifactDir: string;
  knownSecrets: readonly (string | null | undefined)[];
  budgets?: Partial<{ [K in keyof typeof REPRODUCTION_BUDGETS]: number }>;
  clock?: RunClock;
  now?: () => number;
};

export type ReproductionJobOutcome = {
  runId: string;
  result: ReproductionRunResult;
  finalized: FinalizedRun | { rejected: string };
};

export async function handleReproduceJob(job: ClaimedJob, deps: ReproductionDeps, signal?: AbortSignal): Promise<ReproductionJobOutcome> {
  const now = deps.now ?? Date.now;
  if (job.type !== "reproduce" || !job.runId || !job.caseId) throw new Error(`Job ${job.id} is not a claimed reproduction job`);
  const runId = job.runId;

  const run = deps.db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run || run.caseId !== job.caseId || run.runType !== "reproduction") throw new Error(`Run ${runId} does not belong to job ${job.id}`);
  const specRow = deps.db.select().from(reproSpecs).where(eq(reproSpecs.id, run.specId)).get();
  if (!specRow) throw new Error(`Run ${runId} references missing spec ${run.specId}`);
  const spec = ReproSpec.parse(JSON.parse(specRow.specJson));

  const runEpoch = now();
  const absolute = (relativeMs: number) => runEpoch + relativeMs;
  const drift = experimentDrift(spec, specRow, deps);

  let output: ReproductionRunOutput;
  if (drift) {
    output = abortedBeforeStart(spec, specRow.specHash, "environment_changed", drift);
  } else {
    output = await runReproduction({
      spec,
      specHash: specRow.specHash,
      appContext: deps.appContext,
      environment: deps.environment,
      launcher: deps.launcher,
      resolver: deps.resolver,
      knownSecrets: deps.knownSecrets,
      onModelCall: (calls) => recordRunModelCalls(deps.db, runId, calls),
      journal: {
        started: (record) => journalAction(deps.db, runId, toPersisted(record, absolute)),
        finished: (record) => journalAction(deps.db, runId, toPersisted(record, absolute)),
      },
      ...(deps.budgets ? { budgets: deps.budgets } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  let result = classifyReproduction(output.observations, spec);
  let evidence: WrittenEvidence[] = [];
  try {
    evidence = await writeRunEvidence(deps.artifactDir, runId, reproductionArtifacts(output, result));
  } catch (error) {
    // Unwritable evidence cannot support any verdict: infrastructure dominates.
    markInfra(output.observations, "evidence_write_failed", `evidence write failed: ${(error as Error).message}`);
    result = classifyReproduction(output.observations, spec);
  }

  const plan: ResolvedPlan | undefined =
    result.result === "REPRODUCED" ? { case_id: run.caseId, spec_version: "1", actions: output.planActions } : undefined;

  const finalized = finalizeRun(
    deps.db,
    {
      runId,
      result: result.result,
      infraErrorReason: result.infra_error_reason ?? null,
      assertionsPassed: result.assertions_passed,
      assertionsTotal: result.assertions_total,
      signalsMatched: result.signals_matched,
      planRecovered: false,
      modelCalls: output.observations.model_calls,
      observations: output.observations,
      commitSha: output.commitSha,
      plan,
      actions: output.observations.actions.map((record) => toPersisted(record, absolute)),
      checks: [...result.assertions, ...result.signals].map((outcome) => ({
        kind: outcome.kind,
        assertionId: outcome.id,
        type: outcome.type,
        passed: outcome.passed,
        expected: outcome.expected,
        observed: outcome.observed,
        details: { observed_complete: outcome.observed_complete, ...outcome.details },
      })),
      evidence: evidence.map((item) => ({ ...item })),
      job: { id: job.id, status: "completed" },
    },
    now(),
  );

  return { runId, result, finalized: finalized.ok ? finalized.value : { rejected: finalized.rejection.reason } };
}

function experimentDrift(spec: ReproSpec, specRow: typeof reproSpecs.$inferSelect, deps: ReproductionDeps): string | null {
  const currentHash = sha256Hash(deps.appContext);
  if (currentHash !== specRow.appContextHash || spec.app_context_hash !== specRow.appContextHash) {
    return "configured AppContext differs from the snapshot stored with the spec";
  }
  if (sha256Hash(spec) !== specRow.specHash) return "stored spec does not match its recorded hash";
  if (deps.appContext.base_url.replace(/\/+$/, "") !== deps.environment.baseUrl.replace(/\/+$/, "")) {
    return "staging driver base URL differs from the AppContext base_url";
  }
  return null;
}

function toPersisted(record: ActionRecord, absolute: (relativeMs: number) => number): PersistedAction {
  return {
    seq: record.seq,
    stepId: record.step_id,
    action: {
      ...record.action,
      resolution: record.resolution,
      ...(record.locator_used ? { locator_used: record.locator_used } : {}),
    },
    ok: record.ok,
    error: record.error ?? null,
    startedAt: absolute(record.started_at_ms),
    finishedAt: absolute(record.finished_at_ms),
  };
}

function markInfra(observations: RunObservations, reason: InfraErrorReason, detail: string): void {
  observations.infra_error = true;
  observations.infra_error_reason = reason;
  observations.infra_error_detail = detail;
}

function abortedBeforeStart(spec: ReproSpec, specHash: string, reason: InfraErrorReason, detail: string): ReproductionRunOutput {
  return {
    observations: {
      run_type: "reproduction",
      spec_hash: specHash,
      app_context_hash: spec.app_context_hash,
      plan_hash: null,
      health_before: null,
      health_after: null,
      duration_ms: 0,
      actions: [],
      steps_completed: [],
      network: [],
      request_failures: [],
      console: [],
      probe_epoch_ms: null,
      probes: [],
      network_window: null,
      final_url: null,
      infra_error: true,
      infra_error_reason: reason,
      infra_error_detail: detail,
      plan_recovered: false,
      model_calls: 0,
      budgets_used: { actions: 0, replans: 0 },
    },
    screenshots: { before: null, after: null },
    planActions: [],
    commitSha: null,
  };
}
