import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { count, eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { CaseStatus } from "../../src/contracts/lifecycle";
import { ReproSpec, type ResolvedPlan } from "../../src/contracts/repro";
import type { CaseEvent } from "../../src/domain/state-machine";
import { inTransaction, type Db } from "../../src/server/db/client";
import { applyCaseEvent } from "../../src/server/db/repositories";
import { cases, externalLinks, fixAttempts } from "../../src/server/db/schema";
import { claimNext, enqueueUnique } from "../../src/server/jobs/queue";
import { createCaseFromReport, type IntakeResult } from "../../src/server/services/intake";
import { finalizeRun } from "../../src/server/services/runs";
import { recordSpecCreated } from "../../src/server/services/spec-lifecycle";
import { buggyObservations } from "./observations";

// Authorized lifecycle fixtures for temporary test databases only. Linear and
// GitHub facts are inserted directly because those integrations are not built yet.

export function stagingAppContext(): unknown {
  return JSON.parse(fs.readFileSync("config/environments/staging.json", "utf8"));
}

export function goldenSpecFor(caseId: string): Record<string, unknown> {
  return { ...JSON.parse(fs.readFileSync("fixtures/repro-spec.valid.json", "utf8")), case_id: caseId };
}

export function goldenPlanFor(caseId: string): ResolvedPlan {
  return {
    case_id: caseId,
    spec_version: "1" as const,
    actions: [
      { step_id: "step_1", action: { type: "click", role: "radio", name: "Annual" } },
      { step_id: "step_2", action: { type: "click", role: "button", name: "Upgrade" } },
    ],
  };
}

export function intake(
  db: Db,
  overrides: Partial<{ triggerId: string; report: string; teamId: string }> = {},
): IntakeResult {
  return createCaseFromReport(db, {
    source: {
      type: "slack",
      teamId: overrides.teamId ?? "T_TEST",
      channelId: "C_TEST",
      userId: "U_TEST",
      triggerId: overrides.triggerId ?? `trigger-${randomUUID()}`,
    },
    report: overrides.report ?? "When I switch my Pro plan from monthly to annual and click Upgrade, it spins forever.",
    environmentId: "staging",
  });
}

export function caseWithSpec(db: Db): { caseId: string; specId: string; reproduceJobId: string } {
  const { caseId } = intake(db);
  const outcome = recordSpecCreated(db, { caseId, spec: goldenSpecFor(caseId), appContext: stagingAppContext() });
  assert.ok(outcome.ok, "spec should be recorded");
  return { caseId, ...outcome.value };
}

export function statusOf(db: Db, caseId: string): CaseStatus {
  return db.select({ status: cases.status }).from(cases).where(eq(cases.id, caseId)).get()!.status as CaseStatus;
}

export function rowCount(db: Db, table: SQLiteTable): number {
  return db.select({ n: count() }).from(table).get()!.n;
}

export function linkLinearIssue(db: Db, caseId: string, issueId: string): void {
  db.update(externalLinks)
    .set({ linearIssueId: issueId, linearIssueIdentifier: "ENG-142", updatedAt: Date.now() })
    .where(eq(externalLinks.caseId, caseId))
    .run();
}

export function addFixAttempt(db: Db, caseId: string, prNumber: number, commitSha: string): string {
  const id = randomUUID();
  inTransaction(db, (tx) => {
    tx.insert(fixAttempts)
      .values({ id, caseId, repository: "acme/acmecloud", prNumber, commitSha, mergedAt: Date.now(), createdAt: Date.now() })
      .run();
    tx.update(externalLinks)
      .set({ currentAttemptId: id, githubRepository: "acme/acmecloud", githubPrNumber: prNumber, githubCommitSha: commitSha, updatedAt: Date.now() })
      .where(eq(externalLinks.caseId, caseId))
      .run();
  });
  return id;
}

export function applyOk(db: Db, event: CaseEvent): void {
  const outcome = applyCaseEvent(db, event);
  assert.ok(outcome.ok, outcome.ok ? "" : `expected ${event.type} to be accepted: ${outcome.rejection.reason}`);
}

/** Drives a real persisted case from intake through reproduction to WAITING_FOR_FIX. */
export function driveToWaitingForFix(db: Db): { caseId: string; reproductionRunId: string } {
  const { caseId } = caseWithSpec(db);
  const job = claimNext(db, ["reproduce"]);
  assert.ok(job?.runId);
  const finalized = finalizeRun(db, {
    runId: job.runId,
    result: "REPRODUCED",
    assertionsPassed: 0,
    assertionsTotal: 2,
    signalsMatched: 2,
    observations: buggyObservations(ReproSpec.parse(goldenSpecFor(caseId))),
    plan: goldenPlanFor(caseId),
    job: { id: job.id, status: "completed" },
  });
  assert.ok(finalized.ok);
  linkLinearIssue(db, caseId, "linear-uuid-1");
  applyOk(db, { type: "issue_confirmed", case_id: caseId, linear_issue_id: "linear-uuid-1", event_key: `issue:${caseId}` });
  applyOk(db, { type: "await_fix", case_id: caseId, event_key: `await-fix:issue:${caseId}` });
  return { caseId, reproductionRunId: job.runId };
}

/** Merge + deployment-ready for a new attempt, then claim its verification job. */
export function mergeDeployAndClaimVerification(
  db: Db,
  caseId: string,
  prNumber: number,
  commitSha: string,
): { attemptId: string; runId: string; jobId: string } {
  const attemptId = addFixAttempt(db, caseId, prNumber, commitSha);
  applyOk(db, { type: "fix_merged", case_id: caseId, attempt_id: attemptId, commit_sha: commitSha, event_key: `merge:${attemptId}` });
  applyOk(db, { type: "await_deployment", case_id: caseId, attempt_id: attemptId, event_key: `await-deploy:${attemptId}` });
  applyOk(db, { type: "deployment_ready", case_id: caseId, attempt_id: attemptId, commit_sha: commitSha, event_key: `ready:${attemptId}` });
  inTransaction(db, (tx) =>
    enqueueUnique(tx, {
      key: `verify:${caseId}:${commitSha}:initial`,
      type: "verify",
      caseId,
      attemptId,
      payload: { case_id: caseId, commit_sha: commitSha },
    }),
  );
  const job = claimNext(db, ["verify"]);
  assert.ok(job?.runId, "verification job should be claimed with a run");
  return { attemptId, runId: job.runId, jobId: job.id };
}
