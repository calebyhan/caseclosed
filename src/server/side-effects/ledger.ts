import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { SideEffectStatus } from "../../contracts/lifecycle";
import { assertValidEffectKey, jobKeys, sha256Hash } from "../../domain/identity";
import type { Executor, Tx } from "../db/client";
import { sideEffects } from "../db/schema";
import { enqueueUnique } from "../jobs/queue";

export class EffectConflictError extends Error {
  constructor(key: string) {
    super(`Side effect ${key} already exists with a different frozen request`);
    this.name = "EffectConflictError";
  }
}

export type NewEffect = {
  /** Stable identity, e.g. `linear:create:CC-0042`. Never derived from case status. */
  key: string;
  /** Adapter operation, e.g. `linear.create_issue`. */
  type: string;
  caseId?: string | null;
  runId?: string | null;
  attemptId?: string | null;
  destination: Record<string, unknown>;
  payload: Record<string, unknown>;
};

export type FrozenEffect = {
  key: string;
  type: string;
  caseId: string | null;
  runId: string | null;
  attemptId: string | null;
  destination: Record<string, unknown>;
  payload: Record<string, unknown>;
  payloadHash: string;
  providerIdentity: string;
};

export type StoredEffect = FrozenEffect & {
  status: SideEffectStatus;
  externalId: string | null;
  result: unknown;
  attemptCount: number;
  lastError: string | null;
};

/**
 * Persists the intent for one logical external write, plus its delivery job,
 * inside the caller's atomic unit. The provider identity is allocated once
 * here and reused by every later delivery or reconciliation attempt.
 */
export function ensureEffect(
  tx: Tx,
  effect: NewEffect,
  now: number = Date.now(),
): { key: string; created: boolean; jobId: string } {
  assertValidEffectKey(effect.key);
  const payloadHash = sha256Hash({ type: effect.type, destination: effect.destination, payload: effect.payload });
  const existing = tx
    .select({ payloadHash: sideEffects.payloadHash })
    .from(sideEffects)
    .where(eq(sideEffects.key, effect.key))
    .get();
  if (existing && existing.payloadHash !== payloadHash) throw new EffectConflictError(effect.key);

  if (!existing) {
    tx.insert(sideEffects)
      .values({
        key: effect.key,
        type: effect.type,
        caseId: effect.caseId ?? null,
        runId: effect.runId ?? null,
        attemptId: effect.attemptId ?? null,
        status: "pending",
        destinationJson: JSON.stringify(effect.destination),
        payloadJson: JSON.stringify(effect.payload),
        payloadHash,
        providerIdentity: randomUUID(),
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  const { jobId } = enqueueUnique(
    tx,
    {
      key: jobKeys.effect(effect.key),
      type: "deliver_effect",
      caseId: effect.caseId ?? null,
      attemptId: effect.attemptId ?? null,
      effectKey: effect.key,
      payload: { effect_key: effect.key },
    },
    now,
  );
  return { key: effect.key, created: !existing, jobId };
}

export function loadEffect(ex: Executor, key: string): StoredEffect | null {
  const row = ex.select().from(sideEffects).where(eq(sideEffects.key, key)).get();
  if (!row) return null;
  return {
    key: row.key,
    type: row.type,
    caseId: row.caseId,
    runId: row.runId,
    attemptId: row.attemptId,
    destination: JSON.parse(row.destinationJson) as Record<string, unknown>,
    payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
    payloadHash: row.payloadHash,
    providerIdentity: row.providerIdentity,
    status: row.status as SideEffectStatus,
    externalId: row.externalId,
    result: row.resultJson === null ? null : JSON.parse(row.resultJson),
    attemptCount: row.attemptCount,
    lastError: row.lastError,
  };
}
