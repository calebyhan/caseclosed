import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type {
  CaseStatus,
  InfraErrorReason,
  JobType,
  RunResultValue,
  RunType,
} from "../../contracts/lifecycle";
import { ReproductionResult, VerificationResult } from "../../contracts/lifecycle";
import { AppContext, BrowserAction, ReproSpec, ResolvedPlan } from "../../contracts/repro";
import { REPRODUCTION_BUDGETS, type ReproductionRunResult, type RunObservations, type VerificationRunResult } from "../../contracts/run";
import { classifyReproduction, classifyVerification } from "../../domain/classify";
import { validateProposedAction } from "../../domain/action-policy";
import { canonicalJson, sha256Hash } from "../../domain/identity";
import { inTransaction, type Db, type Tx } from "../db/client";
import {
  applyEventOrThrow,
  loadCaseSnapshot,
  runGuarded,
  TransitionRejectedError,
  type GuardedOutcome,
} from "../db/repositories";
import { assertionResults, browserActions, cases, evidence, jobs, reproSpecs, resolvedPlans, runs } from "../db/schema";

type BrowserJob = {
  id: string;
  type: JobType;
  caseId: string | null;
  runId: string | null;
  attemptId: string | null;
  payload: Record<string, unknown>;
};

export type PreparedRun = { kind: "ready"; runId: string } | { kind: "already_completed"; runId: string };

/**
 * Browser-job claim (atomic unit 3): allocate `jobs.run_id` exactly once,
 * snapshot experiment identity onto the run, and enter REPRODUCING for
 * reproduction. A retried claim reuses the existing run and never creates one.
 */
export function prepareBrowserRun(tx: Tx, job: BrowserJob, now: number): PreparedRun {
  if (!job.caseId) throw new Error(`Browser job ${job.id} has no case`);
  const caseId = job.caseId;
  const runType: RunType = job.type === "reproduce" ? "reproduction" : "verification";

  if (job.runId) {
    const existing = tx.select({ status: runs.status }).from(runs).where(eq(runs.id, job.runId)).get();
    if (!existing) throw new Error(`Job ${job.id} references missing run ${job.runId}`);
    if (existing.status === "completed") return { kind: "already_completed", runId: job.runId };
    tx.update(runs).set({ status: "running", startedAt: now }).where(eq(runs.id, job.runId)).run();
    return { kind: "ready", runId: job.runId };
  }

  const claimEvent = { case_id: caseId, type: `${runType}_claim`, event_key: `claim:${job.id}` };
  const snapshot = loadCaseSnapshot(tx, caseId);
  if (!snapshot) throw new TransitionRejectedError(claimEvent, null, "case_not_found");
  if (!snapshot.specId) throw new TransitionRejectedError(claimEvent, snapshot.status, "no_valid_spec");

  if (runType === "verification") {
    if (snapshot.status !== "VERIFYING") {
      throw new TransitionRejectedError(claimEvent, snapshot.status, "case_not_verifying");
    }
    if (!job.attemptId || snapshot.currentAttempt?.id !== job.attemptId) {
      throw new TransitionRejectedError(claimEvent, snapshot.status, "verification_job_for_stale_attempt");
    }
    if (!snapshot.plan) throw new TransitionRejectedError(claimEvent, snapshot.status, "no_resolved_plan");
  }

  const runId = randomUUID();
  tx.insert(runs)
    .values({
      id: runId,
      caseId,
      runType,
      status: "running",
      specId: snapshot.specId,
      planId: runType === "verification" ? (snapshot.plan?.id ?? null) : null,
      attemptId: runType === "verification" ? job.attemptId : null,
      commitSha: typeof job.payload.commit_sha === "string" ? job.payload.commit_sha : null,
      createdAt: now,
      startedAt: now,
    })
    .run();
  tx.update(jobs).set({ runId, updatedAt: now }).where(eq(jobs.id, job.id)).run();

  if (runType === "reproduction") {
    applyEventOrThrow(tx, { type: "reproduction_claimed", case_id: caseId, run_id: runId, event_key: claimEvent.event_key }, now);
  }
  return { kind: "ready", runId };
}

