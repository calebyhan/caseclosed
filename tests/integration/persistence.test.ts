import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { asc, eq } from "drizzle-orm";
import { inTransaction } from "../../src/server/db/client";
import { applyCaseEvent, applyEventOrThrow, runGuarded } from "../../src/server/db/repositories";
import { claimNext } from "../../src/server/jobs/queue";
import {
  appMeta,
  cases,
  fixAttempts,
  inboundEvents,
  jobs,
  rejectedEvents,
  reproSpecs,
  runs,
  sideEffects,
  transitions,
} from "../../src/server/db/schema";
import { ensureEffect, EffectConflictError } from "../../src/server/side-effects/ledger";
import { IntakeValidationError } from "../../src/server/services/intake";
import { finalizeRun } from "../../src/server/services/runs";
import { recordSpecCreated, recordSpecFailed, SpecIdentityError } from "../../src/server/services/spec-lifecycle";
import { createTestDatabase, type TestDatabase } from "../helpers/database";
import {
  addFixAttempt,
  caseWithSpec,
  driveToWaitingForFix,
  goldenSpecFor,
  intake,
  mergeDeployAndClaimVerification,
  rowCount,
  stagingAppContext,
  statusOf,
} from "../helpers/lifecycle";

let testDb: TestDatabase;
beforeEach(() => {
  testDb = createTestDatabase();
});
afterEach(() => {
  testDb.cleanup();
});

