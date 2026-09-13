import { eq } from "drizzle-orm";
import type { InfraErrorReason } from "../../contracts/lifecycle";
import { AppContext, ReproSpec, ResolvedPlan } from "../../contracts/repro";
import type { ActionRecord, RunObservations, VerificationRunResult } from "../../contracts/run";
import { classifyVerification } from "../../domain/classify";
import { sha256Hash } from "../../domain/identity";
import type { BrowserLauncher, RunClock } from "../browser/session";
import type { StagingEnvironment } from "../browser/environment";
import { runVerification, type VerificationRunOutput } from "../browser/runner";
import type { Db } from "../db/client";
import { reproSpecs, resolvedPlans, runs } from "../db/schema";
import { reproductionArtifacts, writeRunEvidence, type WrittenEvidence } from "../evidence/collector";
import type { ClaimedJob } from "../jobs/queue";
import { finalizeRun, journalAction, type FinalizedRun, type PersistedAction } from "./runs";

export type VerificationDeps = {
  db: Db;
  appContext: AppContext;
  environment: StagingEnvironment;
  launcher: BrowserLauncher;
  artifactDir: string;
  knownSecrets: readonly (string | null | undefined)[];
  clock?: RunClock;
  now?: () => number;
};

export type VerificationJobOutcome = {
  runId: string;
  result: VerificationRunResult;
  finalized: FinalizedRun | { rejected: string };
};

/** Loads and replays the exact immutable reproduction experiment, with zero model calls. */
export async function handleVerifyJob(
  job: ClaimedJob,
  deps: VerificationDeps,
  signal?: AbortSignal,
): Promise<VerificationJobOutcome> {
  const now = deps.now ?? Date.now;
  if (job.type !== "verify" || !job.runId || !job.caseId || !job.attemptId) {
    throw new Error(`Job ${job.id} is not a claimed verification job`);
  }
  const run = deps.db.select().from(runs).where(eq(runs.id, job.runId)).get();
  if (!run || run.caseId !== job.caseId || run.runType !== "verification" || run.attemptId !== job.attemptId) {
    throw new Error(`Run ${job.runId} does not belong to verification job ${job.id}`);
  }
  if (!run.planId || !run.commitSha) throw new Error(`Verification run ${run.id} is missing immutable plan/deployment identity`);

  const specRow = deps.db.select().from(reproSpecs).where(eq(reproSpecs.id, run.specId)).get();
  const planRow = deps.db.select().from(resolvedPlans).where(eq(resolvedPlans.id, run.planId)).get();
  if (!specRow || !planRow) throw new Error(`Verification run ${run.id} references a missing experiment`);
  const spec = ReproSpec.parse(JSON.parse(specRow.specJson));
  const storedContext = AppContext.parse(JSON.parse(specRow.appContextJson));
  const plan = ResolvedPlan.parse(JSON.parse(planRow.planJson));

  const runEpoch = now();
  const absolute = (relativeMs: number) => runEpoch + relativeMs;
  const drift = verifyExperimentIdentity(spec, storedContext, plan, specRow, planRow, deps.appContext, deps.environment.baseUrl, run.caseId);
  let output: VerificationRunOutput;
  if (drift) {
    output = aborted(spec, specRow.specHash, planRow.planHash, "environment_changed", drift);
  } else {
    output = await runVerification({
      spec,
      specHash: specRow.specHash,
      appContext: storedContext,
      environment: deps.environment,
      launcher: deps.launcher,
      plan,
      planHash: planRow.planHash,
      expectedCommitSha: run.commitSha,
      knownSecrets: deps.knownSecrets,
      journal: {
        started: (record) => journalAction(deps.db, run.id, toPersisted(record, absolute)),
        finished: (record) => journalAction(deps.db, run.id, toPersisted(record, absolute)),
      },
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  let result = classifyVerification(output.observations, spec, plan, run.commitSha);
  let written: WrittenEvidence[] = [];
  try {
    written = await writeRunEvidence(deps.artifactDir, run.id, reproductionArtifacts(output, result));
  } catch (error) {
    markInfra(output.observations, "evidence_write_failed", `evidence write failed: ${(error as Error).message}`);
    result = classifyVerification(output.observations, spec, plan, run.commitSha);
  }

  const finalized = finalizeRun(deps.db, {
    runId: run.id,
    result: result.result,
    infraErrorReason: result.infra_error_reason ?? null,
    assertionsPassed: result.assertions_passed,
    assertionsTotal: result.assertions_total,
    signalsMatched: result.signals_matched,
    planRecovered: false,
    modelCalls: 0,
    observations: output.observations,
    commitSha: output.commitSha,
    actions: output.observations.actions.map((record) => toPersisted(record, absolute)),
    evidence: written,
    job: { id: job.id, status: "completed" },
  }, now());

  return { runId: run.id, result, finalized: finalized.ok ? finalized.value : { rejected: finalized.rejection.reason } };
}

function verifyExperimentIdentity(
  spec: ReproSpec,
  storedContext: AppContext,
  plan: ResolvedPlan,
  specRow: typeof reproSpecs.$inferSelect,
  planRow: typeof resolvedPlans.$inferSelect,
  currentContext: AppContext,
  environmentBaseUrl: string,
  caseId: string,
): string | null {
  if (sha256Hash(spec) !== specRow.specHash) return "stored ReproSpec hash does not match";
  if (sha256Hash(storedContext) !== specRow.appContextHash || sha256Hash(currentContext) !== specRow.appContextHash) {
    return "AppContext differs from the original persisted snapshot";
  }
  if (environmentBaseUrl.replace(/\/+$/, "") !== storedContext.base_url.replace(/\/+$/, "")) {
    return "staging driver base URL differs from the original AppContext";
  }
  if (sha256Hash(plan) !== planRow.planHash || planRow.specHash !== specRow.specHash || planRow.specId !== specRow.id) {
    return "resolved plan does not match the original persisted experiment";
  }
  if (plan.case_id !== caseId || plan.spec_version !== spec.version) return "resolved plan identity differs from the case/spec";
  if (plan.actions.length !== spec.steps.length || plan.actions.some((item, i) => item.step_id !== spec.steps[i]!.id)) {
    return "resolved plan is not a literal action for every original step";
  }
  return null;
}

function toPersisted(record: ActionRecord, absolute: (relativeMs: number) => number): PersistedAction {
  return {
    seq: record.seq,
    stepId: record.step_id,
    action: { ...record.action, resolution: record.resolution, ...(record.locator_used ? { locator_used: record.locator_used } : {}) },
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

function aborted(
  spec: ReproSpec,
  specHash: string,
  planHash: string,
  reason: InfraErrorReason,
  detail: string,
): VerificationRunOutput {
  return {
    observations: {
      run_type: "verification",
      spec_hash: specHash,
      app_context_hash: spec.app_context_hash,
      plan_hash: planHash,
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