export type RunFinalization = {
  runId: string;
  result: RunResultValue;
  infraErrorReason?: InfraErrorReason | null;
  assertionsPassed?: number | null;
  assertionsTotal?: number | null;
  signalsMatched?: number | null;
  planRecovered?: boolean;
  modelCalls?: number;
  observations?: unknown;
  /** Required when a reproduction result is REPRODUCED: promoted to the case. */
  plan?: unknown;
  /** Settle the owning browser job in the same transaction. */
  job?: { id: string; status: "completed" | "failed"; error?: string | null };
  /** Build SHA reported by staging health, recorded when the run has none. */
  commitSha?: string | null;
  /** Every action attempt; upserted by (run_id, seq) over journaled rows. */
  actions?: PersistedAction[];
  /** Exactly one row per assertion and failure signal. */
  checks?: PersistedCheck[];
  /** Artifacts already written and renamed to their final paths. */
  evidence?: PersistedEvidence[];
};

export type PersistedAction = {
  seq: number;
  stepId: string;
  action: unknown;
  ok: boolean;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
};

export type PersistedCheck = {
  kind: "assertion" | "signal";
  assertionId: string;
  type: string;
  passed: boolean;
  expected: string;
  observed: string;
  details: unknown;
};

export type PersistedEvidence = {
  id: string;
  kind: string;
  relativePath: string;
  mimeType: string;
  sha256: string | null;
  meta: unknown;
};

export type FinalizedRun = { caseStatus: CaseStatus; alreadyFinalized: boolean };

/**
 * Run finalization (atomic unit 4, foundation subset): result fields, plan
 * promotion on REPRODUCED, and guarded transitions. A STILL_BROKEN verdict is
 * recorded and then immediately returns the case to WAITING_FOR_FIX.
 * Assertion/evidence rows and projection intents are added by later phases.
 */
export function finalizeRun(db: Db, input: RunFinalization, now: number = Date.now()): GuardedOutcome<FinalizedRun> {
  return runGuarded(db, (tx) => {
    const run = tx.select().from(runs).where(eq(runs.id, input.runId)).get();
    if (!run) throw new Error(`Run ${input.runId} does not exist`);
    if (run.status === "completed") {
      if (run.result !== input.result) {
        throw new Error(`Run ${run.id} is already finalized as ${run.result}; refusing ${input.result}`);
      }
      const current = tx.select({ status: cases.status }).from(cases).where(eq(cases.id, run.caseId)).get();
      return { caseStatus: current!.status as CaseStatus, alreadyFinalized: true };
    }

    const deterministic = deriveDeterministicResult(tx, run, input);
    const resultValue = deterministic?.result ?? input.result;
    const actions = actionsBoundToObservations(run, input, now);

    const eventKey = `run-completed:${run.id}`;
    let caseStatus: CaseStatus;
    if (run.runType === "reproduction") {
      const result = ReproductionResult.parse(resultValue);
      if (result === "REPRODUCED") promotePlan(tx, run, input.plan, now);
      caseStatus = applyEventOrThrow(
        tx,
        { type: "reproduction_completed", case_id: run.caseId, run_id: run.id, result, event_key: eventKey },
        now,
      ).to;
    } else {
      const result = VerificationResult.parse(resultValue);
      caseStatus = applyEventOrThrow(
        tx,
        {
          type: "verification_completed",
          case_id: run.caseId,
          run_id: run.id,
          attempt_id: run.attemptId!,
          result,
          event_key: eventKey,
        },
        now,
      ).to;
      if (result === "STILL_BROKEN") {
        caseStatus = applyEventOrThrow(
          tx,
          { type: "await_fix", case_id: run.caseId, event_key: `await-fix:${run.id}` },
          now,
        ).to;
      }
    }

    const infraErrorReason = deterministic?.infra_error_reason ?? input.infraErrorReason ?? null;
    tx.update(runs)
      .set({
        status: "completed",
        result: resultValue,
        infraError: infraErrorReason !== null,
        infraErrorReason,
        assertionsPassed: deterministic?.assertions_passed ?? input.assertionsPassed ?? null,
        assertionsTotal: deterministic?.assertions_total ?? input.assertionsTotal ?? null,
        signalsMatched: deterministic?.signals_matched ?? input.signalsMatched ?? null,
        planRecovered: deterministic?.plan_recovered ?? input.planRecovered ?? false,
        modelCalls: deterministic?.model_calls ?? input.modelCalls ?? run.modelCalls,
        observationsJson: input.observations === undefined ? null : canonicalJson(input.observations),
        commitSha: run.commitSha ?? input.commitSha ?? null,
        finishedAt: now,
      })
      .where(eq(runs.id, run.id))
      .run();

    for (const action of actions) upsertAction(tx, run.id, action);
    const checks = deterministic
      ? [...deterministic.assertions, ...deterministic.signals].map((outcome) => ({
          kind: outcome.kind,
          assertionId: outcome.id,
          type: outcome.type,
          passed: outcome.passed,
          expected: outcome.expected,
          observed: outcome.observed,
          details: { observed_complete: outcome.observed_complete, ...outcome.details },
        }))
      : (input.checks ?? []);
    const seenChecks = new Set<string>();
    for (const check of checks) {
      const key = `${check.kind}:${check.assertionId}`;
      if (seenChecks.has(key)) throw new Error(`Run ${run.id} has duplicate ${key} results`);
      seenChecks.add(key);
      tx.insert(assertionResults)
        .values({
          id: randomUUID(),
          runId: run.id,
          kind: check.kind,
          assertionId: check.assertionId,
          type: check.type,
          passed: check.passed,
          expected: check.expected,
          observed: check.observed,
          detailsJson: JSON.stringify(check.details ?? null),
        })
        .run();
    }
    for (const item of input.evidence ?? []) {
      tx.insert(evidence)
        .values({
          id: item.id,
          runId: run.id,
          kind: item.kind,
          relativePath: item.relativePath,
          mimeType: item.mimeType,
          sha256: item.sha256,
          metaJson: JSON.stringify(item.meta ?? null),
          createdAt: now,
        })
        .run();
    }

    if (input.job) {
      tx.update(jobs)
        .set({ status: input.job.status, lastError: input.job.error ?? null, finishedAt: now, updatedAt: now })
        .where(eq(jobs.id, input.job.id))
        .run();
    }
    return { caseStatus, alreadyFinalized: false };
  });
}

