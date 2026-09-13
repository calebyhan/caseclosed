import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { ReproSpec } from "../../src/contracts/repro";
import { inTransaction } from "../../src/server/db/client";
import { assertionResults, jobs, rejectedEvents, runs } from "../../src/server/db/schema";
import { claimNext, enqueueUnique, JobConflictError } from "../../src/server/jobs/queue";
import { recoverInterruptedJobs } from "../../src/server/jobs/recovery";
import { JobWorker } from "../../src/server/jobs/worker";
import { finalizeRun } from "../../src/server/services/runs";
import { acquireProcessLock, LockHeldError } from "../../src/shared/process-lock";
import { createTestDatabase, type TestDatabase } from "../helpers/database";
import { caseWithSpec, driveToWaitingForFix, goldenPlanFor, goldenSpecFor, intake, mergeDeployAndClaimVerification, rowCount, statusOf } from "../helpers/lifecycle";
import { buggyObservations } from "../helpers/observations";

let testDb: TestDatabase;
beforeEach(() => {
  testDb = createTestDatabase();
});
afterEach(() => {
  testDb.cleanup();
});

const jobRow = (id: string) => testDb.handle.db.select().from(jobs).where(eq(jobs.id, id)).get()!;

describe("durable queue", () => {
  it("survives a process restart with pending jobs intact", () => {
    const { caseId } = intake(testDb.handle.db, { report: "Upgrade spins forever" });
    const { db } = testDb.reopen();
    const job = claimNext(db, ["generate_spec"]);
    assert.ok(job);
    assert.equal(job.key, `spec:${caseId}`);
    assert.equal(job.payload.report, "Upgrade spins forever");
    assert.equal(job.attemptCount, 1);
  });

  it("claims FIFO, only for requested types, and never hands out the same job twice", () => {
    const { db } = testDb.handle;
    const first = intake(db).caseId;
    const second = intake(db).caseId;
    assert.equal(claimNext(db, ["generate_spec"])?.caseId, first);
    assert.equal(claimNext(db, ["generate_spec"])?.caseId, second);
    assert.equal(claimNext(db, ["generate_spec"]), null);
    assert.equal(claimNext(db, []), null);
    assert.equal(db.select().from(jobs).where(eq(jobs.type, "deliver_effect")).all().every((job) => job.status === "pending"), true);
  });

  it("returns the existing job for a duplicate key and refuses a different payload", () => {
    const { db } = testDb.handle;
    const job = { key: "spec:CC-0001-dup", type: "generate_spec" as const, payload: { report: "x" } };
    const a = inTransaction(db, (tx) => enqueueUnique(tx, job));
    const b = inTransaction(db, (tx) => enqueueUnique(tx, job));
    assert.equal(a.created, true);
    assert.deepEqual(b, { jobId: a.jobId, created: false });
    assert.throws(() => inTransaction(db, (tx) => enqueueUnique(tx, { ...job, payload: { report: "y" } })), JobConflictError);
    assert.equal(db.select().from(jobs).where(eq(jobs.idempotencyKey, job.key)).all().length, 1);
  });

  it("requeues an interrupted non-browser job after restart, keeping cumulative attempts", () => {
    intake(testDb.handle.db);
    const claimed = claimNext(testDb.handle.db, ["generate_spec"])!;
    const { db } = testDb.reopen();
    const report = recoverInterruptedJobs(db);
    assert.deepEqual(report.requeued, [claimed.id]);
    assert.equal(jobRow(claimed.id).status, "pending");
    assert.equal(claimNext(db, ["generate_spec"])!.attemptCount, 2);
  });

  it("does not resume generation whose model-call budget is exhausted", () => {
    intake(testDb.handle.db);
    const claimed = claimNext(testDb.handle.db, ["generate_spec"])!;
    testDb.handle.db.update(jobs).set({ modelCalls: 3 }).where(eq(jobs.id, claimed.id)).run();
    const { db } = testDb.reopen();
    recoverInterruptedJobs(db);
    assert.equal(jobRow(claimed.id).status, "failed");
    assert.equal(claimNext(db, ["generate_spec"]), null);
  });
});

