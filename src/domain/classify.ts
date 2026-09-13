import type { ReproductionResult, VerificationResult } from "../contracts/lifecycle";
import type { ReproSpec, ResolvedPlan } from "../contracts/repro";
import {
  PROBE_PROTOCOL,
  REPRODUCTION_BUDGETS,
  START_STEP_ID,
  type ReproductionRunResult,
  type RunObservations,
  type VerificationRunResult,
} from "../contracts/run";
import { evaluateChecks, matchesNetworkTarget } from "./assertions";
import { canonicalJson, sha256Hash } from "./identity";

// Reproduction truth table (docs/REPROSPEC.md), evaluated in order:
//   1. infrastructure error or invalid/incomplete experiment → INCONCLUSIVE
//   2. ≥1 signal matched and ≥1 assertion failed             → REPRODUCED
//   3. 0 signals matched and all assertions passed           → NOT_REPRODUCED
//   4. anything else (mixed evidence)                        → INCONCLUSIVE
// Pure: no I/O, no model. Totals derive from the frozen spec.

export function classifyReproduction(observations: RunObservations, spec: ReproSpec): ReproductionRunResult {
  const { assertions, signals } = evaluateChecks(observations, spec);
  const assertionsPassed = assertions.filter((outcome) => outcome.passed).length;
  const signalsMatched = signals.filter((outcome) => outcome.passed).length;
  const common = {
    assertions,
    signals,
    assertions_passed: assertionsPassed,
    assertions_total: spec.assertions.length,
    signals_matched: signalsMatched,
    plan_recovered: observations.plan_recovered,
    model_calls: observations.model_calls,
  };

  if (observations.infra_error) {
    return {
      ...common,
      result: "INCONCLUSIVE",
      infra_error: true,
      infra_error_reason: observations.infra_error_reason ?? "observations_incomplete",
      ...(observations.infra_error_detail ? { infra_error_detail: observations.infra_error_detail } : {}),
    };
  }

  const integrity = experimentIntegrityIssues(observations, spec, "reproduction");
  const unobserved = [...assertions, ...signals].filter((outcome) => !outcome.observed_complete);
  if (integrity.hashMismatch || integrity.issues.length > 0 || unobserved.length > 0) {
    const detail = [...integrity.issues, ...unobserved.map((outcome) => `${outcome.kind} ${outcome.id}: ${outcome.observed}`)];
    return {
      ...common,
      result: "INCONCLUSIVE",
      infra_error: true,
      infra_error_reason: integrity.hashMismatch ? "environment_changed" : "observations_incomplete",
      infra_error_detail: detail.join("; "),
    };
  }

  let result: ReproductionResult = "INCONCLUSIVE";
  if (signalsMatched >= 1 && assertionsPassed < spec.assertions.length) result = "REPRODUCED";
  else if (signalsMatched === 0 && assertionsPassed === spec.assertions.length) result = "NOT_REPRODUCED";
  return { ...common, result, infra_error: false };
}

export function classifyVerification(
  observations: RunObservations,
  spec: ReproSpec,
  plan: ResolvedPlan,
  expectedCommitSha: string,
): VerificationRunResult {
  const { assertions, signals } = evaluateChecks(observations, spec);
  const assertionsPassed = assertions.filter((outcome) => outcome.passed).length;
  const signalsMatched = signals.filter((outcome) => outcome.passed).length;
  const common = {
    assertions,
    signals,
    assertions_passed: assertionsPassed,
    assertions_total: spec.assertions.length,
    signals_matched: signalsMatched,
    plan_recovered: observations.plan_recovered,
    model_calls: observations.model_calls,
  };

  if (observations.infra_error) {
    return {
      ...common,
      result: "INCONCLUSIVE",
      infra_error: true,
      infra_error_reason: observations.infra_error_reason ?? "observations_incomplete",
      ...(observations.infra_error_detail ? { infra_error_detail: observations.infra_error_detail } : {}),
    };
  }

  const integrity = experimentIntegrityIssues(observations, spec, "verification", plan, expectedCommitSha);
  const unobserved = [...assertions, ...signals].filter((outcome) => !outcome.observed_complete);
  if (integrity.hashMismatch || integrity.issues.length > 0 || unobserved.length > 0) {
    const detail = [...integrity.issues, ...unobserved.map((outcome) => `${outcome.kind} ${outcome.id}: ${outcome.observed}`)];
    return {
      ...common,
      result: "INCONCLUSIVE",
      infra_error: true,
      infra_error_reason: integrity.hashMismatch ? "environment_changed" : "observations_incomplete",
      infra_error_detail: detail.join("; "),
    };
  }

  const result: VerificationResult = signalsMatched === 0 && assertionsPassed === spec.assertions.length ? "VERIFIED_FIXED" : "STILL_BROKEN";
  return { ...common, result, infra_error: false };
}

