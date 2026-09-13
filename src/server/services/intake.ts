import { and, eq } from "drizzle-orm";
import { effectKeys, formatCaseId, jobKeys, sha256Hash } from "../../domain/identity";
import { inTransaction, type Db } from "../db/client";
import { appMeta, cases, externalLinks, inboundEvents, transitions } from "../db/schema";
import { enqueueUnique } from "../jobs/queue";
import { ensureEffect } from "../side-effects/ledger";

export class IntakeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeValidationError";
  }
}

/** An already-authenticated slash-command invocation. Signature checks happen at the route. */
export type CaseIntake = {
  source: { type: "slack"; teamId: string; channelId: string; userId: string; triggerId: string };
  report: string;
  environmentId: string;
};

export type IntakeResult = { caseId: string; created: boolean };

/**
 * Intake atomic unit: accepted event + case + generation job + Slack root
 * effect and its delivery job. Acknowledge only after this returns.
 * A retried invocation (same team + trigger) returns the existing case.
 */
export function createCaseFromReport(db: Db, input: CaseIntake, now: number = Date.now()): IntakeResult {
  const report = input.report.trim();
  const { teamId, channelId, userId, triggerId } = input.source;
  if (!report) throw new IntakeValidationError("Bug report text must not be empty.");
  for (const [field, value] of Object.entries({ teamId, channelId, userId, triggerId, environmentId: input.environmentId })) {
    if (!value.trim()) throw new IntakeValidationError(`${field} must not be empty.`);
  }

  return inTransaction(db, (tx) => {
    const existing = tx
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.sourceTeamId, teamId), eq(cases.sourceTriggerId, triggerId)))
      .get();
    if (existing) return { caseId: existing.id, created: false };

    const meta = tx.select().from(appMeta).where(eq(appMeta.id, 1)).get();
    if (!meta) throw new Error("Database is not initialized (app_meta missing). Run `npm run db:migrate`.");
    const caseId = formatCaseId(meta.nextCaseNumber);
    tx.update(appMeta)
      .set({ nextCaseNumber: meta.nextCaseNumber + 1 })
      .where(and(eq(appMeta.id, 1), eq(appMeta.nextCaseNumber, meta.nextCaseNumber)))
      .run();

    tx.insert(cases)
      .values({
        id: caseId,
        caseNumber: meta.nextCaseNumber,
        status: "RECEIVED",
        report,
        environmentId: input.environmentId,
        sourceType: input.source.type,
        sourceTeamId: teamId,
        sourceChannelId: channelId,
        sourceUserId: userId,
        sourceTriggerId: triggerId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // Case creation is the lifecycle origin, not a transition between statuses.
    tx.insert(transitions)
      .values({
        caseId,
        fromStatus: null,
        toStatus: "RECEIVED",
        eventType: "case_received",
        eventKey: `intake:${teamId}:${triggerId}`,
        trigger: "slash command accepted",
        createdAt: now,
      })
      .run();
    tx.insert(externalLinks).values({ caseId, slackChannelId: channelId, updatedAt: now }).run();

    ensureEffect(
      tx,
      {
        key: effectKeys.slackCaseCreated(triggerId),
        type: "slack.post_case_root",
        caseId,
        destination: { team_id: teamId, channel_id: channelId },
        payload: { case_id: caseId, reporter_user_id: userId },
      },
      now,
    );
    // Reserve the root delivery before slower model/browser work so the case
    // thread appears promptly and every later reply has a canonical parent.
    const specJob = enqueueUnique(
      tx,
      {
        key: jobKeys.spec(caseId),
        type: "generate_spec",
        caseId,
        payload: { case_id: caseId, report, environment_id: input.environmentId },
      },
      now,
    );
    tx.insert(inboundEvents)
      .values({
        eventKey: `slack-command:${teamId}:${triggerId}`,
        eventType: "slack_command",
        payloadHash: sha256Hash({ report, source: input.source, environment_id: input.environmentId }),
        caseId,
        jobId: specJob.jobId,
        responseJson: JSON.stringify({ case_id: caseId }),
        receivedAt: now,
      })
      .run();

    return { caseId, created: true };
  });
}
