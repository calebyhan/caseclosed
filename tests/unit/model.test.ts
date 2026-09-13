import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { AppContext, ReproSpec } from "../../src/contracts/repro";
import { sha256Hash } from "../../src/domain/identity";
import { callWithTimeout, ModelCallError, type ModelClient, type ModelRequest, type ModelResponse } from "../../src/server/model/client";
import { SpecGenerator, type SpecGenerationInput } from "../../src/server/model/generate-spec";
import { GeminiStepResolver } from "../../src/server/model/resolve-step";

const ctx = AppContext.parse(JSON.parse(fs.readFileSync("config/environments/staging.json", "utf8")));
const fixture = ReproSpec.parse(JSON.parse(fs.readFileSync("fixtures/repro-spec.valid.json", "utf8")));
const SECRET = "staging-secret-value-0123456789";

type Scripted = string | Error;

class FakeModelClient implements ModelClient {
  requests: Array<Omit<ModelRequest, "signal">> = [];

  constructor(private readonly responses: Scripted[]) {}

  async generateJson(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone({
      model: request.model,
      system: request.system,
      turns: request.turns,
      responseJsonSchema: request.responseJsonSchema,
    }));
    const next = this.responses.shift();
    if (next === undefined) throw new Error("unexpected extra model call");
    if (next instanceof Error) throw next;
    return { text: next, modelId: request.model };
  }
}

type FlatGeneratedSpec = {
  start_path: string;
  fixture: string;
  goal: string;
  steps: Array<Record<string, unknown>>;
  assertions: Array<Record<string, unknown>>;
  failure_signals: Array<Record<string, unknown>>;
};

function flatSpec(patch: (spec: FlatGeneratedSpec) => void = () => {}): string {
  const spec = {
    start_path: fixture.environment.start_path,
    fixture: fixture.environment.fixture,
    goal: fixture.goal,
    // Each scripted response must be isolated. Several tests deliberately
    // replace nested checks; sharing the fixture arrays would leak that
    // mutation into every response constructed afterwards.
    steps: structuredClone(fixture.steps),
    assertions: structuredClone(fixture.assertions),
    failure_signals: structuredClone(fixture.failure_signals),
  };
  patch(spec);
  return JSON.stringify({ sufficient: true, missing: [], spec });
}

function input(overrides: Partial<SpecGenerationInput> = {}): SpecGenerationInput & { persisted: number[] } {
  const persisted: number[] = [];
  return {
    caseId: "CC-0042",
    report: "When I switch my Pro plan from monthly to annual and click Upgrade, it spins forever.",
    appContext: ctx,
    appContextHash: sha256Hash(ctx),
    callsAlreadyUsed: 0,
    onBeforeCall: (calls) => {
      persisted.push(calls);
    },
    knownSecrets: [SECRET],
    persisted,
    ...overrides,
  };
}

const models = { primary: "primary-model", fallback: "fallback-model" };