function experimentIntegrityIssues(
  observations: RunObservations,
  spec: ReproSpec,
  runType: "reproduction" | "verification",
  plan?: ResolvedPlan,
  expectedCommitSha?: string,
): { hashMismatch: boolean; issues: string[] } {
  const issues: string[] = [];
  const hashMismatch = observations.spec_hash !== sha256Hash(spec) || observations.app_context_hash !== spec.app_context_hash;
  if (hashMismatch) issues.push("observations were recorded for a different spec or AppContext");
  if (observations.run_type !== runType) issues.push(`run_type ${observations.run_type} is not ${runType}`);
  if (observations.probe_epoch_ms === null) issues.push("probe epoch was never set");
  if (observations.health_before && observations.health_after && observations.health_before.commit_sha !== observations.health_after.commit_sha) {
    issues.push("staging deployment changed during the run");
  }

  const requiredWindowMs = Math.max(
    PROBE_PROTOCOL.minCollectionWindowMs,
    ...spec.assertions.map((check) => ("within_ms" in check ? check.within_ms : 0)),
    ...spec.failure_signals.map((check) => ("within_ms" in check ? check.within_ms : "after_ms" in check ? check.after_ms : 0)),
  );
  if (!observations.network_window?.complete || observations.network_window.ended_at_ms < requiredWindowMs) {
    issues.push(`network window did not complete the required ${requiredWindowMs}ms`);
  }
  if (observations.duration_ms > REPRODUCTION_BUDGETS.maxRunDurationMs) issues.push("run duration exceeded its budget");
  if (observations.budgets_used.actions > REPRODUCTION_BUDGETS.maxBrowserActions) issues.push("action budget was exceeded");
  if (observations.budgets_used.replans > REPRODUCTION_BUDGETS.maxReplans) issues.push("replan budget was exceeded");
  if (observations.budgets_used.actions !== observations.actions.length) issues.push("action budget count differs from the action log");
  const actionSeqs = new Set<number>();
  for (const [index, action] of observations.actions.entries()) {
    if (!Number.isInteger(action.seq) || action.seq <= 0 || actionSeqs.has(action.seq)) issues.push("action log has invalid or duplicate sequence numbers");
    if (action.seq !== index + 1) issues.push("action log is not in contiguous sequence order");
    actionSeqs.add(action.seq);
    if (
      !Number.isFinite(action.started_at_ms) ||
      !Number.isFinite(action.finished_at_ms) ||
      action.started_at_ms < 0 ||
      action.finished_at_ms < action.started_at_ms ||
      action.finished_at_ms > observations.duration_ms
    ) {
      issues.push(`action ${action.seq} has invalid timing`);
    }
  }

  if (runType === "reproduction") {
    if (observations.plan_recovered) issues.push("plan recovery is not valid for reproduction");
    if (observations.plan_hash !== null) issues.push("reproduction observations unexpectedly contain a plan hash");
    const successful = observations.actions.filter((action) => action.ok);
    const successfulSteps = successful.map((action) => action.step_id);
    if (successfulSteps.join("\0") !== [START_STEP_ID, ...spec.steps.map((step) => step.id)].join("\0")) {
      issues.push("successful action log does not contain the start navigation and every spec step in order");
    }
    const start = successful[0];
    if (!start || start.action.type !== "goto" || start.action.path !== spec.environment.start_path) {
      issues.push("start navigation differs from the ReproSpec");
    }
    if (observations.model_calls !== spec.steps.length + observations.budgets_used.replans) {
      issues.push("model-call count is inconsistent with completed step resolution");
    }
  } else {
    if (!plan) issues.push("verification has no resolved plan");
    if (observations.plan_recovered) issues.push("verification recovery is disabled");
    if (observations.model_calls !== 0) issues.push("verification made model calls");
    if (observations.budgets_used.replans !== 0) issues.push("verification used a replan");
    if (observations.actions.some((action) => action.resolution !== "runner")) issues.push("verification action log contains model resolution");
    if (plan && observations.plan_hash !== sha256Hash(plan)) issues.push("verification plan hash does not match the saved plan");
    if (!observations.health_before || !observations.health_after) issues.push("verification health evidence is incomplete");
    if (expectedCommitSha && observations.health_before?.commit_sha !== expectedCommitSha) issues.push("pre-run deployment SHA does not match the fix attempt");
    if (expectedCommitSha && observations.health_after?.commit_sha !== expectedCommitSha) issues.push("post-run deployment SHA does not match the fix attempt");
    if (plan) {
      const successful = observations.actions.filter((action) => action.ok);
      if (successful.length !== plan.actions.length + 1) {
        issues.push("verification did not execute exactly the saved plan");
      } else {
        const start = successful[0]!;
        if (start.step_id !== START_STEP_ID || start.action.type !== "goto" || start.action.path !== spec.environment.start_path) {
          issues.push("verification start navigation differs from the ReproSpec");
        }
        for (const [index, planned] of plan.actions.entries()) {
          const actual = successful[index + 1];
          if (!actual || actual.step_id !== planned.step_id || canonicalJson(actual.action) !== canonicalJson(planned.action)) {
            issues.push(`verification action ${index + 1} differs from the saved plan`);
          }
        }
      }
      if (observations.actions.some((action) => !action.ok)) issues.push("verification contains an unsuccessful action attempt");
    }
  }

  const expectedSteps = spec.steps.map((step) => step.id);
  if (observations.steps_completed.join("\x00") !== expectedSteps.join("\x00")) {
    issues.push(`steps completed [${observations.steps_completed.join(", ")}] differ from spec [${expectedSteps.join(", ")}]`);
  }

  const probeKeys = observations.probes.map((probe) => `${probe.check_kind}:${probe.check_id}`);
  const expectedKeys = new Set([
    ...spec.assertions.filter((c) => c.type !== "network_status").map((c) => `assertion:${c.id}`),
    ...spec.failure_signals.filter((c) => c.type !== "network_status").map((c) => `signal:${c.id}`),
  ]);
  for (const key of probeKeys) {
    if (!expectedKeys.has(key)) issues.push(`unexpected probe ${key}`);
  }
  for (const probe of observations.probes) {
    let previous = -1;
    for (const sample of probe.samples) {
      if (!Number.isFinite(sample.at_ms) || sample.at_ms < 0 || sample.at_ms <= previous) {
        issues.push(`${probe.check_kind} ${probe.check_id} has invalid or unordered sample times`);
        break;
      }
      if (sample.kind === "element" && (!Number.isInteger(sample.match_count) || sample.match_count < 0)) {
        issues.push(`${probe.check_kind} ${probe.check_id} has an invalid element match count`);
      }
      previous = sample.at_ms;
    }
  }

  const networkSeqs = new Set<number>();
  for (const event of observations.network) {
    if (!Number.isInteger(event.seq) || event.seq <= 0 || networkSeqs.has(event.seq)) issues.push("network log has invalid or duplicate sequence numbers");
    networkSeqs.add(event.seq);
    if (!Number.isFinite(event.timestamp_ms) || event.timestamp_ms < 0 || event.timestamp_ms > observations.duration_ms) {
      issues.push(`network event ${event.seq} has invalid timing`);
    }
    if (!Number.isInteger(event.status) || event.status < 100 || event.status > 599) issues.push(`network event ${event.seq} has invalid status`);
    if (typeof event.same_origin !== "boolean" || (event.phase !== "setup" && event.phase !== "experiment")) {
      issues.push(`network event ${event.seq} lacks trustworthy origin or phase provenance`);
    }
  }

  const failureSeqs = new Set<number>();
  for (const failure of observations.request_failures) {
    if (!Number.isInteger(failure.seq) || failure.seq <= 0 || failureSeqs.has(failure.seq)) issues.push("request-failure log has invalid or duplicate sequence numbers");
    failureSeqs.add(failure.seq);
    if (!Number.isFinite(failure.timestamp_ms) || failure.timestamp_ms < 0 || failure.timestamp_ms > observations.duration_ms) {
      issues.push(`request failure ${failure.seq} has invalid timing`);
    }
    if (typeof failure.same_origin !== "boolean" || (failure.phase !== "setup" && failure.phase !== "experiment")) {
      issues.push(`request failure ${failure.seq} lacks trustworthy origin or phase provenance`);
    }
  }

  const networkChecks = [...spec.assertions, ...spec.failure_signals].filter(
    (check): check is Extract<(typeof spec.assertions)[number] | (typeof spec.failure_signals)[number], { type: "network_status" }> =>
      check.type === "network_status",
  );
  const cutoff = observations.probe_epoch_ms === null || !observations.network_window
    ? -1
    : observations.probe_epoch_ms + observations.network_window.ended_at_ms;
  const failedTarget = observations.request_failures.find((failure) =>
    failure.phase === "experiment" &&
    failure.same_origin &&
    failure.method.toUpperCase() !== "OPTIONS" &&
    failure.timestamp_ms <= cutoff &&
    networkChecks.some((check) => failure.method.toUpperCase() === check.method && matchesNetworkTarget(failure.url, check.url_contains)),
  );
  if (failedTarget) issues.push(`target request failed without a response: ${failedTarget.method} ${failedTarget.url}`);
  return { hashMismatch, issues };
}
