import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { AppContext, ReproSpec } from "../../src/contracts/repro";
import { classifyReproduction } from "../../src/domain/classify";
import { sha256Hash } from "../../src/domain/identity";
import { runReproduction, type ReproductionInput } from "../../src/server/browser/runner";
import { ModelCallError } from "../../src/server/model/client";
import { buggyApp, FakeEnvironment, FakeLauncher, fakeClock, fixedApp, goldenResolver, ScriptedResolver } from "../helpers/fake-browser";

const ctx = AppContext.parse(JSON.parse(fs.readFileSync("config/environments/staging.json", "utf8")));
const golden = ReproSpec.parse(JSON.parse(fs.readFileSync("fixtures/repro-spec.valid.json", "utf8")));

function run(overrides: Partial<ReproductionInput> = {}) {
  const calls: number[] = [];
  const input: ReproductionInput = {
    spec: golden,
    specHash: sha256Hash(golden),
    appContext: ctx,
    environment: new FakeEnvironment(),
    launcher: new FakeLauncher(buggyApp),
    resolver: goldenResolver(),
    knownSecrets: [],
    onModelCall: (n) => {
      calls.push(n);
    },
    clock: fakeClock(),
    ...overrides,
  };
  return { calls, input, promise: runReproduction(input) };
}