function actionsBoundToObservations(
  run: typeof runs.$inferSelect,
  input: RunFinalization,
  now: number,
): PersistedAction[] {
  if (input.observations === undefined) return input.actions ?? [];
  const observations = input.observations as RunObservations;
  if (!Array.isArray(observations.actions)) throw new Error(`Run ${run.id} action observations are missing`);

  if (input.actions) {
    if (input.actions.length !== observations.actions.length) {
      throw new Error(`Run ${run.id} persisted action evidence does not match its observations`);
    }
    for (const [index, persisted] of input.actions.entries()) {
      const observed = observations.actions[index]!;
      const raw = persisted.action;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`Run ${run.id} persisted action ${index} is invalid`);
      }
      const { resolution, locator_used: locatorUsed, ...actionFields } = raw as Record<string, unknown>;
      const parsedAction = BrowserAction.safeParse(actionFields);
      const same =
        persisted.seq === observed.seq &&
        persisted.stepId === observed.step_id &&
        persisted.ok === observed.ok &&
        (persisted.error ?? undefined) === observed.error &&
        parsedAction.success &&
        canonicalJson(parsedAction.data) === canonicalJson(observed.action) &&
        resolution === observed.resolution &&
        locatorUsed === observed.locator_used;
      if (!same) throw new Error(`Run ${run.id} persisted action evidence does not match observation ${observed.seq}`);
    }
    return input.actions;
  }

  const epoch = run.startedAt ?? now;
  return observations.actions.map((record) => ({
    seq: record.seq,
    stepId: record.step_id,
    action: {
      ...record.action,
      resolution: record.resolution,
      ...(record.locator_used ? { locator_used: record.locator_used } : {}),
    },
    ok: record.ok,
    error: record.error ?? null,
    startedAt: epoch + record.started_at_ms,
    finishedAt: epoch + record.finished_at_ms,
  }));
}

type DeterministicResult = ReproductionRunResult | VerificationRunResult;

