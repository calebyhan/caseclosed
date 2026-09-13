import { eq } from "drizzle-orm";
import { effectKeys } from "../../domain/identity";
import type { Db, Tx } from "../db/client";
import { applyEventOrThrow } from "../db/repositories";
import { cases, externalLinks, sideEffects } from "../db/schema";
import type { ClaimedJob } from "../jobs/queue";
import type { EffectAdapter } from "../side-effects/deliver";
import { deliverEffect } from "../side-effects/deliver";
import type { FrozenEffect } from "../side-effects/ledger";
import { ensureEffect } from "../side-effects/ledger";

export type AdapterRegistry = { forType(type: string): EffectAdapter | null };

export async function handleDeliverEffectJob(
  job: ClaimedJob,
  db: Db,
  adapters: AdapterRegistry,
  now: () => number = Date.now,
): Promise<void> {
  if (job.type !== "deliver_effect" || !job.effectKey) throw new Error(`Job ${job.id} is not an effect delivery job`);
  const effect = db.select().from(sideEffects).where(eq(sideEffects.key, job.effectKey)).get();
  if (!effect) throw new Error(`Unknown effect ${job.effectKey}`);
  const adapter = adapters.forType(effect.type);
  if (!adapter) throw new Error(`No configured adapter for ${effect.type}`);

  let last = await deliverEffect(db, job.effectKey, adapter, {
    now,
    onCompleted: (tx, frozen, _externalId, result) => completeProjection(tx, frozen, result, now()),
  });
  for (const delay of [500, 1500]) {
    if (last.status !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    last = await deliverEffect(db, job.effectKey, adapter, {
      now,
      onCompleted: (tx, frozen, _externalId, result) => completeProjection(tx, frozen, result, now()),
    });
  }
  if (last.status !== "completed") throw new Error(`Effect ${job.effectKey} remains ${last.status}`);
}

function completeProjection(tx: Tx, effect: FrozenEffect, result: unknown, now: number): void {
  if (!effect.caseId) return;
  if (effect.type === "slack.post_case_root") {
    const value = result as { ts?: string; channel?: string };
    if (!value.ts) throw new Error("Slack root result is missing ts");
    tx.update(externalLinks)
      .set({ slackRootTs: value.ts, slackChannelId: value.channel ?? String(effect.destination.channel_id), updatedAt: now })
      .where(eq(externalLinks.caseId, effect.caseId)).run();
    tx.update(cases).set({ sourceThreadTs: value.ts, updatedAt: now }).where(eq(cases.id, effect.caseId)).run();
    return;
  }
  if (effect.type !== "linear.create_issue") return;
  const value = result as { id?: string; identifier?: string; url?: string };
  if (!value.id || !value.identifier) throw new Error("Linear issue result is missing id/identifier");
  tx.update(externalLinks)
    .set({ linearIssueId: value.id, linearIssueIdentifier: value.identifier, linearIssueUrl: value.url ?? null, updatedAt: now })
    .where(eq(externalLinks.caseId, effect.caseId)).run();
  applyEventOrThrow(tx, {
    type: "issue_confirmed",
    case_id: effect.caseId,
    linear_issue_id: value.id,
    event_key: `issue-confirmed:${effect.caseId}`,
  }, now);
  applyEventOrThrow(tx, { type: "await_fix", case_id: effect.caseId, event_key: `await-fix:issue:${effect.caseId}` }, now);
  const links = tx.select().from(externalLinks).where(eq(externalLinks.caseId, effect.caseId)).get()!;
  const source = tx.select({ trigger: cases.sourceTriggerId }).from(cases).where(eq(cases.id, effect.caseId)).get()!;
  ensureEffect(tx, {
    key: effectKeys.slackLinearLink(effect.caseId),
    type: "slack.reply",
    caseId: effect.caseId,
    destination: { channel_id: links.slackChannelId, root_effect_key: effectKeys.slackCaseCreated(source.trigger) },
    payload: { case_id: effect.caseId, linear_identifier: value.identifier, linear_url: value.url ?? null },
  }, now);
}