describe("reproduction loop", () => {
  it("golden billing bug: resets, resolves each step once, and records facts that classify REPRODUCED", async () => {
    const environment = new FakeEnvironment();
    const launcher = new FakeLauncher(buggyApp);
    const { calls, promise } = run({ environment, launcher });
    const output = await promise;
    assert.deepEqual(environment.resets, ["pro_monthly_customer"]);
    assert.equal(output.observations.infra_error, false);
    assert.deepEqual(output.observations.steps_completed, ["step_1", "step_2"]);
    assert.deepEqual(output.planActions.map((a) => a.action), [
      { type: "click", role: "radio", name: "Annual" },
      { type: "click", role: "button", name: "Upgrade" },
    ]);
    assert.deepEqual(calls, [1, 2]);
    assert.equal(output.observations.budgets_used.actions, 3, "start navigation counts as an action");
    assert.equal(output.observations.network_window?.complete, true);
    assert.ok(output.screenshots.before && output.screenshots.after);
    assert.equal(launcher.sessions[0]!.closed, true);
    assert.equal(classifyReproduction(output.observations, golden).result, "REPRODUCED");
  });

  it("fixed billing behavior classifies NOT_REPRODUCED", async () => {
    const output = await run({ launcher: new FakeLauncher(fixedApp) }).promise;
    const result = classifyReproduction(output.observations, golden);
    assert.equal(result.result, "NOT_REPRODUCED", JSON.stringify(result, null, 1));
  });

  it("fixture reset failure → INCONCLUSIVE before any browser or model work", async () => {
    const launcher = new FakeLauncher(fixedApp);
    const resolver = goldenResolver();
    const output = await run({
      environment: new FakeEnvironment({ reset: { ok: false, reason: "fixture_reset_failed", detail: "reset returned HTTP 500" } }),
      launcher,
      resolver,
    }).promise;
    assert.equal(output.observations.infra_error_reason, "fixture_reset_failed");
    assert.equal(launcher.opens.length, 0);
    assert.equal(resolver.requests.length, 0);
    const result = classifyReproduction(output.observations, golden);
    assert.equal(result.result, "INCONCLUSIVE");
    assert.notEqual(result.result, "NOT_REPRODUCED");
  });

  it("staging unavailable and auth failure are infrastructure errors", async () => {
    const down = await run({ environment: new FakeEnvironment({ health: { ok: false, reason: "staging_unreachable", detail: "ECONNREFUSED" } }) }).promise;
    assert.equal(classifyReproduction(down.observations, golden).infra_error_reason, "staging_unreachable");
    const auth = await run({ environment: new FakeEnvironment({ session: { ok: false, reason: "auth_failed", detail: "HTTP 401" } }) }).promise;
    assert.equal(classifyReproduction(auth.observations, golden).infra_error_reason, "auth_failed");
    const crash = await run({ launcher: new FakeLauncher(buggyApp, { throwOnOpen: true }) }).promise;
    assert.equal(crash.observations.infra_error_reason, "browser_crashed");
  });

  it("action budget exhaustion (15 actions) → INCONCLUSIVE", async () => {
    const spec = ReproSpec.parse({ ...golden, steps: Array.from({ length: 15 }, (_, i) => ({ id: `step_${i + 1}`, intent: "Wait for the page" })) });
    const output = await run({ spec, specHash: sha256Hash(spec), resolver: new ScriptedResolver(() => ({ type: "wait", milliseconds: 100 })) }).promise;
    assert.equal(output.observations.budgets_used.actions, 15);
    assert.equal(output.observations.steps_completed.length, 14);
    assert.equal(output.observations.infra_error_reason, "action_budget_exhausted");
    assert.equal(classifyReproduction(output.observations, spec).result, "INCONCLUSIVE");
  });

  it("allows only one additional resolution across the run and never uses visual recovery", async () => {
    const resolver = new ScriptedResolver((request) => {
      if (/annual/i.test(request.step.intent)) {
        return { type: "click", role: "radio", name: "Yearly" };
      }
      return { type: "click", role: "button", name: "Upgrade" };
    });
    const output = await run({ resolver }).promise;
    assert.equal(output.observations.infra_error_reason, "step_unresolvable");
    assert.deepEqual(output.observations.budgets_used, { actions: 1, replans: 1 });
    assert.deepEqual(output.observations.actions.map((a) => a.resolution), ["runner"]);
    assert.equal(resolver.requests.length, 2);
    assert.equal(resolver.requests[1]!.previousFailures.length, 1);
    assert.match(resolver.requests[1]!.previousFailures[0]!, /Yearly/);
  });

  it("an unresolvable step after all budgets → INCONCLUSIVE step_unresolvable", async () => {
    const resolver = new ScriptedResolver(() => ({ type: "click", role: "radio", name: "Yearly" }));
    const output = await run({ resolver }).promise;
    assert.equal(resolver.requests.length, 2);
    assert.equal(output.observations.infra_error_reason, "step_unresolvable");
    assert.equal(classifyReproduction(output.observations, golden).result, "INCONCLUSIVE");
  });

  it("invalid proposals and model failures consume replans but never execute", async () => {
    const proposals = [
      { type: "finish", reason: "done" },
      { type: "click", role: "radio", name: "Annual", x: 5, y: 5 },
      { type: "goto", path: "https://evil.example/" },
    ];
    const resolver = new ScriptedResolver((request, index) => {
      if (index >= 3) throw new ModelCallError("timeout", "model call exceeded 20000ms");
      return proposals[index];
    });
    const launcher = new FakeLauncher(buggyApp);
    const output = await run({ resolver, launcher }).promise;
    assert.equal(output.observations.infra_error_reason, "step_unresolvable");
    assert.equal(launcher.sessions[0]!.executed.length, 0);
    assert.equal(output.observations.budgets_used.actions, 1);
  });

  it("does not retry an interaction whose effects are uncertain", async () => {
    const launcher = new FakeLauncher(buggyApp, { uncertainOn: "button|Upgrade" });
    const resolver = goldenResolver();
    const output = await run({ launcher, resolver }).promise;
    assert.equal(output.observations.infra_error_reason, "action_failed");
    assert.equal(resolver.requests.length, 2);
  });

  it("enforces the run duration budget", async () => {
    const hanging = new ScriptedResolver(() => new Promise(() => undefined));
    const output = await run({ resolver: hanging, budgets: { maxRunDurationMs: 50 } }).promise;
    assert.equal(output.observations.infra_error_reason, "duration_budget_exhausted");
    assert.equal(classifyReproduction(output.observations, golden).result, "INCONCLUSIVE");
  });

  it("invalidates a run when staging changes after evidence collection", async () => {
    const environment = new FakeEnvironment({
      health: [
        { ok: true, commitSha: "sha-before" },
        { ok: true, commitSha: "sha-after" },
      ],
    });
    const output = await run({ environment }).promise;
    assert.equal(output.observations.infra_error_reason, "deployment_changed");
    assert.equal(classifyReproduction(output.observations, golden).result, "INCONCLUSIVE");
  });
});
