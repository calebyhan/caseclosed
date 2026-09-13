import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { BROWSER_JOB_TYPES, type JobType } from "../../contracts/lifecycle";
import { sha256Hash } from "../../domain/identity";
import { inTransaction, type Db, type Tx } from "../db/client";
import { recordRejectedEvent, TransitionRejectedError } from "../db/repositories";
import { jobs } from "../db/schema";
import { prepareBrowserRun } from "../services/runs";

// Durable FIFO SQLite queue with a single worker. No delayed scheduling:
// jobs are eligible as soon as they are pending.

export class JobConflictError extends Error {
  constructor(key: string) {
    super(`Job ${key} already exists with a different frozen payload`);
    this.name = "JobConflictError";
  }
}

export type NewJob = {
  key: string;
  type: JobType;
  caseId?: string | null;
  attemptId?: string | null;
  effectKey?: string | null;
  payload: Record<string, unknown>;
};

/**
 * Reserves a job by idempotency key. A duplicate key with the same frozen
 * payload returns the existing job; a different payload is a programming error.
 */
export function enqueueUnique(tx: Tx, job: NewJob, now: number = Date.now()): { jobId: string; created: boolean } {
  const payloadHash = sha256Hash({ type: job.type, payload: job.payload });
  const existing = tx
    .select({ id: jobs.id, payloadHash: jobs.payloadHash })
    .from(jobs)
    .where(eq(jobs.idempotencyKey, job.key))
    .get();
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new JobConflictError(job.key);
    return { jobId: existing.id, created: false };
  }
  const id = randomUUID();
  tx.insert(jobs)
    .values({
      id,
      idempotencyKey: job.key,
      type: job.type,
      status: "pending",
      caseId: job.caseId ?? null,
      attemptId: job.attemptId ?? null,
      effectKey: job.effectKey ?? null,
      payloadJson: JSON.stringify(job.payload),
      payloadHash,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { jobId: id, created: true };
}

export type ClaimedJob = {
  id: string;
  seq: number;
  key: string;
  type: JobType;
  caseId: string | null;
  runId: string | null;
  attemptId: string | null;
  effectKey: string | null;
  payload: Record<string, unknown>;
  attemptCount: number;
  modelCalls: number;
};

type ClaimOutcome = { kind: "claimed"; job: ClaimedJob } | { kind: "settled" } | { kind: "empty" };

/**
 * Claims the oldest pending job whose type is in `types`. Browser jobs get
 * their run identity assigned atomically on first claim.
 */
export function claimNext(db: Db, types: readonly JobType[], now: number = Date.now()): ClaimedJob | null {
  if (types.length === 0) return null;
  for (;;) {
    const outcome = claimOnce(db, types, now);
    if (outcome.kind === "claimed") return outcome.job;
    if (outcome.kind === "empty") return null;
  }
}

function claimOnce(db: Db, types: readonly JobType[], now: number): ClaimOutcome {
  let candidateId: string | null = null;
  try {
    return inTransaction(db, (tx): ClaimOutcome => {
      const row = tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, "pending"), inArray(jobs.type, [...types])))
        .orderBy(asc(jobs.seq))
        .get();
      if (!row) return { kind: "empty" };
      candidateId = row.id;

      const claimed = tx
        .update(jobs)
        .set({
          status: "running",
          attemptCount: row.attemptCount + 1,
          cycleAttemptCount: row.cycleAttemptCount + 1,
          startedAt: now,
          updatedAt: now,
        })
        .where(and(eq(jobs.id, row.id), eq(jobs.status, "pending")))
        .run();
      if (claimed.changes !== 1) return { kind: "settled" };

      const type = row.type as JobType;
      const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
      let runId = row.runId;
      if (BROWSER_JOB_TYPES.has(type)) {
        const prepared = prepareBrowserRun(
          tx,
          { id: row.id, type, caseId: row.caseId, runId: row.runId, attemptId: row.attemptId, payload },
          now,
        );
        if (prepared.kind === "already_completed") {
          // A finished experiment is never replayed; only its job bookkeeping settles.
          settleJob(tx, row.id, "completed", null, now);
          return { kind: "settled" };
        }
        runId = prepared.runId;
      }

      return {
        kind: "claimed",
        job: {
          id: row.id,
          seq: row.seq,
          key: row.idempotencyKey,
          type,
          caseId: row.caseId,
          runId,
          attemptId: row.attemptId,
          effectKey: row.effectKey,
          payload,
          attemptCount: row.attemptCount + 1,
          modelCalls: row.modelCalls,
        },
      };
    });
  } catch (error) {
    if (!(error instanceof TransitionRejectedError) || candidateId === null) throw error;
    // The claim rolled back; audit the refusal and fail the job so it cannot block the queue.
    const failedJobId: string = candidateId;
    recordRejectedEvent(db, {
      caseId: error.event.case_id,
      eventType: error.event.type,
      eventKey: error.event.event_key,
      fromStatus: error.fromStatus,
      reason: error.reason,
      payload: { job_id: failedJobId },
    });
    inTransaction(db, (tx) => settleJob(tx, failedJobId, "failed", `claim_rejected: ${error.reason}`, now, "pending"));
    return { kind: "settled" };
  }
}

function settleJob(
  tx: Tx,
  jobId: string,
  status: "completed" | "failed",
  error: string | null,
  now: number,
  expectedStatus: "running" | "pending" = "running",
): boolean {
  const result = tx
    .update(jobs)
    .set({ status, lastError: error, finishedAt: now, updatedAt: now })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, expectedStatus)))
    .run();
  return result.changes === 1;
}

export function completeJob(db: Db, jobId: string, now: number = Date.now()): boolean {
  return inTransaction(db, (tx) => settleJob(tx, jobId, "completed", null, now));
}

export function failJob(db: Db, jobId: string, error: string, now: number = Date.now()): boolean {
  return inTransaction(db, (tx) => settleJob(tx, jobId, "failed", error, now));
}

/** Completes or fails a job inside a caller's atomic unit (e.g. run finalization). */
export function settleJobInTx(tx: Tx, jobId: string, status: "completed" | "failed", error: string | null, now: number): boolean {
  return settleJob(tx, jobId, status, error, now);
}

/** Returns a running job to the pending queue, keeping cumulative attempt counts. */
export function requeueJobInTx(tx: Tx, jobId: string, now: number): boolean {
  const result = tx
    .update(jobs)
    .set({ status: "pending", startedAt: null, updatedAt: now })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")))
    .run();
  return result.changes === 1;
}
