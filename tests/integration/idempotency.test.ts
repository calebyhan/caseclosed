import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { inTransaction, type Db } from "../../src/server/db/client";
import { externalLinks, jobs, sideEffects } from "../../src/server/db/schema";
import { recoverInterruptedJobs } from "../../src/server/jobs/recovery";
import { deliverEffect } from "../../src/server/side-effects/deliver";
import { EffectConflictError, ensureEffect, loadEffect, type NewEffect } from "../../src/server/side-effects/ledger";
import { createTestDatabase, type TestDatabase } from "../helpers/database";
import { ClientIdAdapter, FakeRemoteStore, MarkerSearchAdapter } from "../helpers/fake-remote";
import { intake, rowCount } from "../helpers/lifecycle";

let testDb: TestDatabase;
let store: FakeRemoteStore;
beforeEach(() => {
  testDb = createTestDatabase();
  store = new FakeRemoteStore(path.join(testDb.dir, "remote.json"));
});
afterEach(() => {
  testDb.cleanup();
});

function linearCreate(caseId: string | null = null): NewEffect {
  return {
    key: "linear:create:CC-0042",
    type: "linear.create_issue",
    caseId,
    destination: { team: "ENG" },
    payload: { title: "Annual upgrade spins forever" },
  };
}

const ensure = (db: Db, effect: NewEffect) => inTransaction(db, (tx) => ensureEffect(tx, effect));

describe("side-effect ledger", () => {
  it("accepts stable keys such as linear:create, slack:reproduced and github:verify", () => {
    const { db } = testDb.handle;
    for (const key of ["linear:create:CC-0042", "slack:reproduced:CC-0042", "github:verify:CC-0042:pr-84"]) {
      ensure(db, { key, type: "test.op", destination: {}, payload: {} });
      assert.equal(loadEffect(db, key)?.status, "pending");
      assert.equal(db.select().from(jobs).where(eq(jobs.idempotencyKey, `effect:${key}`)).all().length, 1);
    }
    assert.throws(() => ensure(db, { key: "not a key", type: "test.op", destination: {}, payload: {} }), /Invalid side-effect/);
  });

  it("collapses duplicate intents into one row and one delivery job", () => {
    const { db } = testDb.handle;
    const first = ensure(db, linearCreate());
    const second = ensure(db, linearCreate());
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.jobId, first.jobId);
    assert.equal(rowCount(db, sideEffects), 1);
    assert.equal(rowCount(db, jobs), 1);
  });

  it("treats the same key with a different frozen payload as a conflict", () => {
    const { db } = testDb.handle;
    ensure(db, linearCreate());
    const identity = loadEffect(db, "linear:create:CC-0042")!.providerIdentity;
    assert.throws(() => ensure(db, { ...linearCreate(), payload: { title: "changed" } }), EffectConflictError);
    assert.equal(loadEffect(db, "linear:create:CC-0042")!.providerIdentity, identity);
  });

  it("dedupes a duplicate Slack slash command down to one root-message effect (Eval 6 shape)", () => {
    const { db } = testDb.handle;
    intake(db, { triggerId: "trig-dup" });
    intake(db, { triggerId: "trig-dup" });
    assert.equal(db.select().from(sideEffects).where(eq(sideEffects.key, "slack:case-created:trig-dup")).all().length, 1);
  });
});

