import type { Assertion, FailureSignal, ReproSpec } from "../contracts/repro";
import { PROBE_PROTOCOL, type CheckOutcome, type NetworkEvent, type ProbeSample, type RunObservations } from "../contracts/run";

// Pure assertion engine: applies each check's predicate to recorded facts.
// A check whose facts are missing, incomplete, or ambiguous is reported with
// observed_complete=false; it is never treated as a pass or a measured absence.

type Check = { kind: "assertion"; check: Assertion } | { kind: "signal"; check: FailureSignal };

export type CheckResults = { assertions: CheckOutcome[]; signals: CheckOutcome[] };

const TOLERANCE = PROBE_PROTOCOL.toleranceMs;

export function evaluateChecks(observations: RunObservations, spec: ReproSpec): CheckResults {
  return {
    assertions: spec.assertions.map((check) => evaluate(observations, { kind: "assertion", check })),
    signals: spec.failure_signals.map((check) => evaluate(observations, { kind: "signal", check })),
  };
}

function evaluate(observations: RunObservations, { kind, check }: Check): CheckOutcome {
  const base = { id: check.id, kind, type: check.type, expected: describeExpected(check) };
  if (check.type === "network_status") return { ...base, ...evaluateNetwork(observations, check) };

  const probes = observations.probes.filter((probe) => probe.check_id === check.id && probe.check_kind === kind);
  if (probes.length !== 1) {
    return incomplete(base, probes.length === 0 ? "probe_missing" : "probe_duplicated");
  }
  const probe = probes[0]!;
  if (probe.error) return incomplete(base, `probe_error: ${probe.error}`);

  switch (check.type) {
    case "element_visible":
      return { ...base, ...withinWindow(probe.samples, "element", check.within_ms, (s) => s.match_count === 1 && s.visible) };
    case "element_not_visible":
      return {
        ...base,
        ...withinWindow(probe.samples, "element", check.within_ms, (s) => s.match_count === 0 || (s.match_count === 1 && !s.visible)),
      };
    case "text_visible":
      return { ...base, ...withinWindow(probe.samples, "text", check.within_ms, (s) => s.visible) };
    case "url_contains":
      return { ...base, ...withinWindow(probe.samples, "url", check.within_ms, (s) => pathOf(s.url).includes(check.value)) };
    case "element_still_visible_after_ms":
      return { ...base, ...afterThreshold(probe.samples, check.after_ms) };
  }
}

type Evaluated = Omit<CheckOutcome, "id" | "kind" | "type" | "expected">;

function incomplete(base: Pick<CheckOutcome, "id" | "kind" | "type" | "expected">, reason: string): CheckOutcome {
  return { ...base, passed: false, observed_complete: false, observed: `not_observed (${reason})`, details: { reason } };
}

function evaluateNetwork(
  observations: RunObservations,
  check: Extract<Assertion | FailureSignal, { type: "network_status" }>,
): Evaluated {
  const window = observations.network_window;
  const epoch = observations.probe_epoch_ms;
  if (!window || epoch === null || !window.complete) {
    const reason = "network_window_incomplete";
    return { passed: false, observed_complete: false, observed: `not_observed (${reason})`, details: { reason } };
  }
  const cutoff = epoch + window.ended_at_ms;
  const matching = observations.network
    .filter((event) => isCandidate(event, check.method, check.url_contains, cutoff))
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms || a.seq - b.seq);
  const last = matching.at(-1);
  if (!last) {
    return { passed: false, observed_complete: true, observed: "no_matching_request", details: { matches: 0, cutoff_ms: cutoff } };
  }
  return {
    passed: last.status >= check.min && last.status <= check.max,
    observed_complete: true,
    observed: `${last.method} ${pathOf(last.url)} → ${last.status}`,
    details: { matches: matching.length, last_seq: last.seq, last_status: last.status, last_timestamp_ms: last.timestamp_ms, cutoff_ms: cutoff },
  };
}

function isCandidate(event: NetworkEvent, method: string, urlContains: string, cutoff: number): boolean {
  const eventMethod = event.method.toUpperCase();
  return (
    event.phase === "experiment" &&
    event.same_origin &&
    eventMethod !== "OPTIONS" &&
    eventMethod === method &&
    matchesNetworkTarget(event.url, urlContains) &&
    event.timestamp_ms <= cutoff
  );
}

