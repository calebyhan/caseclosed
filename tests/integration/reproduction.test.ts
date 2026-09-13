import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { asc, eq } from "drizzle-orm";
import { AppContext, ReproSpec } from "../../src/contracts/repro";
import type { RunObservations } from "../../src/contracts/run";
import { classifyReproduction } from "../../src/domain/classify";
import { assertionResults, browserActions, evidence, jobs, resolvedPlans, runs, transitions } from "../../src/server/db/schema";
import { claimNext } from "../../src/server/jobs/queue";
import { handleReproduceJob, type ReproductionDeps } from "../../src/server/services/reproduction";
import { recordSpecCreated } from "../../src/server/services/spec-lifecycle";
import { createTestDatabase, type TestDatabase } from "../helpers/database";
import { buggyApp, FakeEnvironment, FakeLauncher, fakeClock, fixedApp, goldenResolver, ScriptedResolver } from "../helpers/fake-browser";
import { caseWithSpec, goldenSpecFor, intake, stagingAppContext, statusOf } from "../helpers/lifecycle";

let testDb: TestDatabase;
let artifactDir: string;
beforeEach(() => {
  testDb = createTestDatabase();
  artifactDir = path.join(testDb.dir, "artifacts");
});
afterEach(() => testDb.cleanup());

const ctx = () => AppContext.parse(stagingAppContext());

function deps(overrides: Partial<ReproductionDeps> = {}): ReproductionDeps {
  return {
    db: testDb.handle.db,
    appContext: ctx(),
    environment: new FakeEnvironment(),
    launcher: new FakeLauncher(buggyApp),
    resolver: goldenResolver(),
    artifactDir,
    knownSecrets: [],
    clock: fakeClock(),
    ...overrides,
  };
}

function claimReproduction() {
  const job = claimNext(testDb.handle.db, ["reproduce"]);
  assert.ok(job?.runId);
  return job;
}

