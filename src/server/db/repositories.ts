import { and, desc, eq, sql } from "drizzle-orm";
import type { CaseStatus, RunType, VerificationResult } from "../../contracts/lifecycle";
import { decideTransition, type CaseEvent, type CaseSnapshot } from "../../domain/state-machine";
import { inTransaction, type Db, type Executor, type Tx } from "./client";
import {
  cases,
  externalLinks,
  fixAttempts,
  rejectedEvents,
  reproSpecs,
  resolvedPlans,
  runs,
  transitions,
} from "./schema";

/** Minimal identity of anything that can be refused: lifecycle events and guarded claims. */
export type RejectableEvent = { case_id: string; type: string; event_key: string | null };

export class TransitionRejectedError extends Error {
  constructor(
    public readonly event: RejectableEvent,
    public readonly fromStatus: CaseStatus | null,
    public readonly reason: string,
  ) {
    super(`Transition rejected for ${event.case_id} (${event.type}): ${reason}`);
    this.name = "TransitionRejectedError";
  }
}

export function loadCaseSnapshot(ex: Executor, caseId: string): CaseSnapshot | null {
  const row = ex.select({ id: cases.id, status: cases.status }).from(cases).where(eq(cases.id, caseId)).get();
  if (!row) return null;

  const spec = ex.select({ id: reproSpecs.id }).from(reproSpecs).where(eq(reproSpecs.caseId, caseId)).get();
  const plan = ex
    .select({ id: resolvedPlans.id, sourceRunId: resolvedPlans.sourceRunId })
    .from(resolvedPlans)
    .where(eq(resolvedPlans.caseId, caseId))
    .get();
  const links = ex
    .select({ linearIssueId: externalLinks.linearIssueId, currentAttemptId: externalLinks.currentAttemptId })
    .from(externalLinks)
    .where(eq(externalLinks.caseId, caseId))
    .get();
  const attempt = links?.currentAttemptId
    ? ex
        .select({ id: fixAttempts.id, commitSha: fixAttempts.commitSha })
        .from(fixAttempts)
        .where(eq(fixAttempts.id, links.currentAttemptId))
        .get()
    : undefined;
  const active = ex
    .select({ id: runs.id, runType: runs.runType, attemptId: runs.attemptId })
    .from(runs)
    .where(and(eq(runs.caseId, caseId), eq(runs.status, "running")))
    .orderBy(desc(runs.createdAt), desc(sql`rowid`))
    .get();
  const latestVerification = ex
    .select({ id: runs.id, result: runs.result, attemptId: runs.attemptId })
    .from(runs)
    .where(and(eq(runs.caseId, caseId), eq(runs.runType, "verification"), eq(runs.status, "completed")))
    .orderBy(desc(runs.finishedAt), desc(sql`rowid`))
    .get();

  return {
    id: row.id,
    status: row.status as CaseStatus,
    specId: spec?.id ?? null,
    plan: plan ?? null,
    linearIssueId: links?.linearIssueId ?? null,
    currentAttempt: attempt ?? null,
    activeRun: active ? { id: active.id, runType: active.runType as RunType, attemptId: active.attemptId } : null,
    latestVerification:
      latestVerification && latestVerification.attemptId
        ? {
            id: latestVerification.id,
            result: latestVerification.result as VerificationResult,
            attemptId: latestVerification.attemptId,
          }
        : null,
  };
}

export type AppliedTransition = { from: CaseStatus | null; to: CaseStatus; duplicate: boolean };

/**
 * The single guarded path for changing `cases.status`. Must run inside a
 * transaction. Duplicate event keys return the original transition before any
 * status check, so dedupe is on event identity rather than current status.
 * Throws TransitionRejectedError so the caller's whole atomic unit rolls back.
 */
export function applyEventOrThrow(tx: Tx, event: CaseEvent, now: number = Date.now()): AppliedTransition {
  const existing = tx
    .select({ fromStatus: transitions.fromStatus, toStatus: transitions.toStatus })
    .from(transitions)
    .where(and(eq(transitions.caseId, event.case_id), eq(transitions.eventKey, event.event_key)))
    .get();
  if (existing) {
    return { from: existing.fromStatus as CaseStatus | null, to: existing.toStatus as CaseStatus, duplicate: true };
  }

  const snapshot = loadCaseSnapshot(tx, event.case_id);
  if (!snapshot) throw new TransitionRejectedError(event, null, "case_not_found");

  const decision = decideTransition(snapshot, event);
  if (!decision.accepted) throw new TransitionRejectedError(event, snapshot.status, decision.reason);

  // Conditional on the expected current status: a concurrent writer cannot be overwritten.
  const updated = tx
    .update(cases)
    .set({ status: decision.next, updatedAt: now })
    .where(and(eq(cases.id, event.case_id), eq(cases.status, decision.from)))
    .run();
  if (updated.changes !== 1) throw new TransitionRejectedError(event, snapshot.status, "stale_expected_status");

  tx.insert(transitions)
    .values({
      caseId: event.case_id,
      fromStatus: decision.from,
      toStatus: decision.next,
      eventType: event.type,
      eventKey: event.event_key,
      trigger: decision.trigger,
      createdAt: now,
    })
    .run();
  return { from: decision.from, to: decision.next, duplicate: false };
}

export type RejectionRecord = {
  caseId: string | null;
  eventType: string;
  eventKey: string | null;
  fromStatus: CaseStatus | null;
  reason: string;
  /** Must already be redacted: never include secrets or raw credentials. */
  payload: unknown;
};

export function recordRejectedEvent(db: Db, rejection: RejectionRecord, now: number = Date.now()): void {
  inTransaction(db, (tx) => {
    tx.insert(rejectedEvents)
      .values({
        caseId: rejection.caseId,
        eventType: rejection.eventType,
        eventKey: rejection.eventKey,
        fromStatus: rejection.fromStatus,
        reason: rejection.reason,
        payloadJson: JSON.stringify(rejection.payload ?? null),
        createdAt: now,
      })
      .run();
  });
}

export type GuardedOutcome<T> = { ok: true; value: T } | { ok: false; rejection: TransitionRejectedError };

/**
 * Runs an atomic unit. If a transition inside it is rejected, all of the
 * unit's writes roll back and the refusal is then audited in its own
 * transaction, so the rejection row survives the rollback.
 */
export function runGuarded<T>(db: Db, work: (tx: Tx) => T): GuardedOutcome<T> {
  try {
    return { ok: true, value: inTransaction(db, work) };
  } catch (error) {
    if (!(error instanceof TransitionRejectedError)) throw error;
    recordRejectedEvent(db, {
      caseId: error.event.case_id,
      eventType: error.event.type,
      eventKey: error.event.event_key,
      fromStatus: error.fromStatus,
      reason: error.reason,
      payload: error.event,
    });
    return { ok: false, rejection: error };
  }
}

export function applyCaseEvent(db: Db, event: CaseEvent): GuardedOutcome<AppliedTransition> {
  return runGuarded(db, (tx) => applyEventOrThrow(tx, event));
}