/** Match a declared request target, never an arbitrary substring in a host, query value, or sibling path. */
export function matchesNetworkTarget(url: string, target: string): boolean {
  try {
    const actual = new URL(url);
    const expected = new URL(target, "https://caseclosed.invalid");
    if (expected.search) return `${actual.pathname}${actual.search}` === `${expected.pathname}${expected.search}`;
    return actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

type SampleOf<K extends ProbeSample["kind"]> = Extract<ProbeSample, { kind: K }>;

/**
 * `within_ms` checks: a qualifying sample at or before the deadline passes.
 * A failure needs a completion sample taken in [deadline, deadline + tolerance].
 */
function withinWindow<K extends ProbeSample["kind"]>(
  samples: ProbeSample[],
  kind: K,
  deadlineMs: number,
  qualifies: (sample: SampleOf<K>) => boolean,
): Evaluated {
  if (samples.some((sample) => sample.kind !== kind)) return incompleteResult("sample_kind_mismatch");
  const typed = (samples as SampleOf<K>[]).filter((sample) => sample.at_ms <= deadlineMs + TOLERANCE);
  const ambiguous = (typed as ProbeSample[]).find((sample) => sample.kind === "element" && sample.match_count > 1);
  if (ambiguous?.kind === "element") return incompleteResult(`ambiguous_locator: ${ambiguous.match_count} matches`);

  const hit = typed.find((sample) => sample.at_ms <= deadlineMs && qualifies(sample));
  if (hit) {
    return { passed: true, observed_complete: true, observed: `${describeSample(hit)} at ${hit.at_ms}ms`, details: { sample: hit } };
  }
  const completion = typed.find((sample) => sample.at_ms >= deadlineMs);
  if (!completion) return incompleteResult("deadline_not_sampled");
  const lastBeforeDeadline = typed.filter((sample) => sample.at_ms <= deadlineMs).at(-1) ?? completion;
  return {
    passed: false,
    observed_complete: true,
    observed: `${describeSample(lastBeforeDeadline)} at ${lastBeforeDeadline.at_ms}ms (checked until ${completion.at_ms}ms)`,
    details: { samples: typed.length, completion_sample: completion },
  };
}

/** Persistence signal: measured at the first sample in [after_ms, after_ms + tolerance]. */
function afterThreshold(samples: ProbeSample[], afterMs: number): Evaluated {
  if (samples.some((sample) => sample.kind !== "element")) return incompleteResult("sample_kind_mismatch");
  const band = (samples as SampleOf<"element">[])
    .filter((sample) => sample.at_ms >= afterMs && sample.at_ms <= afterMs + TOLERANCE)
    .sort((a, b) => a.at_ms - b.at_ms);
  const sample = band[0];
  if (!sample) return incompleteResult("threshold_not_sampled");
  if (sample.match_count > 1) return incompleteResult(`ambiguous_locator: ${sample.match_count} matches`);
  return {
    passed: sample.match_count === 1 && sample.visible,
    observed_complete: true,
    observed: `${describeSample(sample)} at ${sample.at_ms}ms`,
    details: { sample },
  };
}

function incompleteResult(reason: string): Evaluated {
  return { passed: false, observed_complete: false, observed: `not_observed (${reason})`, details: { reason } };
}

function describeSample(sample: ProbeSample): string {
  switch (sample.kind) {
    case "element":
      if (sample.match_count === 0) return "absent";
      return sample.visible ? "visible" : "present but hidden";
    case "text":
      return sample.visible ? "text visible" : "text not visible";
    case "url":
      return `url ${pathOf(sample.url)}`;
  }
}

function describeExpected(check: Assertion | FailureSignal): string {
  switch (check.type) {
    case "network_status":
      return `last ${check.method} *${check.url_contains}* status in [${check.min}, ${check.max}]`;
    case "element_visible":
      return `${check.role} "${check.name}" visible within ${check.within_ms}ms`;
    case "element_not_visible":
      return `${check.role} "${check.name}" absent or hidden within ${check.within_ms}ms`;
    case "url_contains":
      return `URL contains "${check.value}" within ${check.within_ms}ms`;
    case "text_visible":
      return `text "${check.value}" visible within ${check.within_ms}ms`;
    case "element_still_visible_after_ms":
      return `${check.role} "${check.name}" still visible after ${check.after_ms}ms`;
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
