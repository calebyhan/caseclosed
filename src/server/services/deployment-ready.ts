import { and, eq } from "drizzle-orm";
import type { CaseStatus } from "../../contracts/lifecycle";
import { effectKeys, jobKeys, sha256Hash } from "../../domain/identity";
import { inTransaction, type Db } from "../db/client";
import { applyEventOrThrow, recordRejectedEvent, TransitionRejectedError } from "../db/repositories";
import { cases, externalLinks, fixAttempts, inboundEvents, jobs, runs } from "../db/schema";
import { enqueueUnique } from "../jobs/queue";
import { ensureEffect } from "../side-effects/ledger";

export type DeploymentReadyInput = { pr: number; commit_sha: string; retry?: boolean; retry_of_run_id?: string };
export type ReadyResponse = { status: "accepted" | "duplicate"; case_id: string; job_id: string; run_id: string | null };
export type ReadyOutcome = { ok: true; response: ReadyResponse } | { ok: false; reason: string };

export function acceptDeploymentReady(
  db: Db,
  input: DeploymentReadyInput,
  options: { repository: string; now?: () => number },
): ReadyOutcome {
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(input.pr) || input.pr < 1 || !/^[0-9a-f]{7,64}$/i.test(input.commit_sha)) {
    return reject(db, input, null, "invalid_deployment_identity", now());
  }
  if (input.retry !== true && input.retry_of_run_id) return reject(db, input, null, "retry_predecessor_without_retry", now());
  if (input.retry === true && !input.retry_of_run_id) return reject(db, input, null, "retry_of_run_id_required", now());

  const attempt = db.select().from(fixAttempts).where(and(
    eq(fixAttempts.repository, options.repository),
    eq(fixAttempts.prNumber, input.pr),
    eq(fixAttempts.commitSha, input.commit_sha),
  )).get();
  if (!attempt) return reject(db, input, null, "unknown_pr_sha", now());
  const generation = input.retry ? `retry:${input.retry_of_run_id}` : "initial";
  const eventKey = `deployment:${attempt.caseId}:${input.commit_sha}:${generation}`;
  const payloadHash = sha256Hash({
    pr: input.pr,
    commit_sha: input.commit_sha,
    retry: input.retry === true,
    retry_of_run_id: input.retry_of_run_id ?? null,
  });
  const existing = db.select().from(inboundEvents).where(eq(inboundEvents.eventKey, eventKey)).get();
  if (existing) {
    if (existing.payloadHash !== payloadHash) return reject(db, input, attempt.caseId, "event_payload_conflict", now());
    const saved = JSON.parse(existing.responseJson) as ReadyResponse;
    const job = existing.jobId ? db.select({ runId: jobs.runId }).from(jobs).where(eq(jobs.id, existing.jobId)).get() : null;
    return { ok: true, response: { ...saved, status: "duplicate", run_id: job?.runId ?? saved.run_id } };
  }

  try {
    const response = inTransaction(db, (tx) => {
      const caseRow = tx.select({ status: cases.status, trigger: cases.sourceTriggerId, channel: cases.sourceChannelId }).from(cases).where(eq(cases.id, attempt.caseId)).get();
      const links = tx.select({ currentAttemptId: externalLinks.currentAttemptId }).from(externalLinks).where(eq(externalLinks.caseId, attempt.caseId)).get();
      if (!caseRow || links?.currentAttemptId !== attempt.id) throw new TransitionRejectedError(
        { case_id: attempt.caseId, type: "deployment_ready", event_key: eventKey },
        (caseRow?.status as CaseStatus | undefined) ?? null,
        "stale_fix_attempt",
      );
      if (input.retry) {
        const predecessor = tx.select().from(runs).where(eq(runs.id, input.retry_of_run_id!)).get();
        if (!predecessor || predecessor.caseId !== attempt.caseId || predecessor.attemptId !== attempt.id || predecessor.result !== "INCONCLUSIVE") {
          throw new TransitionRejectedError({ case_id: attempt.caseId, type: "verification_retry", event_key: eventKey }, caseRow.status as CaseStatus, "invalid_retry_predecessor");
        }
        applyEventOrThrow(tx, {
          type: "verification_retry",
          case_id: attempt.caseId,
          retry_of_run_id: input.retry_of_run_id!,
          event_key: `verification-retry:${attempt.id}:${input.retry_of_run_id}`,
        }, now());
      }
      const key = input.retry
        ? jobKeys.verifyRetry(attempt.caseId, attempt.commitSha, input.retry_of_run_id!)
        : jobKeys.verifyInitial(attempt.caseId, attempt.commitSha);
      const job = enqueueUnique(tx, {
        key,
        type: "verify",
        caseId: attempt.caseId,
        attemptId: attempt.id,
        payload: {
          case_id: attempt.caseId,
          attempt_id: attempt.id,
          commit_sha: attempt.commitSha,
          ...(input.retry ? { retry_of_run_id: input.retry_of_run_id } : {}),
        },
      }, now());
      applyEventOrThrow(tx, {
        type: "deployment_ready",
        case_id: attempt.caseId,
        attempt_id: attempt.id,
        commit_sha: attempt.commitSha,
        event_key: eventKey,
      }, now());
      ensureEffect(tx, {
        key: effectKeys.slackVerificationStarted(attempt.id, generation.replace(/:/g, "-")),
        type: "slack.reply",
        caseId: attempt.caseId,
        attemptId: attempt.id,
        destination: { channel_id: caseRow.channel, root_effect_key: effectKeys.slackCaseCreated(caseRow.trigger) },
        payload: { case_id: attempt.caseId, pr_number: attempt.prNumber, commit_sha: attempt.commitSha },
      }, now());
      const value: ReadyResponse = { status: "accepted", case_id: attempt.caseId, job_id: job.jobId, run_id: null };
      tx.insert(inboundEvents).values({
        eventKey,
        eventType: "deployment_ready",
        payloadHash,
        caseId: attempt.caseId,
        attemptId: attempt.id,
        jobId: job.jobId,
        responseJson: JSON.stringify(value),
        receivedAt: now(),
      }).run();
      return value;
    });
    return { ok: true, response };
  } catch (error) {
    if (!(error instanceof TransitionRejectedError)) throw error;
    return reject(db, input, attempt.caseId, error.reason, now());
  }
}

function reject(db: Db, input: DeploymentReadyInput, caseId: string | null, reason: string, at: number): ReadyOutcome {
  const status = caseId ? db.select({ status: cases.status }).from(cases).where(eq(cases.id, caseId)).get()?.status as CaseStatus | undefined : undefined;
  recordRejectedEvent(db, {
    caseId,
    eventType: "deployment_ready",
    eventKey: null,
    fromStatus: status ?? null,
    reason,
    payload: { pr: input.pr, commit_sha: input.commit_sha, retry: input.retry ?? false, retry_of_run_id: input.retry_of_run_id ?? null },
  }, at);
  return { ok: false, reason };
}
