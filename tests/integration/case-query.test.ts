import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { applyCaseEvent } from "../../src/server/db/repositories";
import { jobs, sideEffects } from "../../src/server/db/schema";
import { getCaseDetail } from "../../src/server/services/case-query";
import { recordSpecFailed } from "../../src/server/services/spec-lifecycle";
import { createTestDatabase, type TestDatabase } from "../helpers/database";
import { caseWithSpec, intake } from "../helpers/lifecycle";

let testDb: TestDatabase;
before(() => {
  testDb = createTestDatabase();
  // The route handler resolves its database from configuration.
  process.env.DATABASE_PATH = testDb.path;
});
after(() => {
  testDb.cleanup();
});

describe("getCaseDetail", () => {
  it("returns null for unknown cases", () => {
    assert.equal(getCaseDetail(testDb.handle.db, "CC-9999"), null);
  });

  it("projects case, timeline with rejections, spec, jobs and effects", () => {
    const { db } = testDb.handle;
    const { caseId } = caseWithSpec(db);
    applyCaseEvent(db, { type: "await_fix", case_id: caseId, event_key: "bogus" });

    const detail = getCaseDetail(db, caseId)!;
    assert.equal(detail.case.status, "SPEC_CREATED");
    assert.equal(detail.case.terminal, false);
    assert.deepEqual(
      detail.timeline.map((entry) => (entry.kind === "transition" ? entry.to : `rejected:${entry.reason}`)),
      ["RECEIVED", "SPEC_CREATED", "rejected:invalid_transition: SPEC_CREATED -> WAITING_FOR_FIX via await_fix"],
    );
    assert.equal((detail.spec!.spec as { goal: string }).goal, "Reproduce failure when changing billing from monthly to annual");
    assert.deepEqual(detail.jobs.map((job) => job.idempotency_key).sort(), [
      `effect:${detail.side_effects[0]!.key}`,
      `reproduce:${caseId}`,
      `spec:${caseId}`,
    ]);
    assert.equal(detail.runs.length, 0);
    assert.equal(detail.live, true);
  });

  it("keeps a terminal case live until its pending work settles", () => {
    const { db } = testDb.handle;
    const { caseId } = intake(db);
    assert.ok(recordSpecFailed(db, { caseId, kind: "insufficient", reasons: ["expected behavior"] }).ok);
    const pending = getCaseDetail(db, caseId)!;
    assert.equal(pending.case.terminal, true);
    assert.deepEqual(pending.case.spec_failure, { kind: "insufficient", reasons: ["expected behavior"] });
    assert.equal(pending.live, true);

    db.update(jobs).set({ status: "completed" }).where(eq(jobs.caseId, caseId)).run();
    db.update(sideEffects).set({ status: "completed", externalId: "x" }).where(eq(sideEffects.caseId, caseId)).run();
    assert.equal(getCaseDetail(db, caseId)!.live, false);
  });
});

describe("GET /api/cases/:id", () => {
  it("returns 400, 404, and 200 with no-store for persisted cases", async () => {
    const { GET } = await import("../../src/app/api/cases/[id]/route");
    const call = (id: string) => GET(new Request(`http://localhost/api/cases/${id}`), { params: Promise.resolve({ id }) });

    const invalid = await call("../../etc/passwd");
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "invalid_case_id");

    assert.equal((await call("CC-9999")).status, 404);

    const { caseId } = intake(testDb.handle.db);
    const ok = await call(caseId);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const body = await ok.json();
    assert.equal(body.case.id, caseId);
    assert.equal(body.case.status, "RECEIVED");
  });
});
