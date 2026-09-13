import { z } from "zod";

export const CaseStatus = z.enum([
  "RECEIVED",
  "SPEC_CREATED",
  "SPEC_FAILED",
  "REPRODUCING",
  "REPRODUCED",
  "NOT_REPRODUCED",
  "REPRO_INCONCLUSIVE",
  "ISSUE_FILED",
  "WAITING_FOR_FIX",
  "FIX_MERGED",
  "WAITING_FOR_DEPLOYMENT",
  "VERIFYING",
  "VERIFIED_FIXED",
  "STILL_BROKEN",
  "VERIFICATION_INCONCLUSIVE",
]);
export type CaseStatus = z.infer<typeof CaseStatus>;

/** Statuses with no outgoing transition in the MVP. */
export const TERMINAL_STATUSES: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  "SPEC_FAILED",
  "NOT_REPRODUCED",
  "REPRO_INCONCLUSIVE",
  "VERIFIED_FIXED",
]);

export const RunType = z.enum(["reproduction", "verification"]);
export type RunType = z.infer<typeof RunType>;

export const RunStatus = z.enum(["queued", "running", "completed"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const ReproductionResult = z.enum(["REPRODUCED", "NOT_REPRODUCED", "INCONCLUSIVE"]);
export type ReproductionResult = z.infer<typeof ReproductionResult>;

export const VerificationResult = z.enum(["VERIFIED_FIXED", "STILL_BROKEN", "INCONCLUSIVE"]);
export type VerificationResult = z.infer<typeof VerificationResult>;

export type RunResultValue = ReproductionResult | VerificationResult;

export const InfraErrorReason = z.enum([
  "fixture_reset_failed",
  "staging_unreachable",
  "browser_crashed",
  "auth_failed",
  "action_budget_exhausted",
  "duration_budget_exhausted",
  "step_unresolvable",
  "plan_recovery_failed",
  "worker_interrupted",
  "environment_changed",
  "deployment_changed",
  "observations_incomplete",
  "evidence_write_failed",
]);
export type InfraErrorReason = z.infer<typeof InfraErrorReason>;

export const SpecFailureKind = z.enum(["insufficient", "validation_failed"]);
export type SpecFailureKind = z.infer<typeof SpecFailureKind>;

export const JobType = z.enum(["generate_spec", "reproduce", "verify", "deliver_effect"]);
export type JobType = z.infer<typeof JobType>;

export const BROWSER_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>(["reproduce", "verify"]);

export const JobStatus = z.enum(["pending", "running", "completed", "failed"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const SideEffectStatus = z.enum(["pending", "sending", "unknown", "completed", "failed"]);
export type SideEffectStatus = z.infer<typeof SideEffectStatus>;

/** Spec generation permits the initial call plus two retries. */
export const SPEC_GENERATION_CALL_BUDGET = 3;

// ---------------------------------------------------------------------------
// Read-only case detail DTO served by GET /api/cases/:id and the case page.
// ---------------------------------------------------------------------------

export type TimelineEntry =
  | {
      kind: "transition";
      id: number;
      at: number;
      from: CaseStatus | null;
      to: CaseStatus;
      event_type: string;
      event_key: string;
      trigger: string;
    }
  | {
      kind: "rejected";
      id: number;
      at: number;
      event_type: string;
      event_key: string | null;
      from_status: CaseStatus | null;
      reason: string;
    };

export type CaseDetail = {
  case: {
    id: string;
    status: CaseStatus;
    terminal: boolean;
    report: string;
    environment_id: string;
    source: {
      type: string;
      team_id: string;
      channel_id: string;
      user_id: string;
      trigger_id: string;
      thread_ts: string | null;
    };
    spec_failure: { kind: SpecFailureKind; reasons: string[] } | null;
    created_at: number;
    updated_at: number;
  };
  timeline: TimelineEntry[];
  spec: {
    id: string;
    version: string;
    spec: unknown;
    spec_hash: string;
    app_context_hash: string;
    model_id: string | null;
    generation_model_calls: number;
    created_at: number;
  } | null;
  plan: {
    id: string;
    source_run_id: string;
    plan: unknown;
    plan_hash: string;
    created_at: number;
  } | null;
  runs: Array<{
    id: string;
    run_type: RunType;
    status: RunStatus;
    result: RunResultValue | null;
    attempt_id: string | null;
    commit_sha: string | null;
    infra_error: boolean;
    infra_error_reason: string | null;
    plan_recovered: boolean;
    model_calls: number;
    assertions_passed: number | null;
    assertions_total: number | null;
    signals_matched: number | null;
    created_at: number;
    started_at: number | null;
    finished_at: number | null;
    actions: Array<{ seq: number; step_id: string; action: unknown; ok: boolean; error: string | null }>;
    checks: Array<{
      kind: "assertion" | "signal";
      assertion_id: string;
      type: string;
      passed: boolean;
      expected: string;
      observed: string;
    }>;
    evidence: Array<{ id: string; kind: string; mime_type: string; relative_path: string; sha256: string | null }>;
  }>;
  fix_attempts: Array<{
    id: string;
    repository: string;
    pr_number: number;
    commit_sha: string;
    merged_at: number;
  }>;
  external_links: {
    slack_channel_id: string | null;
    slack_root_ts: string | null;
    slack_permalink: string | null;
    linear_issue_id: string | null;
    linear_issue_identifier: string | null;
    linear_issue_url: string | null;
    current_attempt_id: string | null;
    github_repository: string | null;
    github_pr_number: number | null;
    github_pr_url: string | null;
    github_commit_sha: string | null;
  } | null;
  jobs: Array<{
    id: string;
    type: JobType;
    status: JobStatus;
    idempotency_key: string;
    run_id: string | null;
    attempt_count: number;
    last_error: string | null;
    created_at: number;
    finished_at: number | null;
  }>;
  side_effects: Array<{
    key: string;
    type: string;
    status: SideEffectStatus;
    external_id: string | null;
    attempt_count: number;
    last_error: string | null;
    created_at: number;
    completed_at: number | null;
  }>;
  /** True while the case can still change: non-terminal status or unsettled work. */
  live: boolean;
};
