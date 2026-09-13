import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { ReproSpec } from "../../src/contracts/repro";
import type { CheckOutcome } from "../../src/contracts/run";
import { evaluateChecks } from "../../src/domain/assertions";
import {
  BASE,
  baseObservations,
  buggyObservations,
  element,
  EPOCH,
  fixedObservations,
  probe,
  response,
  series,
} from "../helpers/observations";

const golden = ReproSpec.parse(JSON.parse(fs.readFileSync("fixtures/repro-spec.valid.json", "utf8")));

function specWith(patch: Partial<ReproSpec>): ReproSpec {
  return ReproSpec.parse({ ...golden, ...patch });
}

const byId = (outcomes: CheckOutcome[], id: string) => outcomes.find((outcome) => outcome.id === id)!;

describe("network_status", () => {
  it("passes the 2xx assertion and does not match the 5xx signal for a 200", () => {
    const { assertions, signals } = evaluateChecks(fixedObservations(golden), golden);
    assert.equal(byId(assertions, "a1").passed, true);
    assert.equal(byId(assertions, "a1").observed, "POST /api/subscription → 200");
    assert.equal(byId(signals, "f1").passed, false);
    assert.equal(byId(signals, "f1").observed_complete, true);
  });

  it("fails the 2xx assertion and matches the 5xx signal for a 500", () => {
    const { assertions, signals } = evaluateChecks(buggyObservations(golden), golden);
    assert.equal(byId(assertions, "a1").passed, false);
    assert.equal(byId(signals, "f1").passed, true);
    assert.equal(byId(signals, "f1").observed, "POST /api/subscription → 500");
  });

  it("uses the last matching response, ordered by timestamp then seq", () => {
    const retry = [response(1, 500, { timestamp_ms: EPOCH + 100 }), response(3, 200, { timestamp_ms: EPOCH + 200 }), response(2, 502, { timestamp_ms: EPOCH + 200 })];
    const { assertions } = evaluateChecks(buggyObservations(golden, { network: retry }), golden);
    assert.equal(byId(assertions, "a1").passed, true, "seq 3 wins the timestamp tie");
    assert.equal(byId(assertions, "a1").details.matches, 3);
  });

  it("ignores OPTIONS, other methods, setup traffic, cross-origin and post-window responses", () => {
    const network = [
      response(1, 500, { method: "OPTIONS" }),
      response(2, 500, { method: "GET" }),
      response(3, 500, { phase: "setup" }),
      response(4, 500, { same_origin: false, url: "https://evil.example/api/subscription" }),
      response(5, 500, { timestamp_ms: EPOCH + 5_001 }),
      response(6, 200, { timestamp_ms: EPOCH + 5_000 }),
    ];
    const { assertions, signals } = evaluateChecks(buggyObservations(golden, { network }), golden);
    assert.equal(byId(assertions, "a1").passed, true);
    assert.equal(byId(assertions, "a1").details.matches, 1);
    assert.equal(byId(signals, "f1").passed, false);
  });

  it("does not match an endpoint name found only in a query value or sibling path", () => {
    const network = [
      response(1, 500, { url: `${BASE}/api/audit?next=/api/subscription` }),
      response(2, 500, { url: `${BASE}/api/subscription-telemetry` }),
    ];
    const { assertions, signals } = evaluateChecks(buggyObservations(golden, { network }), golden);
    assert.equal(byId(assertions, "a1").observed, "no_matching_request");
    assert.equal(byId(signals, "f1").passed, false);
  });

  it("records no_matching_request as a measured failure when the window completed", () => {
    const outcome = byId(evaluateChecks(buggyObservations(golden, { network: [] }), golden).assertions, "a1");
    assert.equal(outcome.passed, false);
    assert.equal(outcome.observed_complete, true);
    assert.equal(outcome.observed, "no_matching_request");
  });

  it("does not treat an incomplete collection window as a measured result", () => {
    for (const network_window of [null, { ended_at_ms: 2_000, complete: false }]) {
      const outcome = byId(evaluateChecks(buggyObservations(golden, { network_window }), golden).signals, "f1");
      assert.equal(outcome.passed, false);
      assert.equal(outcome.observed_complete, false);
    }
  });
});