describe("migrations and connection", () => {
  it("creates the canonical schema with WAL and foreign keys on an empty database", () => {
    const { sqlite, db } = testDb.handle;
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'")
      .all()
      .map((row) => (row as { name: string }).name)
      .sort();
    assert.deepEqual(tables, [
      "app_meta",
      "assertion_results",
      "browser_actions",
      "cases",
      "evidence",
      "external_links",
      "fix_attempts",
      "inbound_events",
      "jobs",
      "rejected_events",
      "repro_specs",
      "resolved_plans",
      "runs",
      "side_effects",
      "transitions",
    ]);
    assert.equal(sqlite.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(sqlite.pragma("foreign_keys", { simple: true }), 1);
    const instanceId = db.select().from(appMeta).get()!.instanceId;
    testDb.reopen();
    assert.equal(testDb.handle.db.select().from(appMeta).get()!.instanceId, instanceId, "instance ID is stable across restarts");
  });

  it("enforces foreign keys, uniqueness, and run result consistency", () => {
    const { db } = testDb.handle;
    const { caseId, specId } = caseWithSpec(db);
    const other = intake(db).caseId;

    assert.throws(() =>
      db.insert(jobs).values({
        id: randomUUID(),
        idempotencyKey: "orphan",
        type: "generate_spec",
        status: "pending",
        caseId: "CC-9999",
        payloadJson: "{}",
        payloadHash: "x",
        createdAt: 1,
        updatedAt: 1,
      }).run(),
    );

    addFixAttempt(db, caseId, 84, "sha-a");
    assert.throws(() => addFixAttempt(db, other, 84, "sha-a"), /UNIQUE/, "a merged PR revision cannot bind to a second case");

    assert.throws(
      () =>
        db.insert(runs).values({
          id: randomUUID(),
          caseId,
          runType: "reproduction",
          status: "completed",
          result: "VERIFIED_FIXED",
          specId,
          createdAt: 1,
        }).run(),
      /CHECK/,
    );
    assert.throws(
      () => db.insert(runs).values({ id: randomUUID(), caseId, runType: "verification", status: "running", specId, createdAt: 1 }).run(),
      /CHECK/,
      "verification runs require a fix attempt",
    );
  });
});

describe("intake", () => {
  it("allocates sequential case IDs and dedupes the same trigger", () => {
    const { db } = testDb.handle;
    const first = intake(db, { triggerId: "trig-1" });
    const second = intake(db, { triggerId: "trig-2" });
    const retry = intake(db, { triggerId: "trig-1" });
    assert.deepEqual(first, { caseId: "CC-0001", created: true });
    assert.deepEqual(second, { caseId: "CC-0002", created: true });
    assert.deepEqual(retry, { caseId: "CC-0001", created: false });
    assert.equal(rowCount(db, cases), 2);
    assert.equal(rowCount(db, inboundEvents), 2);
    assert.equal(db.select().from(sideEffects).where(eq(sideEffects.key, "slack:case-created:trig-1")).all().length, 1);
    assert.equal(db.select().from(jobs).where(eq(jobs.idempotencyKey, "spec:CC-0001")).all().length, 1);
    assert.equal(statusOf(db, "CC-0001"), "RECEIVED");
  });

  it("is atomic: a failure mid-intake leaves no partial case, job, or event", () => {
    const { db } = testDb.handle;
    inTransaction(db, (tx) =>
      ensureEffect(tx, { key: "slack:case-created:trig-x", type: "slack.post_case_root", destination: { other: true }, payload: {} }),
    );
    const before = { jobs: rowCount(db, jobs), effects: rowCount(db, sideEffects) };
    assert.throws(() => intake(db, { triggerId: "trig-x" }), EffectConflictError);
    assert.equal(rowCount(db, cases), 0);
    assert.equal(rowCount(db, transitions), 0);
    assert.equal(rowCount(db, inboundEvents), 0);
    assert.deepEqual({ jobs: rowCount(db, jobs), effects: rowCount(db, sideEffects) }, before);
    assert.equal(db.select().from(appMeta).get()!.nextCaseNumber, 1, "case number allocation rolled back");
  });

  it("rejects empty reports with an actionable error", () => {
    assert.throws(() => intake(testDb.handle.db, { report: "   " }), IntakeValidationError);
    assert.equal(rowCount(testDb.handle.db, cases), 0);
  });
});

describe("spec persistence", () => {
  it("stores one immutable spec, transitions to SPEC_CREATED, and reserves reproduction", () => {
    const { db } = testDb.handle;
    const { caseId, specId, reproduceJobId } = caseWithSpec(db);
    assert.equal(statusOf(db, caseId), "SPEC_CREATED");
    const spec = db.select().from(reproSpecs).where(eq(reproSpecs.id, specId)).get()!;
    assert.equal(spec.appContextHash, goldenSpecFor(caseId).app_context_hash);
    assert.equal(db.select().from(jobs).where(eq(jobs.id, reproduceJobId)).get()!.idempotencyKey, `reproduce:${caseId}`);

    const again = recordSpecCreated(db, { caseId, spec: goldenSpecFor(caseId), appContext: stagingAppContext() });
    assert.ok(again.ok);
    assert.deepEqual(again.value, { specId, reproduceJobId });
    assert.throws(
      () => recordSpecCreated(db, { caseId, spec: { ...goldenSpecFor(caseId), goal: "Something else" }, appContext: stagingAppContext() }),
      SpecIdentityError,
    );
    assert.equal(rowCount(db, reproSpecs), 1);
  });

  it("refuses specs whose identity does not match the case or AppContext", () => {
    const { db } = testDb.handle;
    const { caseId } = intake(db);
    const wrongHash = { ...goldenSpecFor(caseId), app_context_hash: "sha256:deadbeef" };
    assert.throws(() => recordSpecCreated(db, { caseId, spec: wrongHash, appContext: stagingAppContext() }), SpecIdentityError);
    assert.throws(
      () => recordSpecCreated(db, { caseId, spec: goldenSpecFor("CC-9999"), appContext: stagingAppContext() }),
      SpecIdentityError,
    );
    assert.equal(rowCount(db, reproSpecs), 0);
    assert.equal(statusOf(db, caseId), "RECEIVED");
  });

  it("records spec failure reasons and a Slack reply intent without a reproduction job", () => {
    const { db } = testDb.handle;
    const { caseId } = intake(db);
    const outcome = recordSpecFailed(db, { caseId, kind: "insufficient", reasons: ["which page the failure occurs on"] });
    assert.ok(outcome.ok);
    assert.equal(statusOf(db, caseId), "SPEC_FAILED");
    assert.equal(db.select().from(sideEffects).where(eq(sideEffects.key, `slack:spec-failed:${caseId}`)).all().length, 1);
    assert.equal(db.select().from(jobs).where(eq(jobs.idempotencyKey, `reproduce:${caseId}`)).all().length, 0);
  });
});

describe("guarded transitions", () => {
  it("rejects an invalid event, persists the reason, and leaves status unchanged", () => {
    const { db } = testDb.handle;
    const { caseId } = intake(db);
    const outcome = applyCaseEvent(db, {
      type: "issue_confirmed",
      case_id: caseId,
      linear_issue_id: "lin-1",
      event_key: "issue:bogus",
    });
    assert.equal(outcome.ok, false);
    assert.equal(statusOf(db, caseId), "RECEIVED");
    const rejection = db.select().from(rejectedEvents).where(eq(rejectedEvents.caseId, caseId)).get()!;
    assert.equal(rejection.reason, "invalid_transition: RECEIVED -> ISSUE_FILED via issue_confirmed");
    assert.equal(rejection.fromStatus, "RECEIVED");
    assert.equal(db.select().from(transitions).where(eq(transitions.caseId, caseId)).all().length, 1);
  });

  it("rolls back the whole atomic unit but keeps the rejection audit row", () => {
    const { db } = testDb.handle;
    const { caseId } = intake(db);
    const outcome = runGuarded(db, (tx) => {
      tx.insert(fixAttempts)
        .values({ id: "att-x", caseId, repository: "acme/acmecloud", prNumber: 1, commitSha: "sha", mergedAt: 1, createdAt: 1 })
        .run();
      applyEventOrThrow(tx, { type: "deployment_ready", case_id: caseId, attempt_id: "att-x", commit_sha: "sha", event_key: "ready:x" });
    });
    assert.equal(outcome.ok, false);
    assert.equal(rowCount(db, fixAttempts), 0);
    assert.equal(rowCount(db, rejectedEvents), 1);
  });

  it("dedupes on event identity, not status", () => {
    const { db } = testDb.handle;
    const { caseId } = intake(db);
    const event = { type: "spec_failed" as const, case_id: caseId, kind: "insufficient" as const, event_key: "spec-failed:once" };
    assert.ok(applyCaseEvent(db, event).ok);
    const duplicate = applyCaseEvent(db, event);
    assert.ok(duplicate.ok && duplicate.value.duplicate);
    assert.equal(db.select().from(transitions).where(eq(transitions.caseId, caseId)).all().length, 2);
    assert.equal(rowCount(db, rejectedEvents), 0);
  });

  it("walks the full persisted loop: superficial fix → STILL_BROKEN → WAITING_FOR_FIX → second fix → VERIFIED_FIXED", () => {
    const { db } = testDb.handle;
    const { caseId } = driveToWaitingForFix(db);

    const first = mergeDeployAndClaimVerification(db, caseId, 84, "sha-superficial");
    assert.equal(statusOf(db, caseId), "VERIFYING");
    const broken = finalizeRun(db, { runId: first.runId, result: "STILL_BROKEN", assertionsPassed: 0, assertionsTotal: 2, signalsMatched: 1 });
    assert.ok(broken.ok);
    assert.equal(broken.value.caseStatus, "WAITING_FOR_FIX");

    const second = mergeDeployAndClaimVerification(db, caseId, 85, "sha-real");
    assert.notEqual(second.runId, first.runId);
    const fixed = finalizeRun(db, { runId: second.runId, result: "VERIFIED_FIXED", assertionsPassed: 2, assertionsTotal: 2, signalsMatched: 0 });
    assert.ok(fixed.ok);
    assert.equal(statusOf(db, caseId), "VERIFIED_FIXED");

    const history = db
      .select({ to: transitions.toStatus })
      .from(transitions)
      .where(eq(transitions.caseId, caseId))
      .orderBy(asc(transitions.id))
      .all()
      .map((row) => row.to);
    assert.deepEqual(history, [
      "RECEIVED",
      "SPEC_CREATED",
      "REPRODUCING",
      "REPRODUCED",
      "ISSUE_FILED",
      "WAITING_FOR_FIX",
      "FIX_MERGED",
      "WAITING_FOR_DEPLOYMENT",
      "VERIFYING",
      "STILL_BROKEN",
      "WAITING_FOR_FIX",
      "FIX_MERGED",
      "WAITING_FOR_DEPLOYMENT",
      "VERIFYING",
      "VERIFIED_FIXED",
    ]);
    assert.equal(rowCount(db, runs), 3);
    assert.equal(rowCount(db, fixAttempts), 2);
    assert.equal(rowCount(db, rejectedEvents), 0);

    // A verified case cannot be reopened by a late event.
    const late = applyCaseEvent(db, { type: "await_fix", case_id: caseId, event_key: "late" });
    assert.equal(late.ok, false);
  });

  it("refuses to re-finalize a run with a different verdict", () => {
    const { db } = testDb.handle;
    const { caseId } = driveToWaitingForFix(db);
    const { runId } = mergeDeployAndClaimVerification(db, caseId, 84, "sha-a");
    assert.ok(finalizeRun(db, { runId, result: "VERIFIED_FIXED" }).ok);
    const same = finalizeRun(db, { runId, result: "VERIFIED_FIXED" });
    assert.ok(same.ok && same.value.alreadyFinalized);
    assert.throws(() => finalizeRun(db, { runId, result: "STILL_BROKEN" }), /already finalized/);
  });

  it("requires a valid resolved plan to finalize REPRODUCED", () => {
    const { db } = testDb.handle;
    const { caseId } = caseWithSpec(db);
    const job = claimNext(db, ["reproduce"]);
    assert.ok(job?.runId);
    assert.throws(() => finalizeRun(db, { runId: job.runId!, result: "REPRODUCED" }), /resolved plan/);
    assert.equal(statusOf(db, caseId), "REPRODUCING");
    assert.equal(db.select().from(runs).where(eq(runs.id, job.runId!)).get()!.status, "running");
  });
});
