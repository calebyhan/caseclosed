import { and, eq, inArray } from "drizzle-orm";
import type { SideEffectStatus } from "../../contracts/lifecycle";
import { inTransaction, type Db, type Tx } from "../db/client";
import { sideEffects } from "../db/schema";
import { loadEffect, type FrozenEffect } from "./ledger";

export type Reconciliation =
  | { kind: "found"; externalId: string; result: unknown }
  /** Provider-enforced identity makes a resend safe, or no send ever began. */
  | { kind: "safe_to_send" }
  | { kind: "unknown"; reason: string };

export type SendResult =
  | { kind: "committed"; externalId: string; result: unknown }
  /** The provider confirmed nothing was written. */
  | { kind: "rejected"; retryable: boolean; error: string };

/**
 * Provider adapter for one effect type. `send` throwing (timeout, dropped
 * response, ambiguous 5xx) means the outcome is uncertain.
 */
export interface EffectAdapter {
  reconcile(effect: FrozenEffect): Promise<Reconciliation>;
  send(effect: FrozenEffect): Promise<SendResult>;
}

export type DeliveryOutcome = {
  status: SideEffectStatus;
  externalId: string | null;
  /** Whether this call dispatched a network write. */
  dispatched: boolean;
};

export type DeliveryOptions = {
  now?: () => number;
  /** Dependent canonical changes, committed atomically with completion. */
  onCompleted?: (tx: Tx, effect: FrozenEffect, externalId: string, result: unknown) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Intent-first delivery (IMPLEMENTATION_PLAN §3.7). Completed effects return
 * the stored result; uncertain effects reconcile before any resend; an
 * unknown outcome never authorizes a blind second create.
 */
export async function deliverEffect(
  db: Db,
  key: string,
  adapter: EffectAdapter,
  options: DeliveryOptions = {},
): Promise<DeliveryOutcome> {
  const now = options.now ?? Date.now;
  const effect = loadEffect(db, key);
  if (!effect) throw new Error(`Unknown side effect ${key}`);

  if (effect.status === "completed" || effect.status === "failed") {
    return { status: effect.status, externalId: effect.externalId, dispatched: false };
  }

  let status: SideEffectStatus = effect.status;
  if (status === "sending") {
    // A send was in flight when the previous process stopped.
    transitionEffect(db, key, ["sending"], { status: "unknown", lastError: "send outcome lost before completion" }, now());
    status = "unknown";
  }

  if (status === "unknown") {
    let reconciliation: Reconciliation;
    try {
      reconciliation = await adapter.reconcile(effect);
    } catch (error) {
      reconciliation = { kind: "unknown", reason: `reconciliation failed: ${errorMessage(error)}` };
    }
    if (reconciliation.kind === "found") {
      return completeEffect(db, effect, ["unknown"], reconciliation.externalId, reconciliation.result, options, now());
    }
    if (reconciliation.kind === "unknown") {
      transitionEffect(db, key, ["unknown"], { lastError: reconciliation.reason }, now());
      return { status: "unknown", externalId: null, dispatched: false };
    }
  }

  const sendStartedAt = now();
  const claimed = inTransaction(db, (tx) =>
    tx
      .update(sideEffects)
      .set({
        status: "sending",
        attemptCount: effect.attemptCount + 1,
        sentAt: sendStartedAt,
        updatedAt: sendStartedAt,
      })
      .where(and(eq(sideEffects.key, key), inArray(sideEffects.status, ["pending", "unknown"])))
      .run(),
  );
  if (claimed.changes !== 1) {
    const current = loadEffect(db, key)!;
    return { status: current.status, externalId: current.externalId, dispatched: false };
  }

  let sent: SendResult;
  try {
    sent = await adapter.send(effect);
  } catch (error) {
    transitionEffect(db, key, ["sending"], { status: "unknown", lastError: errorMessage(error) }, now());
    return { status: "unknown", externalId: null, dispatched: true };
  }

  if (sent.kind === "committed") {
    const outcome = completeEffect(db, effect, ["sending"], sent.externalId, sent.result, options, now());
    return { ...outcome, dispatched: true };
  }
  const nextStatus: SideEffectStatus = sent.retryable ? "pending" : "failed";
  transitionEffect(db, key, ["sending"], { status: nextStatus, lastError: sent.error }, now());
  return { status: nextStatus, externalId: null, dispatched: true };
}

function transitionEffect(
  db: Db,
  key: string,
  from: SideEffectStatus[],
  change: { status?: SideEffectStatus; lastError?: string | null },
  at: number,
): boolean {
  const result = inTransaction(db, (tx) =>
    tx
      .update(sideEffects)
      .set({ ...change, updatedAt: at })
      .where(and(eq(sideEffects.key, key), inArray(sideEffects.status, from)))
      .run(),
  );
  return result.changes === 1;
}

function completeEffect(
  db: Db,
  effect: FrozenEffect,
  from: SideEffectStatus[],
  externalId: string,
  result: unknown,
  options: DeliveryOptions,
  at: number,
): DeliveryOutcome {
  return inTransaction(db, (tx) => {
    const updated = tx
      .update(sideEffects)
      .set({
        status: "completed",
        externalId,
        resultJson: JSON.stringify(result ?? null),
        lastError: null,
        completedAt: at,
        updatedAt: at,
      })
      .where(and(eq(sideEffects.key, effect.key), inArray(sideEffects.status, from)))
      .run();
    if (updated.changes === 1) {
      options.onCompleted?.(tx, effect, externalId, result);
      return { status: "completed" as const, externalId, dispatched: false };
    }
    const current = tx
      .select({ status: sideEffects.status, externalId: sideEffects.externalId })
      .from(sideEffects)
      .where(eq(sideEffects.key, effect.key))
      .get()!;
    return { status: current.status as SideEffectStatus, externalId: current.externalId, dispatched: false };
  });
}