describe("element_visible / element_not_visible", () => {
  const notVisibleSpec = specWith({
    assertions: [{ id: "a3", type: "element_not_visible", role: "status", name: "Loading", within_ms: 1_000 }],
  });

  it("passes when the element becomes visible before the deadline", () => {
    const obs = baseObservations(golden, { probes: [probe("a2", "assertion", series(0, 5_000, (at) => element(at, at >= 4_950 ? 1 : 0, at >= 4_950)))] });
    assert.equal(byId(evaluateChecks(obs, golden).assertions, "a2").passed, true);
  });

  it("fails when it appears only after the deadline", () => {
    const samples = [...series(0, 5_000, (at) => element(at, 0, false)), element(5_060, 1, true)];
    const outcome = byId(evaluateChecks(baseObservations(golden, { probes: [probe("a2", "assertion", samples)] }), golden).assertions, "a2");
    assert.equal(outcome.passed, false);
    assert.equal(outcome.observed_complete, true);
  });

  it("is incomplete when no sample covers the deadline band", () => {
    const samples = [...series(0, 4_850, (at) => element(at, 0, false)), element(5_150, 0, false)];
    const outcome = byId(evaluateChecks(baseObservations(golden, { probes: [probe("a2", "assertion", samples)] }), golden).assertions, "a2");
    assert.equal(outcome.observed_complete, false);
    assert.match(outcome.observed, /deadline_not_sampled/);
  });

  it("treats multiple matching elements as ambiguous, never as a pass", () => {
    const samples = series(0, 5_000, (at) => element(at, 2, true));
    const outcome = byId(evaluateChecks(baseObservations(golden, { probes: [probe("a2", "assertion", samples)] }), golden).assertions, "a2");
    assert.equal(outcome.passed, false);
    assert.equal(outcome.observed_complete, false);
    assert.match(outcome.observed, /ambiguous_locator/);
  });

  it("element_not_visible passes on absence or hiding, fails while visible", () => {
    const run = (make: (at: number) => ReturnType<typeof element>) =>
      byId(evaluateChecks(baseObservations(notVisibleSpec, { probes: [probe("a3", "assertion", series(0, 1_000, make))] }), notVisibleSpec).assertions, "a3");
    assert.equal(run((at) => element(at, at >= 500 ? 0 : 1, at < 500)).passed, true);
    assert.equal(run((at) => element(at, 1, at < 500)).passed, true, "present but hidden counts");
    const visible = run((at) => element(at, 1, true));
    assert.equal(visible.passed, false);
    assert.equal(visible.observed_complete, true);
  });

  it("marks a missing or duplicated probe as not observed", () => {
    assert.equal(byId(evaluateChecks(baseObservations(golden), golden).assertions, "a2").observed_complete, false);
    const samples = series(0, 5_000, (at) => element(at, 1, true));
    const duplicated = baseObservations(golden, { probes: [probe("a2", "assertion", samples), probe("a2", "assertion", samples)] });
    assert.match(byId(evaluateChecks(duplicated, golden).assertions, "a2").observed, /probe_duplicated/);
  });
});

describe("url_contains and text_visible", () => {
  const spec = specWith({
    assertions: [
      { id: "u1", type: "url_contains", value: "/checkout", within_ms: 1_000 },
      { id: "t1", type: "text_visible", value: "Upgrade complete", within_ms: 1_000 },
    ],
  });

  it("matches the URL path and exact visible text within the window", () => {
    const obs = baseObservations(spec, {
      probes: [
        probe("u1", "assertion", series(0, 1_000, (at) => ({ at_ms: at, kind: "url", url: at >= 300 ? `${BASE}/checkout` : `${BASE}/settings/billing` }))),
        probe("t1", "assertion", series(0, 1_000, (at) => ({ at_ms: at, kind: "text", visible: at >= 600 }))),
      ],
    });
    const { assertions } = evaluateChecks(obs, spec);
    assert.equal(byId(assertions, "u1").passed, true);
    assert.equal(byId(assertions, "t1").passed, true);
  });

  it("does not match a URL fragment that only appears in the host or never loads", () => {
    const obs = baseObservations(spec, {
      probes: [
        probe("u1", "assertion", series(0, 1_000, (at) => ({ at_ms: at, kind: "url", url: `${BASE}/settings/billing` }))),
        probe("t1", "assertion", series(0, 1_000, (at) => ({ at_ms: at, kind: "text", visible: false }))),
      ],
    });
    const { assertions } = evaluateChecks(obs, spec);
    assert.equal(byId(assertions, "u1").passed, false);
    assert.equal(byId(assertions, "u1").observed_complete, true);
    assert.equal(byId(assertions, "t1").passed, false);
  });
});

describe("element_still_visible_after_ms", () => {
  const f2 = (samples: ReturnType<typeof element>[]) =>
    byId(evaluateChecks(buggyObservations(golden, { probes: [buggyObservations(golden).probes[0]!, probe("f2", "signal", samples)] }), golden).signals, "f2");

  it("matches when the spinner is still visible at the threshold sample", () => {
    assert.equal(f2(series(0, 5_000, (at) => element(at, 1, true))).passed, true);
  });

  it("measures persistence at the threshold, not at first appearance", () => {
    const cleared = series(0, 5_000, (at) => element(at, at < 2_000 ? 1 : 0, at < 2_000));
    const outcome = f2(cleared);
    assert.equal(outcome.passed, false);
    assert.equal(outcome.observed_complete, true);
  });

  it("accepts ordinary jitter inside the 100ms band", () => {
    assert.equal(f2([element(2_990, 0, false), element(3_099, 1, true)]).passed, true);
  });

  it("is incomplete when the only samples miss the band", () => {
    const outcome = f2([element(2_990, 1, true), element(3_101, 1, true)]);
    assert.equal(outcome.observed_complete, false);
    assert.match(outcome.observed, /threshold_not_sampled/);
  });

  it("does not match a spinner that appears only after the band", () => {
    const samples = [element(3_000, 0, false), element(3_050, 0, false), element(3_200, 1, true)];
    const outcome = f2(samples);
    assert.equal(outcome.passed, false);
    assert.equal(outcome.observed_complete, true);
  });
});
