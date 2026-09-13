import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { and, count, eq } from "drizzle-orm";
import { AppContext } from "../../src/contracts/repro";
import { acceptDeploymentReady } from "../../src/server/services/deployment-ready";
import { acceptMergedPullRequest } from "../../src/server/services/fix-lifecycle";
import { handleVerifyJob } from "../../src/server/services/verification";
import { jobs, sideEffects, fixAttempts, runs } from "../../src/server/db/schema";
import { claimNext } from "../../src/server/jobs/queue";
import { completeJob } from "../../src/server/jobs/queue";
import { handleReproduceJob } from "../../src/server/services/reproduction";
import { handleDeliverEffectJob } from "../../src/server/services/external-delivery";
import type { EffectAdapter } from "../../src/server/side-effects/deliver";
import { createTestDatabase, type TestDatabase } from "../helpers/database";
import { buggyApp, FakeEnvironment, FakeLauncher, fakeClock, fixedApp, goldenResolver, superficialApp } from "../helpers/fake-browser";
import { caseWithSpec, driveToWaitingForFix, intake, stagingAppContext, statusOf } from "../helpers/lifecycle";

let testDb: TestDatabase;
beforeEach(() => { testDb = createTestDatabase(); });
afterEach(() => testDb.cleanup());

const repository = "acme/acmecloud";
const sha = "abcdef1234567890";
const context = () => AppContext.parse(stagingAppContext());

function metadata(caseId: string, commitSha = sha) {
  return {
    repository,
    number: 84,
    body: `CaseClosed: ${caseId}`,
    merged: true,
    mergeCommitSha: commitSha,
    mergedAt: "2026-09-13T12:00:00.000Z",
    baseBranch: "main",
    htmlUrl: `https://github.com/${repository}/pull/84`,
  };
}

async function acceptMerge(caseId: string) {
  return acceptMergedPullRequest(
    testDb.handle.db,
    { repository, pr: 84, commitSha: sha, deliveryId: "delivery-1" },
    async () => metadata(caseId),
    { expectedRepository: repository, defaultBranch: "main" },
  );
}

