import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { AppContext } from "../../src/contracts/repro";
import { cases, jobs, reproSpecs } from "../../src/server/db/schema";
import { claimNext } from "../../src/server/jobs/queue";
import type { ModelClient, ModelRequest, ModelResponse } from "../../src/server/model/client";
import { SpecGenerator } from "../../src/server/model/generate-spec";
import { handleGenerateSpecJob, SpecGenerationUnavailableError } from "../../src/server/services/spec-generation";
import { createTestDatabase, type TestDatabase } from "../helpers/database";
import { intake, stagingAppContext, statusOf } from "../helpers/lifecycle";

let testDb: TestDatabase;
beforeEach(() => {
  testDb = createTestDatabase();
});
afterEach(() => testDb.cleanup());

const fixture = JSON.parse(fs.readFileSync("fixtures/repro-spec.valid.json", "utf8"));
const validOutput = JSON.stringify({
  sufficient: true,
  missing: [],
  spec: { start_path: "/settings/billing", fixture: "pro_monthly_customer", goal: fixture.goal, steps: fixture.steps, assertions: fixture.assertions, failure_signals: fixture.failure_signals },
});

function client(responses: Array<string | Error>): ModelClient & { calls: number } {
  return {
    calls: 0,
    async generateJson(request: ModelRequest): Promise<ModelResponse> {
      this.calls += 1;
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected extra call");
      if (next instanceof Error) throw next;
      return { text: next, modelId: request.model };
    },
  };
}

function run(responses: Array<string | Error>) {
  const { db } = testDb.handle;
  const { caseId } = intake(db);
  const job = claimNext(db, ["generate_spec"]);
  assert.ok(job);
  const model = client(responses);
  const promise = handleGenerateSpecJob(job, {
    db,
    generator: new SpecGenerator(model, { primary: "gemini-test", fallback: null }),
    appContext: AppContext.parse(stagingAppContext()),
    knownSecrets: [],
  });
  return { caseId, job, model, promise };
}

describe("generate_spec job", () => {
  it("invalid model output is retried with feedback, then SPEC_CREATED with call counts persisted", async () => {
    const invalid = validOutput.replace('"fixture":"pro_monthly_customer"', '"fixture":"enterprise"');
    const { caseId, job, promise } = run([invalid, validOutput]);
    const result = await promise;
    assert.equal(result.kind, "spec_created");
    const { db } = testDb.handle;
    assert.equal(statusOf(db, caseId), "SPEC_CREATED");
    const spec = db.select().from(reproSpecs).where(eq(reproSpecs.caseId, caseId)).get()!;
    assert.equal(spec.generationModelCalls, 2);
    assert.equal(spec.modelId, "gemini-test");
    assert.ok(spec.generationSchemaJson);
    assert.equal(JSON.parse(spec.specJson).case_id, caseId);
    assert.equal(db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.modelCalls, 2);
    assert.equal(db.select().from(jobs).where(eq(jobs.idempotencyKey, `reproduce:${caseId}`)).all().length, 1);
  });

  it("still invalid after the retry budget → SPEC_FAILED (validation_failed), no reproduction job", async () => {
    const { caseId, model, promise } = run(["{}", "[]", "nope"]);
    const result = await promise;
    assert.equal(result.kind, "spec_failed");
    assert.equal(model.calls, 3);
    const { db } = testDb.handle;
    assert.equal(statusOf(db, caseId), "SPEC_FAILED");
    assert.equal(db.select().from(cases).where(eq(cases.id, caseId)).get()!.specFailureKind, "validation_failed");
    assert.equal(db.select().from(jobs).where(eq(jobs.idempotencyKey, `reproduce:${caseId}`)).all().length, 0);
  });

  it("insufficient report → SPEC_FAILED (insufficient) with missing reasons", async () => {
    const { caseId, promise } = run([JSON.stringify({ sufficient: false, missing: ["which page the failure occurs on"] })]);
    await promise;
    const row = testDb.handle.db.select().from(cases).where(eq(cases.id, caseId)).get()!;
    assert.equal(row.status, "SPEC_FAILED");
    assert.deepEqual(JSON.parse(row.specFailureReasonsJson!), ["which page the failure occurs on"]);
  });

  it("provider outage leaves the case RECEIVED and the job failing visibly", async () => {
    const { caseId, promise } = run([new Error("503"), new Error("503"), new Error("503")]);
    await assert.rejects(promise, SpecGenerationUnavailableError);
    assert.equal(statusOf(testDb.handle.db, caseId), "RECEIVED");
  });
});