function deriveDeterministicResult(
  tx: Tx,
  run: typeof runs.$inferSelect,
  input: RunFinalization,
): DeterministicResult {
  if (input.observations === undefined) {
    if (input.result !== "INCONCLUSIVE") {
      throw new Error(`Run ${run.id} requires deterministic observations before it can finalize as ${input.result}`);
    }
    if (!input.infraErrorReason) throw new Error(`INCONCLUSIVE run ${run.id} without observations requires an infrastructure reason`);
  }

  const specRow = tx.select().from(reproSpecs).where(eq(reproSpecs.id, run.specId)).get();
  if (!specRow) throw new Error(`Run ${run.id} references missing spec ${run.specId}`);
  let spec: ReproSpec;
  let appContext: AppContext;
  try {
    spec = ReproSpec.parse(JSON.parse(specRow.specJson));
    appContext = AppContext.parse(JSON.parse(specRow.appContextJson));
  } catch (error) {
    throw new Error(`Run ${run.id} has invalid immutable experiment data: ${(error as Error).message}`);
  }
  if (sha256Hash(spec) !== specRow.specHash || sha256Hash(appContext) !== specRow.appContextHash) {
    throw new Error(`Run ${run.id} immutable experiment hashes do not match their snapshots`);
  }
  const observations = input.observations === undefined
    ? missingObservations(run, spec, input.infraErrorReason!)
    : input.observations as RunObservations;
  let derived: DeterministicResult;
  try {
    if (input.observations !== undefined) validateObservationActions(observations, spec, appContext);
    if (run.runType === "reproduction") {
      derived = classifyReproduction(observations, spec);
    } else {
      if (!run.planId) throw new Error("verification run has no saved plan");
      const planRow = tx.select().from(resolvedPlans).where(eq(resolvedPlans.id, run.planId)).get();
      if (!planRow) throw new Error(`verification run references missing plan ${run.planId}`);
      const plan = ResolvedPlan.parse(JSON.parse(planRow.planJson));
      if (planRow.specId !== run.specId || planRow.specHash !== specRow.specHash) throw new Error("verification plan is bound to a different spec");
      if (!run.commitSha) throw new Error("verification run has no expected commit SHA");
      derived = classifyVerification(observations, spec, plan, run.commitSha);
    }
  } catch (error) {
    throw new Error(`Run ${run.id} has invalid deterministic observations: ${(error as Error).message}`);
  }

  if (derived.result !== input.result) {
    throw new Error(`Run ${run.id} observations classify as ${derived.result}; refusing caller-supplied ${input.result}`);
  }
  const claimed = [
    ["assertionsPassed", input.assertionsPassed, derived.assertions_passed],
    ["assertionsTotal", input.assertionsTotal, derived.assertions_total],
    ["signalsMatched", input.signalsMatched, derived.signals_matched],
    ["modelCalls", input.modelCalls, derived.model_calls],
  ] as const;
  for (const [name, provided, actual] of claimed) {
    if (provided !== undefined && provided !== null && provided !== actual) {
      throw new Error(`Run ${run.id} ${name} is ${actual} from observations, not ${provided}`);
    }
  }
  if (input.infraErrorReason !== undefined && input.infraErrorReason !== null && input.infraErrorReason !== derived.infra_error_reason) {
    throw new Error(`Run ${run.id} infrastructure reason does not match its observations`);
  }
  return derived;
}

function missingObservations(
  run: typeof runs.$inferSelect,
  spec: ReproSpec,
  reason: InfraErrorReason,
): RunObservations {
  return {
    run_type: run.runType as RunType,
    spec_hash: sha256Hash(spec),
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
    plan_recovered: false,
    model_calls: run.modelCalls,
    budgets_used: { actions: 0, replans: 0 },
  };
}