describe("external CaseClosed workflow", () => {
  it("duplicate Slack intake creates one canonical case and one root intent", () => {
    const first = intake(testDb.handle.db, { triggerId: "same-trigger" });
    const second = intake(testDb.handle.db, { triggerId: "same-trigger" });
    assert.deepEqual(second, { caseId: first.caseId, created: false });
    assert.equal(testDb.handle.db.select({ n: count() }).from(sideEffects).where(eq(sideEffects.type, "slack.post_case_root")).get()!.n, 1);
  });

  it("REPRODUCED creates exactly one Linear issue intent; NOT_REPRODUCED creates none", async () => {
    const { db } = testDb.handle;
    caseWithSpec(db);
    const reproducedJob = claimNext(db, ["reproduce"])!;
    await handleReproduceJob(reproducedJob, {
      db, appContext: context(), environment: new FakeEnvironment(), launcher: new FakeLauncher(buggyApp),
      resolver: goldenResolver(), artifactDir: path.join(testDb.dir, "artifacts"), knownSecrets: [], clock: fakeClock(),
    });
    assert.equal(db.select({ n: count() }).from(sideEffects).where(eq(sideEffects.type, "linear.create_issue")).get()!.n, 1);

    const clean = createTestDatabase();
    try {
      caseWithSpec(clean.handle.db);
      const job = claimNext(clean.handle.db, ["reproduce"])!;
      await handleReproduceJob(job, {
        db: clean.handle.db, appContext: context(), environment: new FakeEnvironment(), launcher: new FakeLauncher(fixedApp),
        resolver: goldenResolver(), artifactDir: path.join(clean.dir, "artifacts"), knownSecrets: [], clock: fakeClock(),
      });
      assert.equal(clean.handle.db.select({ n: count() }).from(sideEffects).where(eq(sideEffects.type, "linear.create_issue")).get()!.n, 0);
    } finally { clean.cleanup(); }
  });

  it("duplicate merge webhooks create one fix transition and merge alone never verifies", async () => {
    const { caseId } = driveToWaitingForFix(testDb.handle.db);
    const first = await acceptMerge(caseId);
    const duplicate = await acceptMerge(caseId);
    assert.ok(first.ok && !first.duplicate);
    assert.ok(duplicate.ok && duplicate.duplicate);
    assert.equal(testDb.handle.db.select({ n: count() }).from(fixAttempts).get()!.n, 1);
    assert.equal(testDb.handle.db.select({ n: count() }).from(jobs).where(eq(jobs.type, "verify")).get()!.n, 0);
    assert.equal(statusOf(testDb.handle.db, caseId), "WAITING_FOR_DEPLOYMENT");
  });

  it("associates a merged PR through Fixes ENG-### alone", async () => {
    const { caseId } = driveToWaitingForFix(testDb.handle.db);
    const outcome = await acceptMergedPullRequest(
      testDb.handle.db,
      { repository, pr: 84, commitSha: sha, deliveryId: "delivery-linear-ref" },
      async () => ({ ...metadata(caseId), body: "Fixes ENG-142" }),
      { expectedRepository: repository, defaultBranch: "main", linearTeamKey: "ENG" },
    );
    assert.ok(outcome.ok);
    assert.equal(outcome.caseId, caseId);
  });

  it("does not accept an open/unmerged PR", async () => {
    const { caseId } = driveToWaitingForFix(testDb.handle.db);
    const outcome = await acceptMergedPullRequest(
      testDb.handle.db,
      { repository, pr: 84, commitSha: sha, deliveryId: "delivery-open" },
      async () => ({ ...metadata(caseId), merged: false, mergeCommitSha: null, mergedAt: null }),
      { expectedRepository: repository, defaultBranch: "main" },
    );
    assert.deepEqual(outcome, { ok: false, reason: "webhook_metadata_mismatch" });
    assert.equal(statusOf(testDb.handle.db, caseId), "WAITING_FOR_FIX");
  });

  it("deployment-ready starts verification exactly once", async () => {
    const { caseId } = driveToWaitingForFix(testDb.handle.db);
    assert.ok((await acceptMerge(caseId)).ok);
    const first = acceptDeploymentReady(testDb.handle.db, { pr: 84, commit_sha: sha }, { repository });
    const duplicate = acceptDeploymentReady(testDb.handle.db, { pr: 84, commit_sha: sha, retry: false }, { repository });
    assert.ok(first.ok && first.response.status === "accepted");
    assert.ok(duplicate.ok && duplicate.response.status === "duplicate");
    assert.equal(testDb.handle.db.select({ n: count() }).from(jobs).where(eq(jobs.type, "verify")).get()!.n, 1);
    assert.equal(statusOf(testDb.handle.db, caseId), "VERIFYING");
  });

  it("wrong deployment signal is rejected and starts no verification", async () => {
    const { caseId } = driveToWaitingForFix(testDb.handle.db);
    assert.ok((await acceptMerge(caseId)).ok);
    const rejected = acceptDeploymentReady(testDb.handle.db, { pr: 84, commit_sha: "deadbee123456789" }, { repository });
    assert.deepEqual(rejected, { ok: false, reason: "unknown_pr_sha" });
    assert.equal(testDb.handle.db.select({ n: count() }).from(jobs).where(eq(jobs.type, "verify")).get()!.n, 0);
    assert.equal(statusOf(testDb.handle.db, caseId), "WAITING_FOR_DEPLOYMENT");
  });

  it("confirmed Linear creation stores the issue and advances to WAITING_FOR_FIX without closing it", async () => {
    const { db } = testDb.handle;
    const { caseId } = caseWithSpec(db);
    const reproduction = claimNext(db, ["reproduce"])!;
    await handleReproduceJob(reproduction, {
      db, appContext: context(), environment: new FakeEnvironment(), launcher: new FakeLauncher(buggyApp),
      resolver: goldenResolver(), artifactDir: path.join(testDb.dir, "artifacts"), knownSecrets: [], clock: fakeClock(),
    });
    const adapter: EffectAdapter = {
      reconcile: async () => ({ kind: "safe_to_send" }),
      send: async (effect) => effect.type === "linear.create_issue"
        ? { kind: "committed", externalId: effect.providerIdentity, result: { id: effect.providerIdentity, identifier: "ENG-142", url: "https://linear.app/issue/ENG-142" } }
        : { kind: "committed", externalId: effect.providerIdentity, result: { ts: effect.providerIdentity, channel: "C_TEST" } },
    };
    for (;;) {
      const job = claimNext(db, ["deliver_effect"]);
      if (!job) break;
      await handleDeliverEffectJob(job, db, { forType: () => adapter });
      completeJob(db, job.id);
    }
    assert.equal(statusOf(db, caseId), "WAITING_FOR_FIX");
    assert.equal(db.select({ n: count() }).from(sideEffects).where(eq(sideEffects.type, "linear.create_issue")).get()!.n, 1);
  });

  for (const scenario of [
    { name: "fixed app", app: fixedApp, expected: "VERIFIED_FIXED", status: "VERIFIED_FIXED" },
    { name: "partial fix / backend 500", app: superficialApp, expected: "STILL_BROKEN", status: "WAITING_FOR_FIX" },
  ] as const) {
    it(`${scenario.name} replays the original ReproSpec → ${scenario.expected}`, async () => {
      const { caseId } = driveToWaitingForFix(testDb.handle.db);
      assert.ok((await acceptMerge(caseId)).ok);
      assert.ok(acceptDeploymentReady(testDb.handle.db, { pr: 84, commit_sha: sha }, { repository }).ok);
      const job = claimNext(testDb.handle.db, ["verify"])!;
      const launcher = new FakeLauncher(scenario.app);
      const outcome = await handleVerifyJob(job, {
        db: testDb.handle.db,
        appContext: context(),
        environment: new FakeEnvironment({ health: { ok: true, commitSha: sha } }),
        launcher,
        artifactDir: path.join(testDb.dir, "artifacts"),
        knownSecrets: [],
        clock: fakeClock(),
      });
      assert.equal(outcome.result.result, scenario.expected);
      assert.equal(outcome.result.model_calls, 0);
      assert.equal(statusOf(testDb.handle.db, caseId), scenario.status);
      assert.equal(launcher.opens.length, 1, "verification uses one fresh browser context");
      assert.equal(testDb.handle.db.select().from(sideEffects).where(and(eq(sideEffects.runId, job.runId!), eq(sideEffects.type, "github.verification_comment"))).all().length, 1);
    });
  }

  it("verification infrastructure failure → INCONCLUSIVE", async () => {
    const { caseId } = driveToWaitingForFix(testDb.handle.db);
    assert.ok((await acceptMerge(caseId)).ok);
    assert.ok(acceptDeploymentReady(testDb.handle.db, { pr: 84, commit_sha: sha }, { repository }).ok);
    const job = claimNext(testDb.handle.db, ["verify"])!;
    const outcome = await handleVerifyJob(job, {
      db: testDb.handle.db,
      appContext: context(),
      environment: new FakeEnvironment({
        health: { ok: true, commitSha: sha },
        reset: { ok: false, reason: "fixture_reset_failed", detail: "reset unavailable" },
      }),
      launcher: new FakeLauncher(fixedApp),
      artifactDir: path.join(testDb.dir, "artifacts"),
      knownSecrets: [],
      clock: fakeClock(),
    });
    assert.equal(outcome.result.result, "INCONCLUSIVE");
    assert.equal(statusOf(testDb.handle.db, caseId), "VERIFICATION_INCONCLUSIVE");
  });

  it("Linear projections never request issue closure", () => {
    const { caseId } = driveToWaitingForFix(testDb.handle.db);
    const create = testDb.handle.db.select().from(sideEffects).where(eq(sideEffects.type, "linear.create_issue")).get()!;
    const payload = JSON.parse(create.payloadJson) as Record<string, unknown>;
    assert.equal("stateId" in payload || "state_id" in payload || "completed" in payload || "closed" in payload, false);
    assert.equal(statusOf(testDb.handle.db, caseId), "WAITING_FOR_FIX");
    assert.equal(testDb.handle.db.select({ n: count() }).from(runs).where(eq(runs.runType, "verification")).get()!.n, 0);
  });
});
