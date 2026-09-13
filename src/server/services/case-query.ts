import { asc, desc, eq, inArray } from "drizzle-orm";
import {
  TERMINAL_STATUSES,
  type CaseDetail,
  type CaseStatus,
  type JobStatus,
  type JobType,
  type RunResultValue,
  type RunStatus,
  type RunType,
  type SideEffectStatus,
  type SpecFailureKind,
  type TimelineEntry,
} from "../../contracts/lifecycle";
import type { Executor } from "../db/client";
import type { RunObservations } from "../../contracts/run";
import {
  assertionResults,
  browserActions,
  cases,
  evidence,
  externalLinks,
  fixAttempts,
  jobs,
  rejectedEvents,
  reproSpecs,
  resolvedPlans,
  runs,
  sideEffects,
  transitions,
} from "../db/schema";

// Read-only projection of canonical state. No model, browser, or external API reads.

export function getCaseDetail(ex: Executor, caseId: string): CaseDetail | null {
  const row = ex.select().from(cases).where(eq(cases.id, caseId)).get();
  if (!row) return null;
  const status = row.status as CaseStatus;

  const timeline: TimelineEntry[] = [
    ...ex
      .select()
      .from(transitions)
      .where(eq(transitions.caseId, caseId))
      .all()
      .map(
        (t): TimelineEntry => ({
          kind: "transition",
          id: t.id,
          at: t.createdAt,
          from: t.fromStatus as CaseStatus | null,
          to: t.toStatus as CaseStatus,
          event_type: t.eventType,
          event_key: t.eventKey,
          trigger: t.trigger,
        }),
      ),
    ...ex
      .select()
      .from(rejectedEvents)
      .where(eq(rejectedEvents.caseId, caseId))
      .all()
      .map(
        (r): TimelineEntry => ({
          kind: "rejected",
          id: r.id,
          at: r.createdAt,
          event_type: r.eventType,
          event_key: r.eventKey,
          from_status: r.fromStatus as CaseStatus | null,
          reason: r.reason,
        }),
      ),
  ].sort((a, b) => a.at - b.at || (a.kind === b.kind ? a.id - b.id : a.kind === "transition" ? -1 : 1));

  const spec = ex.select().from(reproSpecs).where(eq(reproSpecs.caseId, caseId)).get();
  const plan = ex.select().from(resolvedPlans).where(eq(resolvedPlans.caseId, caseId)).get();
  const runRows = ex.select().from(runs).where(eq(runs.caseId, caseId)).orderBy(asc(runs.createdAt)).all();
  const runIds = runRows.map((run) => run.id);
  const actionRows = runIds.length
    ? ex.select().from(browserActions).where(inArray(browserActions.runId, runIds)).orderBy(asc(browserActions.seq)).all()
    : [];
  const checkRows = runIds.length ? ex.select().from(assertionResults).where(inArray(assertionResults.runId, runIds)).all() : [];
  const evidenceRows = runIds.length ? ex.select().from(evidence).where(inArray(evidence.runId, runIds)).all() : [];

  const links = ex.select().from(externalLinks).where(eq(externalLinks.caseId, caseId)).get();
  const jobRows = ex.select().from(jobs).where(eq(jobs.caseId, caseId)).orderBy(asc(jobs.seq)).all();
  const effectRows = ex.select().from(sideEffects).where(eq(sideEffects.caseId, caseId)).orderBy(asc(sideEffects.createdAt)).all();

  const unsettledWork =
    jobRows.some((job) => job.status === "pending" || job.status === "running") ||
    effectRows.some((effect) => effect.status === "pending" || effect.status === "sending");

  return {
    case: {
      id: row.id,
      status,
      terminal: TERMINAL_STATUSES.has(status),
      report: row.report,
      environment_id: row.environmentId,
      source: {
        type: row.sourceType,
        team_id: row.sourceTeamId,
        channel_id: row.sourceChannelId,
        user_id: row.sourceUserId,
        trigger_id: row.sourceTriggerId,
        thread_ts: row.sourceThreadTs,
      },
      spec_failure: row.specFailureKind
        ? {
            kind: row.specFailureKind as SpecFailureKind,
            reasons: row.specFailureReasonsJson ? (JSON.parse(row.specFailureReasonsJson) as string[]) : [],
          }
        : null,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    },
    timeline,
    spec: spec
      ? {
          id: spec.id,
          version: spec.version,
          spec: JSON.parse(spec.specJson),
          spec_hash: spec.specHash,
          app_context_hash: spec.appContextHash,
          model_id: spec.modelId,
          generation_model_calls: spec.generationModelCalls,
          created_at: spec.createdAt,
        }
      : null,
    plan: plan
      ? {
          id: plan.id,
          source_run_id: plan.sourceRunId,
          plan: JSON.parse(plan.planJson),
          plan_hash: plan.planHash,
          created_at: plan.createdAt,
        }
      : null,
    runs: runRows.map((run) => {
      const observations = parseObservations(run.observationsJson);
      return {
      id: run.id,
      run_type: run.runType as RunType,
      status: run.status as RunStatus,
      result: run.result as RunResultValue | null,
      attempt_id: run.attemptId,
      commit_sha: run.commitSha,
      infra_error: run.infraError,
      infra_error_reason: run.infraErrorReason,
      plan_recovered: run.planRecovered,
      model_calls: run.modelCalls,
      assertions_passed: run.assertionsPassed,
      assertions_total: run.assertionsTotal,
      signals_matched: run.signalsMatched,
      created_at: run.createdAt,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      actions: actionRows
        .filter((action) => action.runId === run.id)
        .map((action) => ({
          seq: action.seq,
          step_id: action.stepId,
          action: JSON.parse(action.actionJson),
          ok: action.ok,
          error: action.error,
        })),
      checks: checkRows
        .filter((check) => check.runId === run.id)
        .map((check) => ({
          kind: check.kind as "assertion" | "signal",
          assertion_id: check.assertionId,
          type: check.type,
          passed: check.passed,
          expected: check.expected,
          observed: check.observed,
        })),
      console_events: observations?.console.map(({ level, text }) => ({ level, text })) ?? [],
      evidence: evidenceRows
        .filter((item) => item.runId === run.id)
        .map((item) => ({
          id: item.id,
          kind: item.kind,
          mime_type: item.mimeType,
          relative_path: item.relativePath,
          sha256: item.sha256,
        })),
      };
    }),
    fix_attempts: ex
      .select()
      .from(fixAttempts)
      .where(eq(fixAttempts.caseId, caseId))
      .orderBy(asc(fixAttempts.mergedAt))
      .all()
      .map((attempt) => ({
        id: attempt.id,
        repository: attempt.repository,
        pr_number: attempt.prNumber,
        commit_sha: attempt.commitSha,
        merged_at: attempt.mergedAt,
      })),
    external_links: links
      ? {
          slack_channel_id: links.slackChannelId,
          slack_root_ts: links.slackRootTs,
          slack_permalink: links.slackPermalink,
          linear_issue_id: links.linearIssueId,
          linear_issue_identifier: links.linearIssueIdentifier,
          linear_issue_url: links.linearIssueUrl,
          current_attempt_id: links.currentAttemptId,
          github_repository: links.githubRepository,
          github_pr_number: links.githubPrNumber,
          github_pr_url: links.githubPrUrl,
          github_commit_sha: links.githubCommitSha,
        }
      : null,
    jobs: jobRows.map((job) => ({
      id: job.id,
      type: job.type as JobType,
      status: job.status as JobStatus,
      idempotency_key: job.idempotencyKey,
      run_id: job.runId,
      attempt_count: job.attemptCount,
      last_error: job.lastError,
      created_at: job.createdAt,
      finished_at: job.finishedAt,
    })),
    side_effects: effectRows.map((effect) => ({
      key: effect.key,
      type: effect.type,
      status: effect.status as SideEffectStatus,
      external_id: effect.externalId,
      attempt_count: effect.attemptCount,
      last_error: effect.lastError,
      created_at: effect.createdAt,
      completed_at: effect.completedAt,
    })),
    live: !TERMINAL_STATUSES.has(status) || unsettledWork,
  };
}

function parseObservations(value: string | null): RunObservations | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RunObservations>;
    return Array.isArray(parsed.console) ? (parsed as RunObservations) : null;
  } catch {
    return null;
  }
}

export type CaseSummary = { id: string; status: CaseStatus; report: string; created_at: number; updated_at: number };

export function listRecentCases(ex: Executor, limit = 50): CaseSummary[] {
  return ex
    .select({ id: cases.id, status: cases.status, report: cases.report, created_at: cases.createdAt, updated_at: cases.updatedAt })
    .from(cases)
    .orderBy(desc(cases.caseNumber))
    .limit(limit)
    .all()
    .map((row) => ({ ...row, status: row.status as CaseStatus }));
}
