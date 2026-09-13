import type {
  CaseStatus,
  ReproductionResult,
  RunType,
  SpecFailureKind,
  VerificationResult,
} from "../contracts/lifecycle";

// Pure lifecycle rules (docs/STATE_MACHINE.md, with the IMPLEMENTATION_PLAN
// correction that STILL_BROKEN returns to WAITING_FOR_FIX once finalized).
// No I/O: callers build a CaseSnapshot from persisted facts.

type EventBase = { case_id: string; event_key: string };

export type CaseEvent =
  | (EventBase & { type: "spec_created"; spec_id: string })
  | (EventBase & { type: "spec_failed"; kind: SpecFailureKind })
  | (EventBase & { type: "reproduction_claimed"; run_id: string })
  | (EventBase & { type: "reproduction_completed"; run_id: string; result: ReproductionResult })
  | (EventBase & { type: "issue_confirmed"; linear_issue_id: string })
  | (EventBase & { type: "await_fix" })
  | (EventBase & { type: "fix_merged"; attempt_id: string; commit_sha: string })
  | (EventBase & { type: "await_deployment"; attempt_id: string })
  | (EventBase & { type: "deployment_ready"; attempt_id: string; commit_sha: string })
  | (EventBase & {
      type: "verification_completed";
      run_id: string;
      attempt_id: string;
      result: VerificationResult;
    })
  | (EventBase & { type: "verification_retry"; retry_of_run_id: string });

export type CaseEventType = CaseEvent["type"];

/** Persisted facts the semantic guards depend on. */
export type CaseSnapshot = {
  id: string;
  status: CaseStatus;
  specId: string | null;
  plan: { id: string; sourceRunId: string } | null;
  linearIssueId: string | null;
  currentAttempt: { id: string; commitSha: string } | null;
  /** The case's run currently in `running` status, if any. */
  activeRun: { id: string; runType: RunType; attemptId: string | null } | null;
  /** Most recently completed verification run, if any. */
  latestVerification: { id: string; result: VerificationResult; attemptId: string } | null;
};

export type TransitionDecision =
  | { accepted: true; from: CaseStatus; next: CaseStatus; trigger: string }
  | { accepted: false; from: CaseStatus; reason: string };

type TransitionRule = { from: CaseStatus; to: CaseStatus; event: CaseEventType; trigger: string };

/** The only allowed (from, to) pairs, each bound to the event that may cause it. */
export const TRANSITIONS: readonly TransitionRule[] = [
  { from: "RECEIVED", to: "SPEC_CREATED", event: "spec_created", trigger: "valid ReproSpec persisted" },
  { from: "RECEIVED", to: "SPEC_FAILED", event: "spec_failed", trigger: "sufficient: false, or validation failed 3×" },
  { from: "SPEC_CREATED", to: "REPRODUCING", event: "reproduction_claimed", trigger: "worker claims reproduction job" },
  { from: "REPRODUCING", to: "REPRODUCED", event: "reproduction_completed", trigger: "truth table rule 2" },
  { from: "REPRODUCING", to: "NOT_REPRODUCED", event: "reproduction_completed", trigger: "truth table rule 3" },
  { from: "REPRODUCING", to: "REPRO_INCONCLUSIVE", event: "reproduction_completed", trigger: "truth table rule 1 or 4" },
  { from: "REPRODUCED", to: "ISSUE_FILED", event: "issue_confirmed", trigger: "Linear issue created idempotently" },
  { from: "ISSUE_FILED", to: "WAITING_FOR_FIX", event: "await_fix", trigger: "issue ID persisted" },
  { from: "WAITING_FOR_FIX", to: "FIX_MERGED", event: "fix_merged", trigger: "associated PR merged" },
  { from: "FIX_MERGED", to: "WAITING_FOR_DEPLOYMENT", event: "await_deployment", trigger: "merge commit SHA persisted" },
  {
    from: "WAITING_FOR_DEPLOYMENT",
    to: "VERIFYING",
    event: "deployment_ready",
    trigger: "deployment-ready accepted for the expected SHA",
  },
  { from: "VERIFYING", to: "VERIFIED_FIXED", event: "verification_completed", trigger: "verification truth table rule 2" },
  { from: "VERIFYING", to: "STILL_BROKEN", event: "verification_completed", trigger: "verification truth table rule 3" },
  {
    from: "VERIFYING",
    to: "VERIFICATION_INCONCLUSIVE",
    event: "verification_completed",
    trigger: "verification truth table rule 1",
  },
  {
    from: "STILL_BROKEN",
    to: "WAITING_FOR_FIX",
    event: "await_fix",
    trigger: "verification finalized; waiting for another fix",
  },
  {
    from: "VERIFICATION_INCONCLUSIVE",
    to: "WAITING_FOR_DEPLOYMENT",
    event: "verification_retry",
    trigger: "operator or CI retries",
  },
];

