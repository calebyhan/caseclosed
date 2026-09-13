import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { ReproSpec, ResolvedPlan } from "../../src/contracts/repro";
import { classifyReproduction, classifyVerification } from "../../src/domain/classify";
import {
  baseObservations,
  asVerification,
  buggyObservations,
  element,
  fixedObservations,
  probe,
  response,
  series,
  superficialObservations,
} from "../helpers/observations";

const golden = ReproSpec.parse(JSON.parse(fs.readFileSync("fixtures/repro-spec.valid.json", "utf8")));
const plan = ResolvedPlan.parse({
  case_id: golden.case_id,
  spec_version: "1",
  actions: [
    { step_id: "step_1", action: { type: "click", role: "radio", name: "Annual" } },
    { step_id: "step_2", action: { type: "click", role: "button", name: "Upgrade" } },
  ],
});

describe("reproduction truth table", () => {
  it("rule 2: golden billing bug → REPRODUCED", () => {
    const result = classifyReproduction(buggyObservations(golden), golden);
    assert.equal(result.result, "REPRODUCED");
    assert.equal(result.infra_error, false);
    assert.deepEqual([result.assertions_passed, result.assertions_total, result.signals_matched], [0, 2, 2]);
    assert.equal(result.assertions.length, 2);
    assert.equal(result.signals.length, 2);
  });

  it("rule 3: fixed billing behavior → NOT_REPRODUCED", () => {
    const result = classifyReproduction(fixedObservations(golden), golden);
    assert.equal(result.result, "NOT_REPRODUCED");
    assert.deepEqual([result.assertions_passed, result.assertions_total, result.signals_matched], [2, 2, 0]);
  });

  it("superficial fix still reproduces via the network signal and failed checkout", () => {
    const result = classifyReproduction(superficialObservations(golden), golden);
    assert.equal(result.result, "REPRODUCED");
    assert.equal(result.signals_matched, 1);
  });

  it("rule 4: failed assertions without any matched signal → INCONCLUSIVE (not an infra error)", () => {
    const obs = baseObservations(golden, {
      network: [response(1, 404)],
      probes: [
        probe("a2", "assertion", series(0, 5_000, (at) => element(at, 0, false))),
        probe("f2", "signal", series(0, 5_000, (at) => element(at, 0, false))),
      ],
    });
    const result = classifyReproduction(obs, golden);
    assert.equal(result.result, "INCONCLUSIVE");
    assert.equal(result.infra_error, false);
  });

  it("rule 4: a matched signal with every assertion passing → INCONCLUSIVE", () => {
    const fixed = fixedObservations(golden);
    const obs = { ...fixed, probes: [fixed.probes[0]!, probe("f2", "signal", series(0, 5_000, (at) => element(at, 1, true)))] };
    assert.equal(classifyReproduction(obs, golden).result, "INCONCLUSIVE");
  });
});

describe("infrastructure and experiment validity dominate", () => {
  it("never maps infrastructure failure to NOT_REPRODUCED, even with passing facts", () => {
    for (const reason of ["fixture_reset_failed", "staging_unreachable", "action_budget_exhausted", "browser_crashed"] as const) {
      for (const obs of [fixedObservations(golden), buggyObservations(golden)]) {
        const result = classifyReproduction({ ...obs, infra_error: true, infra_error_reason: reason }, golden);
        assert.equal(result.result, "INCONCLUSIVE");
        assert.equal(result.infra_error_reason, reason);
      }
    }
  });

  it("a missing probe cannot produce NOT_REPRODUCED", () => {
    const fixed = fixedObservations(golden);
    const result = classifyReproduction({ ...fixed, probes: [fixed.probes[0]!] }, golden);
    assert.equal(result.result, "INCONCLUSIVE");
    assert.equal(result.infra_error_reason, "observations_incomplete");
    assert.match(result.infra_error_detail!, /f2/);
  });

  it("an incomplete network window cannot produce NOT_REPRODUCED", () => {
    const result = classifyReproduction(fixedObservations(golden, { network_window: { ended_at_ms: 1_200, complete: false } }), golden);
    assert.equal(result.result, "INCONCLUSIVE");
  });

  it("a completed network window shorter than the spec requires is still incomplete", () => {
    const fixed = fixedObservations(golden, { network_window: { ended_at_ms: 100, complete: true } });
    const result = classifyReproduction(fixed, golden);
    assert.equal(result.result, "INCONCLUSIVE");
    assert.equal(result.infra_error_reason, "observations_incomplete");
  });

  it("a failed target request cannot be interpreted as clean NOT_REPRODUCED", () => {
    const fixed = fixedObservations(golden, {
      network: [],
      request_failures: [{
        seq: 9,
        method: "POST",
        url: "http://localhost:3001/api/subscription",
        error: "net::ERR_CONNECTION_RESET",
        timestamp_ms: 1_200,
        same_origin: true,
        phase: "experiment",
      }],
    });
    const result = classifyReproduction(fixed, golden);
    assert.equal(result.result, "INCONCLUSIVE");
    assert.equal(result.infra_error_reason, "observations_incomplete");
  });

  it("unexecuted steps invalidate the experiment", () => {
    const result = classifyReproduction(buggyObservations(golden, { steps_completed: ["step_1"] }), golden);
    assert.equal(result.result, "INCONCLUSIVE");
    assert.match(result.infra_error_detail!, /steps completed/);
  });

  it("a forged completed-step list without corresponding successful actions is invalid", () => {
    const result = classifyReproduction(fixedObservations(golden, { actions: [], budgets_used: { actions: 0, replans: 0 } }), golden);
    assert.equal(result.result, "INCONCLUSIVE");
    assert.match(result.infra_error_detail!, /successful action log/);
  });

  it("observations for a different spec are rejected as environment drift", () => {
    const result = classifyReproduction(buggyObservations(golden, { spec_hash: "sha256:other" }), golden);
    assert.equal(result.result, "INCONCLUSIVE");
    assert.equal(result.infra_error_reason, "environment_changed");
  });

  it("an unexpected probe invalidates the experiment", () => {
    const buggy = buggyObservations(golden);
    const obs = { ...buggy, probes: [...buggy.probes, probe("zz", "assertion", [])] };
    assert.equal(classifyReproduction(obs, golden).result, "INCONCLUSIVE");
  });
});

describe("verification truth table and replay integrity", () => {
  it("accepts only a clean fixed replay", () => {
    const result = classifyVerification(asVerification(fixedObservations(golden), plan, "sha-fixed"), golden, plan, "sha-fixed");
    assert.equal(result.result, "VERIFIED_FIXED");
    assert.equal(result.model_calls, 0);
  });

  it("classifies a superficial fix as STILL_BROKEN", () => {
    const result = classifyVerification(asVerification(superficialObservations(golden), plan, "sha-superficial"), golden, plan, "sha-superficial");
    assert.equal(result.result, "STILL_BROKEN");
  });

  it("never verifies a replay with model calls, changed actions, or the wrong deployment", () => {
    const valid = asVerification(fixedObservations(golden), plan, "sha-fixed");
    const changedAction = structuredClone(valid);
    changedAction.actions[1]!.action = { type: "click", role: "radio", name: "Monthly" };
    for (const observations of [
      { ...valid, model_calls: 1 },
      changedAction,
      { ...valid, health_after: { commit_sha: "sha-other" } },
    ]) {
      const result = classifyVerification(observations, golden, plan, "sha-fixed");
      assert.equal(result.result, "INCONCLUSIVE");
      assert.equal(result.infra_error, true);
    }
  });
});