describe("reproduction service", () => {
  it("golden billing bug → REPRODUCED with actions, checks, evidence, plan and transitions persisted atomically", async () => {
    const { db } = testDb.handle;
    const { caseId } = caseWithSpec(db);
    const job = claimReproduction();

    const outcome = await handleReproduceJob(job, deps());
    assert.equal(outcome.result.result, "REPRODUCED");
    assert.equal(statusOf(db, caseId), "REPRODUCED");

    const run = db.select().from(runs).where(eq(runs.id, job.runId!)).get()!;
    assert.equal(run.status, "completed");
    assert.equal(run.result, "REPRODUCED");
    assert.deepEqual([run.assertionsPassed, run.assertionsTotal, run.signalsMatched, run.modelCalls], [0, 2, 2, 2]);
    assert.equal(run.commitSha, "fake-sha");
    assert.equal(db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status, "completed");

    const actions = db.select().from(browserActions).where(eq(browserActions.runId, run.id)).orderBy(asc(browserActions.seq)).all();
    assert.deepEqual(actions.map((a) => [a.seq, a.stepId, a.ok]), [[1, "__start__", true], [2, "step_1", true], [3, "step_2", true]]);
    assert.equal(JSON.parse(actions[2]!.actionJson).locator_used, "role");

    const checks = db.select().from(assertionResults).where(eq(assertionResults.runId, run.id)).all();
    assert.deepEqual(checks.map((c) => `${c.kind}:${c.assertionId}:${c.passed}`).sort(), ["assertion:a1:false", "assertion:a2:false", "signal:f1:true", "signal:f2:true"]);

    const plan = db.select().from(resolvedPlans).where(eq(resolvedPlans.caseId, caseId)).get()!;
    assert.equal(plan.sourceRunId, run.id);
    assert.deepEqual(JSON.parse(plan.planJson).actions.map((a: { step_id: string }) => a.step_id), ["step_1", "step_2"]);

    const files = db.select().from(evidence).where(eq(evidence.runId, run.id)).all();
    assert.deepEqual(files.map((f) => f.relativePath.split("/")[1]).sort(), [
      "actions.json", "after.png", "assertions.json", "before.png", "console.json", "failure.png", "network.json", "observations.json", "result.json",
    ]);
    for (const file of files) {
      const bytes = fs.readFileSync(path.join(artifactDir, file.relativePath));
      assert.equal(file.sha256, `sha256:${createHash("sha256").update(bytes).digest("hex")}`, file.relativePath);
    }

    // The verdict is reconstructible from persisted rows alone.
    const spec = ReproSpec.parse(goldenSpecFor(caseId));
    const stored = JSON.parse(run.observationsJson!) as RunObservations;
    assert.equal(classifyReproduction(stored, spec).result, "REPRODUCED");

    const history = db.select({ to: transitions.toStatus }).from(transitions).where(eq(transitions.caseId, caseId)).orderBy(asc(transitions.id)).all();
    assert.deepEqual(history.map((h) => h.to), ["RECEIVED", "SPEC_CREATED", "REPRODUCING", "REPRODUCED"]);
  });

  it("fixed billing behavior on an initial reproduction → NOT_REPRODUCED with no plan", async () => {
    const { db } = testDb.handle;
    const { caseId } = caseWithSpec(db);
    const job = claimReproduction();
    const outcome = await handleReproduceJob(job, deps({ launcher: new FakeLauncher(fixedApp) }));
    assert.equal(outcome.result.result, "NOT_REPRODUCED");
    assert.equal(statusOf(db, caseId), "NOT_REPRODUCED");
    assert.equal(db.select().from(resolvedPlans).all().length, 0);
    const names = db.select().from(evidence).where(eq(evidence.runId, job.runId!)).all().map((f) => f.relativePath);
    assert.equal(names.some((name) => name.endsWith("failure.png")), false);
  });

  it("fixture-reset failure → INCONCLUSIVE / REPRO_INCONCLUSIVE, never NOT_REPRODUCED", async () => {
    const { db } = testDb.handle;
    const { caseId } = caseWithSpec(db);
    const job = claimReproduction();
    const launcher = new FakeLauncher(fixedApp);
    const outcome = await handleReproduceJob(
      job,
      deps({ launcher, environment: new FakeEnvironment({ reset: { ok: false, reason: "fixture_reset_failed", detail: "HTTP 500" } }) }),
    );
    assert.equal(outcome.result.result, "INCONCLUSIVE");
    assert.equal(statusOf(db, caseId), "REPRO_INCONCLUSIVE");
    const run = db.select().from(runs).where(eq(runs.id, job.runId!)).get()!;
    assert.equal(run.infraErrorReason, "fixture_reset_failed");
    assert.equal(launcher.opens.length, 0);
    assert.equal(db.select().from(assertionResults).where(eq(assertionResults.runId, run.id)).all().length, 4, "one row per check even on infra failure");
  });

  it("action-budget exhaustion → INCONCLUSIVE with every attempted action persisted", async () => {
    const { db } = testDb.handle;
    const { caseId } = intake(db);
    const spec = { ...goldenSpecFor(caseId), steps: Array.from({ length: 15 }, (_, i) => ({ id: `step_${i + 1}`, intent: "Wait for the page" })) };
    assert.ok(recordSpecCreated(db, { caseId, spec, appContext: stagingAppContext() }).ok);
    const job = claimReproduction();
    const outcome = await handleReproduceJob(job, deps({ resolver: new ScriptedResolver(() => ({ type: "wait", milliseconds: 100 })) }));
    assert.equal(outcome.result.result, "INCONCLUSIVE");
    assert.equal(outcome.result.infra_error_reason, "action_budget_exhausted");
    assert.equal(statusOf(db, caseId), "REPRO_INCONCLUSIVE");
    assert.equal(db.select().from(browserActions).where(eq(browserActions.runId, job.runId!)).all().length, 15);
  });

  it("AppContext drift → INCONCLUSIVE environment_changed without touching staging", async () => {
    const { db } = testDb.handle;
    caseWithSpec(db);
    const job = claimReproduction();
    const environment = new FakeEnvironment();
    const drifted = { ...ctx(), routes: [...ctx().routes, { path: "/new", name: "New", description: "Added later" }] };
    const outcome = await handleReproduceJob(job, deps({ environment, appContext: drifted }));
    assert.equal(outcome.result.infra_error_reason, "environment_changed");
    assert.equal(environment.resets.length, 0);
  });

  it("refuses a staging driver path that could reset a different target on the same origin", async () => {
    const { db } = testDb.handle;
    caseWithSpec(db);
    const job = claimReproduction();
    const environment = new FakeEnvironment();
    Object.defineProperty(environment, "baseUrl", { value: `${environment.baseUrl}/other-target` });
    const outcome = await handleReproduceJob(job, deps({ environment }));
    assert.equal(outcome.result.infra_error_reason, "environment_changed");
    assert.equal(environment.resets.length, 0);
  });

  it("unwritable evidence → INCONCLUSIVE evidence_write_failed", async () => {
    const { db } = testDb.handle;
    const { caseId } = caseWithSpec(db);
    const job = claimReproduction();
    const blocked = path.join(testDb.dir, "not-a-directory");
    fs.writeFileSync(blocked, "file");
    const outcome = await handleReproduceJob(job, deps({ artifactDir: blocked }));
    assert.equal(outcome.result.result, "INCONCLUSIVE");
    assert.equal(outcome.result.infra_error_reason, "evidence_write_failed");
    assert.equal(statusOf(db, caseId), "REPRO_INCONCLUSIVE");
  });
});