function validateObservationActions(observations: RunObservations, spec: ReproSpec, appContext: AppContext): void {
  if (!Array.isArray(observations.actions)) throw new Error("action log is missing");
  let route = spec.environment.start_path;
  for (const record of observations.actions) {
    const policy = validateProposedAction(record.action, appContext, [], route);
    if (!policy.ok) throw new Error(`action ${record.seq} violates the browser policy: ${policy.error}`);
    if (record.ok && policy.action.type === "goto") route = policy.action.path.split(/[?#]/)[0]!;
  }
}

function upsertAction(tx: Tx, runId: string, action: PersistedAction): void {
  tx.insert(browserActions)
    .values({
      id: randomUUID(),
      runId,
      seq: action.seq,
      stepId: action.stepId,
      actionJson: JSON.stringify(action.action),
      ok: action.ok,
      error: action.error,
      startedAt: action.startedAt,
      finishedAt: action.finishedAt,
    })
    .onConflictDoUpdate({
      target: [browserActions.runId, browserActions.seq],
      set: { ok: action.ok, error: action.error, finishedAt: action.finishedAt, actionJson: JSON.stringify(action.action), stepId: action.stepId },
    })
    .run();
}

/**
 * Short run-scoped write: action intent before dispatch, outcome after. A crash
 * keeps what was already durable; finalization upserts over these rows.
 */
export function journalAction(db: Db, runId: string, action: PersistedAction): void {
  inTransaction(db, (tx) => {
    const run = tx.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get();
    if (run?.status !== "running") throw new Error(`Run ${runId} is not running; refusing to journal action ${action.seq}`);
    upsertAction(tx, runId, action);
  });
}

/** Persisted before each step-resolution call is dispatched. */
export function recordRunModelCalls(db: Db, runId: string, calls: number): void {
  const updated = db.update(runs).set({ modelCalls: calls }).where(and(eq(runs.id, runId), eq(runs.status, "running"))).run();
  if (updated.changes !== 1) throw new Error(`Run ${runId} is not running; refusing to record model calls`);
}

/** Persisted before each spec-generation call is dispatched. */
export function recordJobModelCalls(db: Db, jobId: string, calls: number, now: number = Date.now()): void {
  const updated = db.update(jobs).set({ modelCalls: calls, updatedAt: now }).where(and(eq(jobs.id, jobId), eq(jobs.status, "running"))).run();
  if (updated.changes !== 1) throw new Error(`Job ${jobId} is not running; refusing to record model calls`);
}

function promotePlan(tx: Tx, run: typeof runs.$inferSelect, rawPlan: unknown, now: number): void {
  const parsed = ResolvedPlan.safeParse(rawPlan);
  if (!parsed.success) throw new Error(`REPRODUCED run ${run.id} requires a valid resolved plan`);
  if (parsed.data.case_id !== run.caseId) throw new Error(`Resolved plan belongs to ${parsed.data.case_id}, not ${run.caseId}`);
  const spec = tx.select().from(reproSpecs).where(eq(reproSpecs.id, run.specId)).get();
  if (!spec) throw new Error(`Run ${run.id} references missing spec ${run.specId}`);
  const reproSpec = ReproSpec.parse(JSON.parse(spec.specJson));
  const appContext = AppContext.parse(JSON.parse(spec.appContextJson));
  if (parsed.data.actions.length !== reproSpec.steps.length) {
    throw new Error(`Resolved plan must contain one action for every spec step`);
  }
  if (parsed.data.actions.length + 1 > REPRODUCTION_BUDGETS.maxBrowserActions) {
    throw new Error("Resolved plan plus start navigation exceeds the browser action budget");
  }
  let route = reproSpec.environment.start_path;
  for (const [index, step] of reproSpec.steps.entries()) {
    const planned = parsed.data.actions[index]!;
    if (planned.step_id !== step.id) throw new Error(`Resolved plan step order differs at ${index}: expected ${step.id}, got ${planned.step_id}`);
    const policy = validateProposedAction(planned.action, appContext, [], route);
    if (!policy.ok) throw new Error(`Resolved plan action for ${step.id} is invalid: ${policy.error}`);
    if (policy.action.type === "goto") route = policy.action.path.split(/[?#]/)[0]!;
  }
  if (!parsed.data.actions.some(({ action }) => action.type === "click" || action.type === "fill" || action.type === "select" || action.type === "goto")) {
    throw new Error("Resolved plan must contain at least one real interaction or navigation");
  }
  const planId = randomUUID();
  tx.insert(resolvedPlans)
    .values({
      id: planId,
      caseId: run.caseId,
      specId: run.specId,
      specHash: spec.specHash,
      sourceRunId: run.id,
      planJson: canonicalJson(parsed.data),
      planHash: sha256Hash(parsed.data),
      createdAt: now,
    })
    .run();
  tx.update(runs).set({ planId }).where(eq(runs.id, run.id)).run();
}