describe("SpecGenerator", () => {
  it("builds a validated ReproSpec with application-owned identity", async () => {
    const client = new FakeModelClient([flatSpec()]);
    const outcome = await new SpecGenerator(client, models).generate(input());
    assert.equal(outcome.kind, "sufficient");
    assert.deepEqual(outcome.kind === "sufficient" && outcome.spec, fixture);
    assert.equal(outcome.modelCalls, 1);
    assert.equal(client.requests[0]!.responseJsonSchema.type, "object");
  });

  it("returns validation errors to the model and retries within the budget", async () => {
    const invalid = flatSpec((spec) => {
      spec.assertions[0] = { ...spec.assertions[0], url_contains: "/api/billing" };
    });
    const run = input();
    let persistedBeforeDispatch: number[] = [];
    const client = new FakeModelClient([invalid, flatSpec()]);
    const originalGenerate = client.generateJson.bind(client);
    client.generateJson = async (request) => {
      persistedBeforeDispatch = [...run.persisted];
      return originalGenerate(request);
    };

    const outcome = await new SpecGenerator(client, models).generate(run);
    assert.equal(outcome.kind, "sufficient");
    assert.equal(outcome.modelCalls, 2);
    assert.deepEqual(persistedBeforeDispatch, [1, 2], "each call is persisted before it is dispatched");

    const retry = client.requests[1]!;
    assert.equal(retry.turns.length, 3);
    assert.equal(retry.turns[1]!.role, "model");
    const feedback = JSON.stringify(retry.turns[2]);
    assert.match(feedback, /spec\.assertions\.0\.url_contains/);
    assert.match(feedback, /declared POST endpoint/);
  });

  it("stops after three invalid responses and reports the last errors", async () => {
    const client = new FakeModelClient(["not json", JSON.stringify({ sufficient: false, missing: [] }), flatSpec((spec) => (spec.fixture = "unknown"))]);
    const run = input();
    const outcome = await new SpecGenerator(client, models).generate(run);
    assert.equal(outcome.kind, "invalid");
    assert.equal(outcome.modelCalls, 3);
    assert.deepEqual(run.persisted, [1, 2, 3]);
    assert.ok(outcome.kind === "invalid" && outcome.errors.some((error) => error.path === "spec.fixture"));
    assert.equal(client.requests.length, 3, "never a fourth call");
  });

  it("rejects fields that do not belong to a check type", async () => {
    const stray = flatSpec((spec) => {
      spec.assertions[1] = { ...spec.assertions[1], method: "POST" };
    });
    const client = new FakeModelClient([stray, flatSpec()]);
    const outcome = await new SpecGenerator(client, models).generate(input());
    assert.equal(outcome.kind, "sufficient");
    assert.match(JSON.stringify(client.requests[1]!.turns[2]), /spec\.assertions\.1\.method: not allowed for type element_visible/);
  });

  it("treats insufficiency as a valid answer without spending retries", async () => {
    const client = new FakeModelClient([JSON.stringify({ sufficient: false, missing: ["which page the failure occurs on"] })]);
    const outcome = await new SpecGenerator(client, models).generate(input({ report: "billing is broken for me" }));
    assert.deepEqual(outcome, { kind: "insufficient", missing: ["which page the failure occurs on"], modelCalls: 1, modelId: "primary-model" });
  });

  it("reports provider outages as unavailable, switching to the fallback model", async () => {
    const outage = () => new ModelCallError("provider", "model provider error (HTTP 503)");
    const client = new FakeModelClient([outage(), outage(), outage()]);
    const outcome = await new SpecGenerator(client, models).generate(input());
    assert.equal(outcome.kind, "unavailable");
    assert.equal(outcome.modelCalls, 3);
    assert.deepEqual(client.requests.map((request) => request.model), ["primary-model", "fallback-model", "fallback-model"]);
  });

  it("resumes only the unspent budget after a restart", async () => {
    const client = new FakeModelClient(["{}"]);
    const outcome = await new SpecGenerator(client, models).generate(input({ callsAlreadyUsed: 2 }));
    assert.equal(outcome.kind, "invalid");
    assert.equal(client.requests.length, 1);
    const exhausted = await new SpecGenerator(new FakeModelClient([]), models).generate(input({ callsAlreadyUsed: 3 }));
    assert.equal(exhausted.kind, "unavailable");
  });

  it("never sends configured secrets or credentials from reports or AppContext in the prompt", async () => {
    const client = new FakeModelClient([flatSpec()]);
    const appContext = structuredClone(ctx);
    appContext.routes[0]!.description = `internal ${SECRET}`;
    await new SpecGenerator(client, models).generate(input({
      report: `Upgrade spins. My key is ${SECRET} and Bearer abcdefghijklmnop`,
      appContext,
    }));
    const sent = JSON.stringify(client.requests);
    assert.equal(sent.includes(SECRET), false);
    assert.equal(sent.includes("abcdefghijklmnop"), false);
    assert.match(sent, /\[REDACTED\]/);
  });
});

describe("model call guards", () => {
  it("times out a hung call", async () => {
    const hung: ModelClient = { generateJson: () => new Promise<ModelResponse>(() => undefined) };
    await assert.rejects(
      callWithTimeout(hung, { model: "m", system: "", turns: [], responseJsonSchema: {} }, 20),
      (error: unknown) => error instanceof ModelCallError && error.kind === "timeout",
    );
  });
});

describe("GeminiStepResolver", () => {
  it("sends the redacted snapshot, route landmarks, and failures, and drops null fields", async () => {
    const client = new FakeModelClient([JSON.stringify({ type: "click", role: "radio", name: "Annual", path: null, fallbacks: null })]);
    const resolver = new GeminiStepResolver(client, models, [SECRET]);
    const proposal = await resolver.resolve({
      goal: fixture.goal,
      step: fixture.steps[0]!,
      stepIndex: 0,
      totalSteps: 2,
      currentPath: "/settings/billing",
      accessibilitySnapshot: `- radio "Annual"\n- text "${SECRET}"`,
      appContext: ctx,
      previousFailures: ["click radio \"Yearly\" was not executed"],
    });
    assert.deepEqual(proposal, { type: "click", role: "radio", name: "Annual" });
    const request = client.requests[0]!;
    const sent = JSON.stringify(request);
    assert.equal(sent.includes(SECRET), false);
    assert.match(sent, /Upgrade/);
    assert.doesNotMatch(sent, /Confirm payment/, "only landmarks for the current route are sent");
    assert.match(sent, /Yearly/);
    assert.equal(request.turns[0]!.parts.some((part) => "inlineData" in part), false);
  });

  it("uses the configured fallback on the next persisted resolution after a provider failure", async () => {
    const client = new FakeModelClient([
      new ModelCallError("provider", "model provider error (HTTP 429)"),
      JSON.stringify({ type: "click", role: "radio", name: "Annual" }),
    ]);
    const resolver = new GeminiStepResolver(client, models, [SECRET]);
    const request = {
      goal: fixture.goal,
      step: fixture.steps[0]!,
      stepIndex: 0,
      totalSteps: 2,
      currentPath: "/settings/billing",
      accessibilitySnapshot: '- radio "Annual"',
      appContext: ctx,
      previousFailures: [],
    };
    await assert.rejects(() => resolver.resolve(request), ModelCallError);
    await resolver.resolve(request);
    assert.deepEqual(client.requests.map((entry) => entry.model), ["primary-model", "fallback-model"]);
  });
});
