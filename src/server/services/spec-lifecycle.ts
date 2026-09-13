import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { SpecFailureKind } from "../../contracts/lifecycle";
import { AppContext, ReproSpec } from "../../contracts/repro";
import { canonicalJson, effectKeys, jobKeys, sha256Hash } from "../../domain/identity";
import type { Db } from "../db/client";
import { applyEventOrThrow, runGuarded, TransitionRejectedError, type GuardedOutcome } from "../db/repositories";
import { cases, externalLinks, jobs, reproSpecs } from "../db/schema";
import { enqueueUnique } from "../jobs/queue";
import { ensureEffect } from "../side-effects/ledger";

export class SpecIdentityError extends Error {
  constructor(public readonly issues: string[]) {
    super(`ReproSpec rejected: ${issues.join("; ")}`);
    this.name = "SpecIdentityError";
  }
}

export type RecordSpecInput = {
  caseId: string;
  spec: unknown;
  appContext: unknown;
  modelId?: string | null;
  generationModelCalls?: number;
  generationSchema?: unknown;
};

/**
 * Spec-success atomic unit: immutable spec + SPEC_CREATED + unique
 * reproduction job. Checks schema and application-owned identity only; full
 * semantic validation (validateReproSpec) lands with the verdict engine.
 */
export function recordSpecCreated(
  db: Db,
  input: RecordSpecInput,
  now: number = Date.now(),
): GuardedOutcome<{ specId: string; reproduceJobId: string }> {
  const spec = ReproSpec.safeParse(input.spec);
  const appContext = AppContext.safeParse(input.appContext);
  const issues: string[] = [];
  if (!spec.success) issues.push(...spec.error.issues.map((issue) => `spec.${issue.path.join(".")}: ${issue.message}`));
  if (!appContext.success) {
    issues.push(...appContext.error.issues.map((issue) => `app_context.${issue.path.join(".")}: ${issue.message}`));
  }
  if (!spec.success || !appContext.success) throw new SpecIdentityError(issues);

  const appContextHash = sha256Hash(appContext.data);
  if (spec.data.case_id !== input.caseId) issues.push(`case_id ${spec.data.case_id} does not match ${input.caseId}`);
  if (spec.data.app_context_hash !== appContextHash) issues.push("app_context_hash does not match the AppContext");
  if (spec.data.environment.id !== appContext.data.environment_id) issues.push("environment.id does not match the AppContext");
  if (issues.length > 0) throw new SpecIdentityError(issues);

  const specHash = sha256Hash(spec.data);
  return runGuarded(db, (tx) => {
    const caseRow = tx.select({ environmentId: cases.environmentId }).from(cases).where(eq(cases.id, input.caseId)).get();
    const event = { type: "spec_created" as const, case_id: input.caseId, event_key: `spec-created:${input.caseId}` };
    if (!caseRow) throw new TransitionRejectedError(event, null, "case_not_found");
    if (caseRow.environmentId !== spec.data.environment.id) {
      throw new SpecIdentityError([`environment ${spec.data.environment.id} does not match case environment ${caseRow.environmentId}`]);
    }

    const existing = tx
      .select({ id: reproSpecs.id, specHash: reproSpecs.specHash })
      .from(reproSpecs)
      .where(eq(reproSpecs.caseId, input.caseId))
      .get();
    if (existing) {
      if (existing.specHash !== specHash) throw new SpecIdentityError(["a different spec is already recorded; specs are immutable"]);
      const job = tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.idempotencyKey, jobKeys.reproduce(input.caseId))).get();
      if (!job) throw new Error(`Spec ${existing.id} exists without its reproduction job`);
      return { specId: existing.id, reproduceJobId: job.id };
    }

    const specId = randomUUID();
    tx.insert(reproSpecs)
      .values({
        id: specId,
        caseId: input.caseId,
        version: spec.data.version,
        specJson: canonicalJson(spec.data),
        specHash,
        appContextJson: canonicalJson(appContext.data),
        appContextHash,
        generationSchemaJson: input.generationSchema === undefined ? null : canonicalJson(input.generationSchema),
        modelId: input.modelId ?? null,
        generationModelCalls: input.generationModelCalls ?? 0,
        createdAt: now,
      })
      .run();
    applyEventOrThrow(tx, { ...event, spec_id: specId }, now);
    const { jobId } = enqueueUnique(
      tx,
      { key: jobKeys.reproduce(input.caseId), type: "reproduce", caseId: input.caseId, payload: { case_id: input.caseId, spec_id: specId } },
      now,
    );
    return { specId, reproduceJobId: jobId };
  });
}

export type RecordSpecFailureInput = { caseId: string; kind: SpecFailureKind; reasons: string[] };

/** RECEIVED → SPEC_FAILED with the reasons persisted and a Slack reply intent. No Linear issue. */
export function recordSpecFailed(db: Db, input: RecordSpecFailureInput, now: number = Date.now()): GuardedOutcome<{ effectKey: string }> {
  return runGuarded(db, (tx) => {
    tx.update(cases)
      .set({ specFailureKind: input.kind, specFailureReasonsJson: JSON.stringify(input.reasons), updatedAt: now })
      .where(eq(cases.id, input.caseId))
      .run();
    applyEventOrThrow(
      tx,
      { type: "spec_failed", case_id: input.caseId, kind: input.kind, event_key: `spec-failed:${input.caseId}` },
      now,
    );
    const links = tx
      .select({ channelId: externalLinks.slackChannelId })
      .from(externalLinks)
      .where(eq(externalLinks.caseId, input.caseId))
      .get();
    const key = effectKeys.slackSpecFailed(input.caseId);
    ensureEffect(
      tx,
      {
        key,
        type: "slack.reply",
        caseId: input.caseId,
        destination: { channel_id: links?.channelId ?? null, thread_root_effect: "slack:case-created" },
        payload: { case_id: input.caseId, kind: input.kind, reasons: input.reasons },
      },
      now,
    );
    return { effectKey: key };
  });
}