describe("delivery", () => {
  it("sends once and returns the stored result on repeat delivery", async () => {
    const { db } = testDb.handle;
    ensure(db, linearCreate());
    const adapter = new ClientIdAdapter(store);
    const first = await deliverEffect(db, "linear:create:CC-0042", adapter);
    const second = await deliverEffect(db, "linear:create:CC-0042", adapter);
    assert.equal(first.status, "completed");
    assert.equal(first.dispatched, true);
    assert.deepEqual(second, { status: "completed", externalId: first.externalId, dispatched: false });
    assert.equal(adapter.sendCalls, 1);
    assert.equal(store.all().length, 1);
  });

  it("reconciles a committed create whose response was lost, across a restart (Eval 7 shape)", async () => {
    ensure(testDb.handle.db, linearCreate());
    const identity = loadEffect(testDb.handle.db, "linear:create:CC-0042")!.providerIdentity;

    const lossy = new ClientIdAdapter(store, { dropResponseOnce: true });
    const interrupted = await deliverEffect(testDb.handle.db, "linear:create:CC-0042", lossy);
    assert.equal(interrupted.status, "unknown");
    assert.equal(store.all().length, 1, "the remote write committed");

    const { db } = testDb.reopen();
    const fresh = new ClientIdAdapter(new FakeRemoteStore(path.join(testDb.dir, "remote.json")));
    const recovered = await deliverEffect(db, "linear:create:CC-0042", fresh);
    assert.deepEqual(recovered, { status: "completed", externalId: identity, dispatched: false });
    assert.equal(fresh.sendCalls, 0, "no second create after an uncertain outcome");
    assert.equal(store.all().length, 1);
    assert.equal(loadEffect(db, "linear:create:CC-0042")!.attemptCount, 1);
  });

  it("marks an in-flight send unknown on restart and never blindly resends without provider identity", async () => {
    const { db: firstDb } = testDb.handle;
    ensure(firstDb, { key: "slack:repro-result:run-1", type: "slack.reply", destination: { channel: "C1" }, payload: { text: "Reproduced" } });
    firstDb.update(sideEffects).set({ status: "sending" }).where(eq(sideEffects.key, "slack:repro-result:run-1")).run();

    const { db } = testDb.reopen();
    assert.deepEqual(recoverInterruptedJobs(db).unknownEffects, ["slack:repro-result:run-1"]);

    const slack = new MarkerSearchAdapter(store);
    const stillUnknown = await deliverEffect(db, "slack:repro-result:run-1", slack);
    assert.equal(stillUnknown.status, "unknown");
    assert.equal(slack.sendCalls, 0);
    assert.equal(store.all().length, 0);

    store.create({ id: "1700000000.0001", marker: "slack:repro-result:run-1", payload: {} });
    const found = await deliverEffect(db, "slack:repro-result:run-1", slack);
    assert.deepEqual(found, { status: "completed", externalId: "1700000000.0001", dispatched: false });
    assert.equal(slack.sendCalls, 0);
  });

  it("retries confirmed non-committing rejections only when retryable", async () => {
    const { db } = testDb.handle;
    ensure(db, linearCreate());
    const transient = await deliverEffect(db, "linear:create:CC-0042", new ClientIdAdapter(store, { rejectWith: { retryable: true, error: "429" } }));
    assert.equal(transient.status, "pending");

    const permanent = await deliverEffect(db, "linear:create:CC-0042", new ClientIdAdapter(store, { rejectWith: { retryable: false, error: "401 invalid token" } }));
    assert.equal(permanent.status, "failed");
    const adapter = new ClientIdAdapter(store);
    assert.equal((await deliverEffect(db, "linear:create:CC-0042", adapter)).status, "failed");
    assert.equal(adapter.sendCalls, 0, "a failed effect needs an explicit retry cycle");
    assert.equal(loadEffect(db, "linear:create:CC-0042")!.lastError, "401 invalid token");
  });

  it("commits dependent canonical changes atomically with completion", async () => {
    const { db } = testDb.handle;
    const { caseId } = intake(db);
    ensure(db, { ...linearCreate(caseId), key: `linear:create:${caseId}` });
    await deliverEffect(db, `linear:create:${caseId}`, new ClientIdAdapter(store), {
      onCompleted: (tx, effect, externalId) => {
        tx.update(externalLinks).set({ linearIssueId: externalId }).where(eq(externalLinks.caseId, effect.caseId!)).run();
      },
    });
    const links = db.select().from(externalLinks).where(eq(externalLinks.caseId, caseId)).get()!;
    assert.equal(links.linearIssueId, loadEffect(db, `linear:create:${caseId}`)!.externalId);
  });

  it("reconciles an external success when dependent local persistence fails", async () => {
    const { db } = testDb.handle;
    ensure(db, linearCreate());
    const first = new ClientIdAdapter(store);
    await assert.rejects(
      deliverEffect(db, "linear:create:CC-0042", first, {
        onCompleted: () => { throw new Error("local projection write failed"); },
      }),
      /local projection write failed/,
    );
    assert.equal(store.all().length, 1, "the remote write committed before local persistence failed");
    assert.equal(loadEffect(db, "linear:create:CC-0042")!.status, "sending");

    const retry = new ClientIdAdapter(store);
    const recovered = await deliverEffect(db, "linear:create:CC-0042", retry);
    assert.equal(recovered.status, "completed");
    assert.equal(retry.sendCalls, 0, "recovery reconciles the provider identity instead of creating twice");
    assert.equal(store.all().length, 1);
  });
});