export function isTransitionAllowed(from: CaseStatus, to: CaseStatus): boolean {
  return TRANSITIONS.some((rule) => rule.from === from && rule.to === to);
}

const REPRODUCTION_TARGET: Record<ReproductionResult, CaseStatus> = {
  REPRODUCED: "REPRODUCED",
  NOT_REPRODUCED: "NOT_REPRODUCED",
  INCONCLUSIVE: "REPRO_INCONCLUSIVE",
};

const VERIFICATION_TARGET: Record<VerificationResult, CaseStatus> = {
  VERIFIED_FIXED: "VERIFIED_FIXED",
  STILL_BROKEN: "STILL_BROKEN",
  INCONCLUSIVE: "VERIFICATION_INCONCLUSIVE",
};

/** Target status for an event given the current status (only await_fix depends on it). */
function targetFor(event: CaseEvent): CaseStatus {
  switch (event.type) {
    case "spec_created":
      return "SPEC_CREATED";
    case "spec_failed":
      return "SPEC_FAILED";
    case "reproduction_claimed":
      return "REPRODUCING";
    case "reproduction_completed":
      return REPRODUCTION_TARGET[event.result];
    case "issue_confirmed":
      return "ISSUE_FILED";
    case "await_fix":
      return "WAITING_FOR_FIX";
    case "fix_merged":
      return "FIX_MERGED";
    case "await_deployment":
      return "WAITING_FOR_DEPLOYMENT";
    case "deployment_ready":
      return "VERIFYING";
    case "verification_completed":
      return VERIFICATION_TARGET[event.result];
    case "verification_retry":
      return "WAITING_FOR_DEPLOYMENT";
  }
}

/** Event-specific facts that must hold in addition to the (from, to) pair. */
function semanticGuard(state: CaseSnapshot, event: CaseEvent): string | null {
  switch (event.type) {
    case "spec_created":
      return state.specId === event.spec_id ? null : "spec_not_persisted_for_case";
    case "spec_failed":
      return state.specId === null ? null : "spec_already_persisted";
    case "reproduction_claimed":
      if (state.specId === null) return "no_valid_spec";
      return state.activeRun?.id === event.run_id && state.activeRun.runType === "reproduction"
        ? null
        : "reproduction_run_not_active";
    case "reproduction_completed":
      if (state.activeRun?.id !== event.run_id || state.activeRun.runType !== "reproduction") {
        return "stale_or_unknown_reproduction_run";
      }
      if (event.result === "REPRODUCED" && state.plan?.sourceRunId !== event.run_id) {
        return "resolved_plan_not_promoted_from_run";
      }
      return null;
    case "issue_confirmed":
      return state.linearIssueId !== null && state.linearIssueId === event.linear_issue_id
        ? null
        : "linear_issue_not_persisted";
    case "await_fix":
      return null;
    case "fix_merged":
    case "deployment_ready":
      if (state.currentAttempt?.id !== event.attempt_id) return "fix_attempt_not_current";
      if (state.currentAttempt.commitSha !== event.commit_sha) return "commit_sha_mismatch";
      if (event.type === "deployment_ready" && state.plan === null) return "no_resolved_plan";
      return null;
    case "await_deployment":
      return state.currentAttempt?.id === event.attempt_id ? null : "fix_attempt_not_current";
    case "verification_completed":
      if (state.activeRun?.id !== event.run_id || state.activeRun.runType !== "verification") {
        return "stale_or_unknown_verification_run";
      }
      if (state.activeRun.attemptId !== event.attempt_id || state.currentAttempt?.id !== event.attempt_id) {
        return "verification_run_for_stale_attempt";
      }
      return null;
    case "verification_retry":
      return state.latestVerification?.id === event.retry_of_run_id &&
        state.latestVerification.result === "INCONCLUSIVE"
        ? null
        : "retry_predecessor_not_latest_inconclusive_run";
  }
}

export function decideTransition(state: CaseSnapshot, event: CaseEvent): TransitionDecision {
  const from = state.status;
  if (event.case_id !== state.id) {
    return { accepted: false, from, reason: "event_case_mismatch" };
  }
  const to = targetFor(event);
  const rule = TRANSITIONS.find((candidate) => candidate.from === from && candidate.to === to);
  if (!rule || rule.event !== event.type) {
    return { accepted: false, from, reason: `invalid_transition: ${from} -> ${to} via ${event.type}` };
  }
  const guardFailure = semanticGuard(state, event);
  if (guardFailure) {
    return { accepted: false, from, reason: guardFailure };
  }
  return { accepted: true, from, next: to, trigger: rule.trigger };
}
