import fs from "node:fs";
import type { EffectAdapter, Reconciliation, SendResult } from "../../src/server/side-effects/deliver";
import type { FrozenEffect } from "../../src/server/side-effects/ledger";

// Fake provider state persisted to a file so it survives client/worker
// reconstruction, as a real remote service would. It models objects and
// identity lookup; it does not dedupe on behalf of the application.

type RemoteObject = { id: string; marker: string; payload: unknown };

export class FakeRemoteStore {
  constructor(private readonly file: string) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, "[]");
  }

  all(): RemoteObject[] {
    return JSON.parse(fs.readFileSync(this.file, "utf8")) as RemoteObject[];
  }

  create(object: RemoteObject): void {
    fs.writeFileSync(this.file, JSON.stringify([...this.all(), object]));
  }
}

type AdapterOptions = {
  /** Commit the remote write, then throw as if the response was lost. */
  dropResponseOnce?: boolean;
  rejectWith?: { retryable: boolean; error: string };
};

/** Linear-like: the client supplies the object ID, so lookup by identity is authoritative. */
export class ClientIdAdapter implements EffectAdapter {
  sendCalls = 0;
  reconcileCalls = 0;
  private dropNext: boolean;

  constructor(
    private readonly store: FakeRemoteStore,
    private readonly options: AdapterOptions = {},
  ) {
    this.dropNext = options.dropResponseOnce ?? false;
  }

  async send(effect: FrozenEffect): Promise<SendResult> {
    this.sendCalls += 1;
    if (this.options.rejectWith) return { kind: "rejected", ...this.options.rejectWith };
    if (this.store.all().some((object) => object.id === effect.providerIdentity)) {
      return { kind: "rejected", retryable: false, error: "duplicate id" };
    }
    this.store.create({ id: effect.providerIdentity, marker: effect.key, payload: effect.payload });
    if (this.dropNext) {
      this.dropNext = false;
      throw new Error("socket hang up: response lost after commit");
    }
    return { kind: "committed", externalId: effect.providerIdentity, result: { id: effect.providerIdentity } };
  }

  async reconcile(effect: FrozenEffect): Promise<Reconciliation> {
    this.reconcileCalls += 1;
    const found = this.store.all().find((object) => object.id === effect.providerIdentity);
    return found ? { kind: "found", externalId: found.id, result: { id: found.id } } : { kind: "safe_to_send" };
  }
}

/** Slack/GitHub-like: server-assigned IDs; only a marker search is possible, and absence proves nothing. */
export class MarkerSearchAdapter implements EffectAdapter {
  sendCalls = 0;
  private nextId = 1;

  constructor(private readonly store: FakeRemoteStore) {}

  async send(effect: FrozenEffect): Promise<SendResult> {
    this.sendCalls += 1;
    const id = `msg-${Date.now()}-${this.nextId++}`;
    this.store.create({ id, marker: effect.key, payload: effect.payload });
    return { kind: "committed", externalId: id, result: { ts: id } };
  }

  async reconcile(effect: FrozenEffect): Promise<Reconciliation> {
    const found = this.store.all().find((object) => object.marker === effect.key);
    return found
      ? { kind: "found", externalId: found.id, result: { ts: found.id } }
      : { kind: "unknown", reason: "marker not found; absence is not proof that no write committed" };
  }
}
