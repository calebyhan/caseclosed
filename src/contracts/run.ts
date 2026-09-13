import type { InfraErrorReason, ReproductionResult, RunType, VerificationResult } from "./lifecycle";
import type { BrowserAction } from "./repro";

// Facts emitted by the browser runner and the pure verdict computed from them
// (IMPLEMENTATION_PLAN §3.4). The collector records facts; the assertion
// engine applies predicates. All `*_ms` times share one run-relative clock.

/** Reproduction budgets. Exceeding any of them makes the run INCONCLUSIVE. */
export const REPRODUCTION_BUDGETS = {
  maxBrowserActions: 15,
  maxReplans: 1,
  maxRunDurationMs: 45_000,
  actionTimeoutMs: 5_000,
  modelCallTimeoutMs: 20_000,
} as const;

/** Probe protocol constants, identical for reproduction and verification. */
export const PROBE_PROTOCOL = {
  cadenceMs: 50,
  /** A deadline/threshold sample must start within this band after its target time. */
  toleranceMs: 100,
  minCollectionWindowMs: 5_000,
} as const;

/** Step id recorded for the runner's own start navigation. */
export const START_STEP_ID = "__start__";

export type NetworkEvent = {
  seq: number;
  method: string;
  url: string;
  status: number;
  /** Response arrival, run-relative. */
  timestamp_ms: number;
  same_origin: boolean;
  /** `setup` responses precede the first planned action and never match checks. */
  phase: "setup" | "experiment";
};

export type RequestFailure = {
  seq: number;
  method: string;
  url: string;
  error: string;
  timestamp_ms: number;
  same_origin: boolean;
  phase: "setup" | "experiment";
};

export type ConsoleEvent = { seq: number; level: string; text: string; timestamp_ms: number };

export type ActionResolution = "runner" | "model" | "replan";

export type LocatorStrategy = "role";

export type ActionRecord = {
  seq: number;
  step_id: string;
  action: BrowserAction;
  resolution: ActionResolution;
  ok: boolean;
  /** `not_executed`: the target was never interacted with, so a replan is safe. */
  failure?: "not_executed" | "uncertain";
  error?: string;
  locator_used?: LocatorStrategy;
  started_at_ms: number;
  finished_at_ms: number;
};

export type ProbeSample =
  | { at_ms: number; kind: "element"; match_count: number; visible: boolean }
  | { at_ms: number; kind: "text"; visible: boolean }
  | { at_ms: number; kind: "url"; url: string };

export type ProbeObservation = {
  check_id: string;
  check_kind: "assertion" | "signal";
  samples: ProbeSample[];
  error?: string;
};

export type RunObservations = {
  run_type: RunType;
  spec_hash: string;
  app_context_hash: string;
  plan_hash: string | null;
  health_before: { commit_sha: string } | null;
  health_after: { commit_sha: string } | null;
  duration_ms: number;
  actions: ActionRecord[];
  /** Spec step ids completed successfully, in execution order. */
  steps_completed: string[];
  network: NetworkEvent[];
  request_failures: RequestFailure[];
  console: ConsoleEvent[];
  /** Set immediately after the last planned action completes. */
  probe_epoch_ms: number | null;
  probes: ProbeObservation[];
  /** Network matching window, relative to the probe epoch. */
  network_window: { ended_at_ms: number; complete: boolean } | null;
  final_url: string | null;
  infra_error: boolean;
  infra_error_reason?: InfraErrorReason;
  infra_error_detail?: string;
  plan_recovered: boolean;
  model_calls: number;
  budgets_used: { actions: number; replans: number };
};

export type CheckOutcome = {
  id: string;
  kind: "assertion" | "signal";
  type: string;
  /** Assertion: passed. Signal: matched. False whenever not observed. */
  passed: boolean;
  /** False when the facts could not establish a result (missing/incomplete/ambiguous). */
  observed_complete: boolean;
  expected: string;
  observed: string;
  details: Record<string, unknown>;
};

export type ReproductionRunResult = {
  result: ReproductionResult;
  assertions: CheckOutcome[];
  signals: CheckOutcome[];
  assertions_passed: number;
  assertions_total: number;
  signals_matched: number;
  infra_error: boolean;
  infra_error_reason?: InfraErrorReason;
  infra_error_detail?: string;
  plan_recovered: boolean;
  model_calls: number;
};

export type VerificationRunResult = Omit<ReproductionRunResult, "result"> & { result: VerificationResult };
