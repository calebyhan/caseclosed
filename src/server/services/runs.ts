import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type {
  CaseStatus,
  InfraErrorReason,
  JobType,
  RunResultValue,
  RunType,
} from "../../contracts/lifecycle";
import { ReproductionResult, VerificationResult } from "../../contracts/lifecycle";
import { ResolvedPlan } from "../../contracts/repro";
import { canonicalJson, sha256Hash } from "../../domain/identity";
import type { Db, Tx } from "../db/client";
import {
  applyEventOrThrow,
  loadCaseSnapshot,
  runGuarded,
  TransitionRejectedError,
  type GuardedOutcome,
} from "../db/repositories";
import { cases, jobs, reproSpecs, resolvedPlans, runs } from "../db/schema";

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

    const eventKey = `run-completed:${run.id}`;
    let caseStatus: CaseStatus;
    if (run.runType === "reproduction") {
      const result = ReproductionResult.parse(input.result);
      if (result === "REPRODUCED") promotePlan(tx, run, input.plan, now);
      caseStatus = applyEventOrThrow(
        tx,
        { type: "reproduction_completed", case_id: run.caseId, run_id: run.id, result, event_key: eventKey },
        now,
      ).to;
    } else {
      const result = VerificationResult.parse(input.result);
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

    const infraErrorReason = input.infraErrorReason ?? null;
    tx.update(runs)
      .set({
        status: "completed",
        result: input.result,
        infraError: infraErrorReason !== null,
        infraErrorReason,
        assertionsPassed: input.assertionsPassed ?? null,
        assertionsTotal: input.assertionsTotal ?? null,
        signalsMatched: input.signalsMatched ?? null,
        planRecovered: input.planRecovered ?? false,
        modelCalls: input.modelCalls ?? run.modelCalls,
        observationsJson: input.observations === undefined ? null : canonicalJson(input.observations),
        finishedAt: now,
      })
      .where(eq(runs.id, run.id))
      .run();

    if (input.job) {
      tx.update(jobs)
        .set({ status: input.job.status, lastError: input.job.error ?? null, finishedAt: now, updatedAt: now })
        .where(eq(jobs.id, input.job.id))
        .run();
    }
    return { caseStatus, alreadyFinalized: false };
  });
}

function promotePlan(tx: Tx, run: typeof runs.$inferSelect, rawPlan: unknown, now: number): void {
  const parsed = ResolvedPlan.safeParse(rawPlan);
  if (!parsed.success) throw new Error(`REPRODUCED run ${run.id} requires a valid resolved plan`);
  if (parsed.data.case_id !== run.caseId) throw new Error(`Resolved plan belongs to ${parsed.data.case_id}, not ${run.caseId}`);
  const spec = tx.select({ specHash: reproSpecs.specHash }).from(reproSpecs).where(eq(reproSpecs.id, run.specId)).get();
  if (!spec) throw new Error(`Run ${run.id} references missing spec ${run.specId}`);
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