describe("browser run identity", () => {
  it("assigns run_id once on claim and enters REPRODUCING atomically", () => {
    const { db } = testDb.handle;
    const { caseId, reproduceJobId } = caseWithSpec(db);
    const job = claimNext(db, ["reproduce"])!;
    assert.equal(job.id, reproduceJobId);
    assert.ok(job.runId);
    assert.equal(jobRow(job.id).runId, job.runId);
    assert.equal(db.select().from(runs).where(eq(runs.id, job.runId)).get()!.status, "running");
    assert.equal(statusOf(db, caseId), "REPRODUCING");
  });

  it("finalizes an interrupted run as INCONCLUSIVE/worker_interrupted under its existing ID and never reruns it", () => {
    const { caseId } = caseWithSpec(testDb.handle.db);
    const job = claimNext(testDb.handle.db, ["reproduce"])!;
    const { db } = testDb.reopen();

    const report = recoverInterruptedJobs(db);
    assert.deepEqual(report.interruptedRuns, [job.runId]);
    const run = db.select().from(runs).where(eq(runs.id, job.runId!)).get()!;
    assert.equal(run.result, "INCONCLUSIVE");
    assert.equal(run.infraErrorReason, "worker_interrupted");
    assert.equal(statusOf(db, caseId), "REPRO_INCONCLUSIVE");
    assert.equal(jobRow(job.id).status, "failed");
    assert.equal(
      testDb.handle.db.select().from(assertionResults).where(eq(assertionResults.runId, job.runId!)).all().length,
      4,
      "interrupted runs retain one explicit not-observed row per check",
    );
    assert.equal(claimNext(db, ["reproduce"]), null);
    assert.equal(rowCount(db, runs), 1);
  });

  it("finalizes an interrupted verification as VERIFICATION_INCONCLUSIVE", () => {
    const { caseId } = driveToWaitingForFix(testDb.handle.db);
    const { runId } = mergeDeployAndClaimVerification(testDb.handle.db, caseId, 84, "sha-a");
    const { db } = testDb.reopen();
    recoverInterruptedJobs(db);
    assert.equal(statusOf(db, caseId), "VERIFICATION_INCONCLUSIVE");
    assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()!.infraErrorReason, "worker_interrupted");
  });

  it("never replays a completed experiment, even if its job becomes pending again", () => {
    const { db } = testDb.handle;
    const { caseId } = caseWithSpec(db);
    const job = claimNext(db, ["reproduce"])!;
    assert.ok(finalizeRun(db, {
      runId: job.runId!,
      result: "REPRODUCED",
      observations: buggyObservations(ReproSpec.parse(goldenSpecFor(caseId))),
      plan: goldenPlanFor(caseId),
      job: { id: job.id, status: "completed" },
    }).ok);

    db.update(jobs).set({ status: "pending" }).where(eq(jobs.id, job.id)).run();
    assert.equal(claimNext(db, ["reproduce"]), null);
    assert.equal(jobRow(job.id).status, "completed");
    assert.equal(rowCount(db, runs), 1);
    assert.equal(statusOf(db, caseId), "REPRODUCED");
  });

  it("fails a browser job whose claim guard is rejected and audits why", () => {
    const { db } = testDb.handle;
    const { caseId } = intake(db);
    const { jobId } = inTransaction(db, (tx) =>
      enqueueUnique(tx, { key: `reproduce:${caseId}`, type: "reproduce", caseId, payload: { case_id: caseId } }),
    );
    assert.equal(claimNext(db, ["reproduce"]), null);
    assert.equal(jobRow(jobId).status, "failed");
    assert.match(jobRow(jobId).lastError!, /no_valid_spec/);
    assert.equal(db.select().from(rejectedEvents).where(eq(rejectedEvents.caseId, caseId)).get()!.reason, "no_valid_spec");
    assert.equal(rowCount(db, runs), 0);
    assert.equal(statusOf(db, caseId), "RECEIVED");
  });
});

describe("worker", () => {
  it("processes one job at a time and only claims handled types", async () => {
    const { db } = testDb.handle;
    intake(db);
    intake(db);
    let active = 0;
    let maxActive = 0;
    const worker = new JobWorker(db, {
      generate_spec: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
      },
    });
    const results = await Promise.all([worker.runOnce(), worker.runOnce(), worker.runOnce()]);
    assert.deepEqual(results, [true, true, false]);
    assert.equal(maxActive, 1);
    const all = db.select().from(jobs).all();
    assert.ok(all.filter((job) => job.type === "generate_spec").every((job) => job.status === "completed"));
    assert.ok(all.filter((job) => job.type === "deliver_effect").every((job) => job.status === "pending"));
  });

  it("records handler failures as failed jobs with the error", async () => {
    const { db } = testDb.handle;
    intake(db);
    const messages: string[] = [];
    const worker = new JobWorker(db, { generate_spec: async () => Promise.reject(new Error("provider unavailable")) }, { log: (m) => messages.push(m) });
    assert.equal(await worker.runOnce(), true);
    const failed = db.select().from(jobs).where(eq(jobs.type, "generate_spec")).get()!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError, "provider unavailable");
    assert.match(messages[0]!, /provider unavailable/);
  });

  it("drains the queue in its loop and stops cleanly", async () => {
    const { db } = testDb.handle;
    intake(db);
    const worker = new JobWorker(db, { generate_spec: async () => {} }, { pollIntervalMs: 10 });
    worker.start();
    for (let i = 0; i < 50 && db.select().from(jobs).where(eq(jobs.status, "completed")).all().length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await worker.stop();
    assert.equal(db.select().from(jobs).where(eq(jobs.type, "generate_spec")).get()!.status, "completed");
  });
});

describe("worker singleton lock", () => {
  it("refuses a second live owner and reclaims a dead owner's lock", () => {
    const lockDir = path.join(testDb.dir, "locks");
    const lock = acquireProcessLock(lockDir, "worker");
    assert.throws(() => acquireProcessLock(lockDir, "worker"), LockHeldError);

    const reclaimed = acquireProcessLock(lockDir, "worker", { isProcessAlive: () => false });
    assert.notEqual(reclaimed.owner.token, lock.owner.token);
    lock.release(); // Stale owner's release must not remove the new owner's lock.
    assert.throws(() => acquireProcessLock(lockDir, "worker"), LockHeldError);
    reclaimed.release();
    acquireProcessLock(lockDir, "worker").release();
  });
});
