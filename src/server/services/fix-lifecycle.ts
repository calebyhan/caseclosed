import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { effectKeys, isCaseId, sha256Hash } from "../../domain/identity";
import type { CaseStatus } from "../../contracts/lifecycle";
import type { Db } from "../db/client";
import { applyEventOrThrow, recordRejectedEvent, runGuarded } from "../db/repositories";
import { cases, externalLinks, fixAttempts, inboundEvents } from "../db/schema";
import type { PullRequestMetadata } from "../integrations/github";
import { ensureEffect } from "../side-effects/ledger";

export type MergeEvent = { repository: string; pr: number; commitSha: string; deliveryId: string };
export type MergeAcceptance =
  | { ok: true; duplicate: boolean; caseId: string; attemptId: string }
  | { ok: false; reason: string };

export function parsePrAssociations(body: string, linearTeamKey?: string): { caseIds: string[]; linearIds: string[] } {
  const caseIds = [...body.matchAll(/\bCaseClosed\s*:\s*(CC-\d{4,})\b/gi)].map((match) => match[1]!.toUpperCase());
  const key = linearTeamKey?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "[A-Z][A-Z0-9]+";
  const linearIds = [...body.matchAll(new RegExp(`\\bFixes\\s+(${key}-\\d+)\\b`, "gi"))].map((match) => match[1]!.toUpperCase());
  return { caseIds: [...new Set(caseIds)], linearIds: [...new Set(linearIds)] };
}

export async function acceptMergedPullRequest(
  db: Db,
  event: MergeEvent,
  getMetadata: () => Promise<PullRequestMetadata>,
  options: { expectedRepository: string; defaultBranch: string; linearTeamKey?: string; now?: () => number },
): Promise<MergeAcceptance> {
  const now = options.now ?? Date.now;
  if (event.repository !== options.expectedRepository) return reject(db, event, null, "wrong_repository", now());
  if (!Number.isSafeInteger(event.pr) || event.pr < 1 || !/^[0-9a-f]{7,64}$/i.test(event.commitSha)) {
    return reject(db, event, null, "invalid_merge_identity", now());
  }
  const existingAttempt = db.select().from(fixAttempts).where(and(
    eq(fixAttempts.repository, event.repository), eq(fixAttempts.prNumber, event.pr), eq(fixAttempts.commitSha, event.commitSha),
  )).get();
  if (existingAttempt) return { ok: true, duplicate: true, caseId: existingAttempt.caseId, attemptId: existingAttempt.id };

  let metadata: PullRequestMetadata;
  try { metadata = await getMetadata(); } catch {
    return reject(db, event, null, "pull_request_metadata_unavailable", now());
  }
  if (metadata.repository !== event.repository || metadata.number !== event.pr || !metadata.merged ||
      metadata.mergeCommitSha !== event.commitSha || metadata.baseBranch !== options.defaultBranch || !metadata.mergedAt) {
    return reject(db, event, null, "webhook_metadata_mismatch", now());
  }

  const refs = parsePrAssociations(`${metadata.title ?? ""}\n${metadata.body}`, options.linearTeamKey);
  const candidates = new Set<string>();
  for (const id of refs.caseIds) {
    if (isCaseId(id) && db.select({ id: cases.id }).from(cases).where(eq(cases.id, id)).get()) candidates.add(id);
  }
  for (const identifier of refs.linearIds) {
    const match = db.select({ caseId: externalLinks.caseId }).from(externalLinks).where(eq(externalLinks.linearIssueIdentifier, identifier)).get();
    if (match) candidates.add(match.caseId);
  }
  if (candidates.size !== 1) return reject(db, event, null, candidates.size === 0 ? "no_case_association" : "conflicting_case_association", now());
  const caseId = [...candidates][0]!;
  const mergedAt = Date.parse(metadata.mergedAt);
  if (!Number.isFinite(mergedAt)) return reject(db, event, caseId, "invalid_merged_timestamp", now());
  const previous = db.select({ mergedAt: fixAttempts.mergedAt }).from(fixAttempts).where(eq(fixAttempts.caseId, caseId)).orderBy(desc(fixAttempts.mergedAt)).get();
  if (previous && mergedAt <= previous.mergedAt) return reject(db, event, caseId, "merge_not_newer_than_previous_attempt", now());

  const attemptId = randomUUID();
  const eventKey = `merge:${caseId}:${event.repository}:${event.pr}:${event.commitSha}`;
  const outcome = runGuarded(db, (tx) => {
    tx.insert(fixAttempts).values({ id: attemptId, caseId, repository: event.repository, prNumber: event.pr, commitSha: event.commitSha, mergedAt, createdAt: now() }).run();
    tx.update(externalLinks).set({
      currentAttemptId: attemptId,
      githubRepository: event.repository,
      githubPrNumber: event.pr,
      githubPrUrl: metadata.htmlUrl,
      githubCommitSha: event.commitSha,
      updatedAt: now(),
    }).where(eq(externalLinks.caseId, caseId)).run();
    applyEventOrThrow(tx, { type: "fix_merged", case_id: caseId, attempt_id: attemptId, commit_sha: event.commitSha, event_key: eventKey }, now());
    applyEventOrThrow(tx, { type: "await_deployment", case_id: caseId, attempt_id: attemptId, event_key: `await-deployment:${attemptId}` }, now());
    const source = tx.select({ trigger: cases.sourceTriggerId, channel: cases.sourceChannelId }).from(cases).where(eq(cases.id, caseId)).get()!;
    ensureEffect(tx, {
      key: effectKeys.slackFixMerged(attemptId),
      type: "slack.reply",
      caseId,
      attemptId,
      destination: { channel_id: source.channel, root_effect_key: effectKeys.slackCaseCreated(source.trigger) },
      payload: { case_id: caseId, pr_number: event.pr, commit_sha: event.commitSha, message: "Fix merged; waiting for deployment." },
    }, now());
    const response = { case_id: caseId, attempt_id: attemptId };
    tx.insert(inboundEvents).values({
      eventKey,
      eventType: "github_merge",
      payloadHash: sha256Hash(event),
      caseId,
      attemptId,
      responseJson: JSON.stringify(response),
      receivedAt: now(),
    }).run();
    return response;
  });
  return outcome.ok
    ? { ok: true, duplicate: false, caseId, attemptId }
    : { ok: false, reason: outcome.rejection.reason };
}

function reject(db: Db, event: MergeEvent, caseId: string | null, reason: string, now: number): MergeAcceptance {
  recordRejectedEvent(db, {
    caseId,
    eventType: "github_merge",
    eventKey: event.deliveryId || null,
    fromStatus: caseId ? (db.select({ status: cases.status }).from(cases).where(eq(cases.id, caseId)).get()?.status as CaseStatus ?? null) : null,
    reason,
    payload: { repository: event.repository, pr: event.pr, commit_sha: event.commitSha },
  }, now);
  return { ok: false, reason };
}
