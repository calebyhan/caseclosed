import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { count, eq } from "drizzle-orm";
import { AppContext, ReproSpec } from "../src/contracts/repro";
import { sha256Hash } from "../src/domain/identity";
import type { Db } from "../src/server/db/client";
import { cases, fixAttempts, inboundEvents, jobs, reproSpecs, runs, sideEffects, transitions } from "../src/server/db/schema";
import { PlaywrightLauncher } from "../src/server/browser/playwright-session";
import { HttpStagingEnvironment } from "../src/server/browser/environment";
import { claimNext, completeJob } from "../src/server/jobs/queue";
import { acceptDeploymentReady } from "../src/server/services/deployment-ready";
import { handleDeliverEffectJob } from "../src/server/services/external-delivery";
import { acceptMergedPullRequest } from "../src/server/services/fix-lifecycle";
import { createCaseFromReport } from "../src/server/services/intake";
import { handleReproduceJob } from "../src/server/services/reproduction";
import { handleGenerateSpecJob } from "../src/server/services/spec-generation";
import { recordSpecCreated } from "../src/server/services/spec-lifecycle";
import { handleVerifyJob } from "../src/server/services/verification";
import { deliverEffect, type EffectAdapter, type Reconciliation, type SendResult } from "../src/server/side-effects/deliver";
import { ensureEffect, loadEffect, type FrozenEffect } from "../src/server/side-effects/ledger";
import { inTransaction } from "../src/server/db/client";
import { createTestDatabase, type TestDatabase } from "../tests/helpers/database";
import { ClientIdAdapter, FakeRemoteStore } from "../tests/helpers/fake-remote";
import { FakeEnvironment, FakeLauncher, fakeClock, superficialApp } from "../tests/helpers/fake-browser";
import { driveToWaitingForFix, stagingAppContext, statusOf } from "../tests/helpers/lifecycle";

type EvalActual = "REPRODUCED" | "VERIFIED_FIXED" | "STILL_BROKEN" | "INCONCLUSIVE" | "ONE_CASE" | "ONE_ISSUE" | "ONE_VERIFICATION";
type EvalResult = {
  id: number;
  name: string;
  expected: EvalActual;
  actual: EvalActual | "ERROR";
  pass: boolean;
  duration_ms: number;
  details: Record<string, unknown>;
  error?: string;
};

type Metrics = {
  reproduction_classification_accuracy: { correct: number; total: number; rate: number };
  verification_accuracy: { correct: number; total: number; rate: number };
  false_verified_fixed_count: number;
  duplicate_external_side_effects: number;
  correct_inconclusive_classification: { correct: number; total: number; rate: number };
  reprospec_validation_success: { valid: number; total: number; rate: number };
  model_calls_during_verification: number;
  golden_path_e2e_success: { passed: number; total: number; rate: number };
  seeded_eval_accuracy: { correct: number; total: number; rate: number };
};

const ROOT = process.cwd();
const TEST_SECRET = "caseclosed-eval-secret";
const REPORT = "When I switch my Pro plan from monthly to annual and click Upgrade, it spins forever.";
const REPOSITORY = "acme/acmecloud";
const FIX_SHA = "abcdef1234567890";
const BUG_SHA = "bbbbbbb123456789";
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures/repro-spec.valid.json"), "utf8")) as Record<string, unknown>;
const baseContext = JSON.parse(fs.readFileSync(path.join(ROOT, "config/environments/staging.json"), "utf8")) as Record<string, unknown>;

class RecordingAdapter implements EffectAdapter {
  readonly writes: Array<{ type: string; key: string; id: string; payload: Record<string, unknown> }> = [];

  async reconcile(effect: FrozenEffect): Promise<Reconciliation> {
    const found = this.writes.find((write) => write.key === effect.key);
    return found ? { kind: "found", externalId: found.id, result: resultFor(effect, found.id) } : { kind: "safe_to_send" };
  }

  async send(effect: FrozenEffect): Promise<SendResult> {
    const id = effect.providerIdentity;
    this.writes.push({ type: effect.type, key: effect.key, id, payload: effect.payload });
    return { kind: "committed", externalId: id, result: resultFor(effect, id) };
  }
}

function resultFor(effect: FrozenEffect, id: string): Record<string, unknown> {
  if (effect.type === "slack.post_case_root") return { ts: id, channel: String(effect.destination.channel_id ?? "C_EVAL") };
  if (effect.type === "linear.create_issue") return { id, identifier: "ENG-142", url: "https://linear.invalid/ENG-142" };
  return { id };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

type Staging = { baseUrl: string; process: ChildProcess; logs: () => string; stop: () => Promise<void> };

async function startStaging(variant: "buggy" | "fixed" | "superficial", commitSha: string, requestedPort?: number): Promise<Staging> {
  const port = requestedPort ?? await freePort();
  const baseUrl = `http://localhost:${port}`;
  const chunks: string[] = [];
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "dev", "staging/acmecloud", "--port", String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      CASECLOSED_EVAL_MODE: "1",
      ACME_BUILD_VARIANT: variant,
      ACME_EVAL_COMMIT_SHA: commitSha,
      STAGING_TEST_SECRET: TEST_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (data) => chunks.push(String(data)));
  child.stderr?.on("data", (data) => chunks.push(String(data)));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`staging ${variant} exited early (${child.exitCode})\n${chunks.join("").slice(-4000)}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json() as { commit_sha?: string; variant?: string };
      if (response.ok && body.commit_sha === commitSha && body.variant === variant) break;
    } catch {
      // Compilation/server startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
    const body = await response.json() as { commit_sha?: string; variant?: string };
    if (!response.ok || body.commit_sha !== commitSha || body.variant !== variant) throw new Error(JSON.stringify(body));
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`staging ${variant} did not become ready: ${(error as Error).message}\n${chunks.join("").slice(-4000)}`);
  }
  return {
    baseUrl,
    process: child,
    logs: () => chunks.join(""),
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

function contextFor(baseUrl: string): AppContext {
  return AppContext.parse({ ...baseContext, base_url: baseUrl });
}

function specFor(caseId: string, context: AppContext): ReproSpec {
  return ReproSpec.parse({ ...fixture, case_id: caseId, app_context_hash: sha256Hash(context) });
}

function intake(db: Db, trigger: string, report: string = REPORT) {
  return createCaseFromReport(db, {
    source: { type: "slack", teamId: "T_EVAL", channelId: "C_EVAL", userId: "U_EVAL", triggerId: trigger },
    report,
    environmentId: "staging",
  });
}

function persistSpec(db: Db, caseId: string, context: AppContext): { valid: boolean; specId: string } {
  const outcome = recordSpecCreated(db, { caseId, spec: specFor(caseId, context), appContext: context });
  assert.ok(outcome.ok, "valid seeded ReproSpec should persist");
  return { valid: true, specId: outcome.value.specId };
}

async function reproduce(dbState: TestDatabase, staging: Staging, trigger: string) {
  const db = dbState.handle.db;
  const { caseId } = intake(db, trigger);
  const context = contextFor(staging.baseUrl);
  const persisted = persistSpec(db, caseId, context);
  const job = claimNext(db, ["reproduce"]);
  assert.ok(job?.runId);
  const outcome = await handleReproduceJob(job, {
    db,
    appContext: context,
    environment: new HttpStagingEnvironment({ baseUrl: staging.baseUrl, testSecret: TEST_SECRET }),
    launcher: new PlaywrightLauncher(),
    resolver: {
      async resolve(request) {
        if (/annual/i.test(request.step.intent)) return { type: "click", role: "radio", name: "Annual" };
        if (/upgrade/i.test(request.step.intent)) return { type: "click", role: "button", name: "Upgrade" };
        throw new Error(`No seeded action for ${request.step.intent}`);
      },
    },
    artifactDir: path.join(dbState.dir, "artifacts"),
    knownSecrets: [TEST_SECRET],
  });
  return { caseId, context, outcome, specId: persisted.specId };
}

async function drainEffects(db: Db, adapter: RecordingAdapter): Promise<void> {
  for (;;) {
    const job = claimNext(db, ["deliver_effect"]);
    if (!job) return;
    await handleDeliverEffectJob(job, db, { forType: () => adapter });
    completeJob(db, job.id);
  }
}

function mergeMetadata(caseId: string, pr: number, sha: string, mergedAt: string) {
  return {
    repository: REPOSITORY,
    number: pr,
    title: "Fix annual upgrades",
    body: `CaseClosed: ${caseId}`,
    merged: true,
    mergeCommitSha: sha,
    mergedAt,
    baseBranch: "main",
    htmlUrl: `https://github.invalid/${REPOSITORY}/pull/${pr}`,
  };
}

async function mergeAndDeploy(db: Db, caseId: string, pr: number, sha: string) {
  const mergedAt = `2026-09-13T12:${String(pr % 60).padStart(2, "0")}:00.000Z`;
  const merged = await acceptMergedPullRequest(
    db,
    { repository: REPOSITORY, pr, commitSha: sha, deliveryId: `delivery-${pr}-${sha}` },
    async () => mergeMetadata(caseId, pr, sha, mergedAt),
    { expectedRepository: REPOSITORY, defaultBranch: "main" },
  );
  assert.ok(merged.ok && !merged.duplicate);
  const ready = acceptDeploymentReady(db, { pr, commit_sha: sha }, { repository: REPOSITORY });
  assert.ok(ready.ok && ready.response.status === "accepted");
  return merged;
}

async function eval1(): Promise<Record<string, unknown>> {
  const state = createTestDatabase();
  let staging: Staging | null = null;
  try {
    staging = await startStaging("buggy", BUG_SHA);
    const { caseId, outcome } = await reproduce(state, staging, "eval-1");
    const adapter = new RecordingAdapter();
    await drainEffects(state.handle.db, adapter);
    const linear = adapter.writes.filter((write) => write.type === "linear.create_issue");
    const slack = adapter.writes.filter((write) => write.type.startsWith("slack."));
    const storedRun = state.handle.db.select().from(runs).where(eq(runs.id, outcome.runId)).get();
    assert.equal(outcome.result.result, "REPRODUCED", `${JSON.stringify(outcome.result, null, 2)}\nobservations=${storedRun?.observationsJson}\nstaging=${staging.logs().slice(-4000)}`);
    assert.equal(linear.length, 1);
    assert.ok(slack.some((write) => write.type === "slack.post_case_root"));
    assert.ok(slack.some((write) => write.type === "slack.reply" && write.payload.result === "REPRODUCED"));
    return { actual: "REPRODUCED", case_status: statusOf(state.handle.db, caseId), linear_issues: linear.length, slack_messages: slack.length, spec_valid: true };
  } finally {
    await staging?.stop();
    state.cleanup();
  }
}

async function verificationEval(variant: "fixed" | "superficial", expected: "VERIFIED_FIXED" | "STILL_BROKEN", trigger: string) {
  const state = createTestDatabase();
  let staging: Staging | null = null;
  try {
    staging = await startStaging("buggy", BUG_SHA);
    const reproduction = await reproduce(state, staging, trigger);
    assert.equal(reproduction.outcome.result.result, "REPRODUCED", `verification precondition failed: ${JSON.stringify(reproduction.outcome.result, null, 2)}`);
    const adapter = new RecordingAdapter();
    await drainEffects(state.handle.db, adapter);
    assert.equal(statusOf(state.handle.db, reproduction.caseId), "WAITING_FOR_FIX");
    const replayPort = Number(new URL(reproduction.context.base_url).port);
    await staging.stop();
    staging = await startStaging(variant, FIX_SHA, replayPort);
    await mergeAndDeploy(state.handle.db, reproduction.caseId, variant === "fixed" ? 82 : 83, FIX_SHA);
    const job = claimNext(state.handle.db, ["verify"]);
    assert.ok(job?.runId);
    const outcome = await handleVerifyJob(job, {
      db: state.handle.db,
      appContext: contextFor(staging.baseUrl),
      environment: new HttpStagingEnvironment({ baseUrl: staging.baseUrl, testSecret: TEST_SECRET }),
      launcher: new PlaywrightLauncher(),
      artifactDir: path.join(state.dir, "artifacts"),
      knownSecrets: [TEST_SECRET],
    });
    await drainEffects(state.handle.db, adapter);
    const run = state.handle.db.select().from(runs).where(eq(runs.id, job.runId)).get()!;
    const originalSpec = state.handle.db.select().from(reproSpecs).where(eq(reproSpecs.id, reproduction.specId)).get()!;
    const verificationEffects = adapter.writes.filter((write) => write.key.includes(job.runId!));
    assert.equal(outcome.result.result, expected);
    assert.equal(run.specId, originalSpec.id, "verification must use the original ReproSpec row");
    assert.equal(run.modelCalls, 0);
    assert.equal(outcome.result.model_calls, 0);
    if (expected === "VERIFIED_FIXED") assert.equal(statusOf(state.handle.db, reproduction.caseId), "VERIFIED_FIXED");
    else assert.equal(statusOf(state.handle.db, reproduction.caseId), "WAITING_FOR_FIX");
    return {
      actual: expected,
      case_status: statusOf(state.handle.db, reproduction.caseId),
      original_spec_replayed: run.specId === originalSpec.id,
      model_calls: run.modelCalls,
      verification_side_effects: verificationEffects.length,
      backend_status: outcome.result.assertions.find((item) => item.id === "a1")?.observed,
      checkout_assertion_passed: outcome.result.assertions.find((item) => item.id === "a2")?.passed,
      spec_valid: true,
    };
  } finally {
    await staging?.stop();
    state.cleanup();
  }
}

async function eval4(): Promise<Record<string, unknown>> {
  const state = createTestDatabase();
  try {
    const db = state.handle.db;
    const { caseId } = intake(db, "eval-4", "Billing is broken for me.");
    const job = claimNext(db, ["generate_spec"]);
    assert.ok(job);
    const result = await handleGenerateSpecJob(job, {
      db,
      appContext: AppContext.parse(stagingAppContext()),
      knownSecrets: [],
      generator: { async generate() { return { kind: "insufficient" as const, missing: ["the page and action that fail", "the expected outcome"], modelCalls: 1, modelId: "seeded-eval" }; } },
    });
    const row = db.select().from(cases).where(eq(cases.id, caseId)).get()!;
    const linear = db.select({ n: count() }).from(sideEffects).where(eq(sideEffects.type, "linear.create_issue")).get()!.n;
    assert.equal(result.kind, "spec_failed");
    assert.equal(row.status, "SPEC_FAILED");
    assert.equal(row.specFailureKind, "insufficient");
    assert.equal(linear, 0);
    return { actual: "INCONCLUSIVE", case_status: row.status, missing: JSON.parse(row.specFailureReasonsJson!), linear_issues: linear };
  } finally { state.cleanup(); }
}

async function eval5(): Promise<Record<string, unknown>> {
  const state = createTestDatabase();
  try {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const db = state.handle.db;
    const { caseId } = intake(db, "eval-5");
    const context = contextFor(baseUrl);
    persistSpec(db, caseId, context);
    const job = claimNext(db, ["reproduce"]);
    assert.ok(job?.runId);
    const outcome = await handleReproduceJob(job, {
      db,
      appContext: context,
      environment: new HttpStagingEnvironment({ baseUrl, testSecret: TEST_SECRET, timeoutMs: 300 }),
      launcher: new PlaywrightLauncher(),
      resolver: { async resolve() { throw new Error("resolver must not run while staging is unavailable"); } },
      artifactDir: path.join(state.dir, "artifacts"),
      knownSecrets: [TEST_SECRET],
    });
    const run = db.select().from(runs).where(eq(runs.id, job.runId)).get()!;
    assert.equal(outcome.result.result, "INCONCLUSIVE");
    assert.equal(run.infraError, true);
    assert.ok(run.infraErrorReason);
    assert.equal(statusOf(db, caseId), "REPRO_INCONCLUSIVE");
    assert.notEqual(outcome.result.result, "NOT_REPRODUCED");
    assert.equal(db.select({ n: count() }).from(sideEffects).where(eq(sideEffects.type, "linear.create_issue")).get()!.n, 0);
    return { actual: "INCONCLUSIVE", case_status: statusOf(db, caseId), infra_error_reason: run.infraErrorReason, linear_issues: 0, spec_valid: true };
  } finally { state.cleanup(); }
}

async function eval6(): Promise<Record<string, unknown>> {
  const state = createTestDatabase();
  try {
    const first = intake(state.handle.db, "eval-6-duplicate");
    const second = intake(state.handle.db, "eval-6-duplicate");
    const adapter = new RecordingAdapter();
    await drainEffects(state.handle.db, adapter);
    const caseCount = state.handle.db.select({ n: count() }).from(cases).get()!.n;
    const roots = adapter.writes.filter((write) => write.type === "slack.post_case_root");
    const ledgerRows = state.handle.db.select({ n: count() }).from(sideEffects).where(eq(sideEffects.key, "slack:case-created:eval-6-duplicate")).get()!.n;
    assert.equal(first.caseId, second.caseId);
    assert.equal(second.created, false);
    assert.equal(caseCount, 1);
    assert.equal(roots.length, 1);
    assert.equal(ledgerRows, 1);
    return { actual: "ONE_CASE", cases: caseCount, slack_threads: roots.length, root_effect_rows: ledgerRows, duplicate_side_effects: 0 };
  } finally { state.cleanup(); }
}

async function eval7(): Promise<Record<string, unknown>> {
  const state = createTestDatabase();
  try {
    const db = state.handle.db;
    const { caseId } = intake(db, "eval-7");
    const key = `linear:create:${caseId}`;
    inTransaction(db, (tx) => ensureEffect(tx, { key, type: "linear.create_issue", caseId, destination: { team: "ENG" }, payload: { title: "Annual upgrade fails" } }));
    const storeFile = path.join(state.dir, "linear-remote.json");
    const store = new FakeRemoteStore(storeFile);
    const first = await deliverEffect(db, key, new ClientIdAdapter(store, { dropResponseOnce: true }));
    assert.equal(first.status, "unknown");
    assert.equal(store.all().length, 1, "the first provider request committed");
    const reopened = state.reopen().db;
    const retryAdapter = new ClientIdAdapter(new FakeRemoteStore(storeFile));
    const recovered = await deliverEffect(reopened, key, retryAdapter);
    const effect = loadEffect(reopened, key)!;
    assert.equal(recovered.status, "completed");
    assert.equal(retryAdapter.sendCalls, 0);
    assert.equal(store.all().length, 1);
    assert.equal(effect.attemptCount, 1);
    return { actual: "ONE_ISSUE", linear_issues: store.all().length, retry_send_calls: retryAdapter.sendCalls, ledger_status: effect.status, duplicate_side_effects: 0 };
  } finally { state.cleanup(); }
}

async function eval8(): Promise<Record<string, unknown>> {
  const state = createTestDatabase();
  try {
    const db = state.handle.db;
    const { caseId } = driveToWaitingForFix(db);
    const event = { repository: REPOSITORY, pr: 84, commitSha: FIX_SHA, deliveryId: "eval-8-delivery" };
    const metadata = () => mergeMetadata(caseId, 84, FIX_SHA, "2026-09-13T12:30:00.000Z");
    const first = await acceptMergedPullRequest(db, event, async () => metadata(), { expectedRepository: REPOSITORY, defaultBranch: "main" });
    const duplicate = await acceptMergedPullRequest(db, event, async () => metadata(), { expectedRepository: REPOSITORY, defaultBranch: "main" });
    assert.ok(first.ok && !first.duplicate);
    assert.ok(duplicate.ok && duplicate.duplicate);
    const ready = acceptDeploymentReady(db, { pr: 84, commit_sha: FIX_SHA }, { repository: REPOSITORY });
    const readyDuplicate = acceptDeploymentReady(db, { pr: 84, commit_sha: FIX_SHA }, { repository: REPOSITORY });
    assert.ok(ready.ok && ready.response.status === "accepted");
    assert.ok(readyDuplicate.ok && readyDuplicate.response.status === "duplicate");
    const verificationJobs = db.select().from(jobs).where(eq(jobs.type, "verify")).all();
    assert.equal(verificationJobs.length, 1);
    const verifyJob = claimNext(db, ["verify"]);
    assert.ok(verifyJob?.runId);
    await handleVerifyJob(verifyJob, {
      db,
      appContext: AppContext.parse(stagingAppContext()),
      environment: new FakeEnvironment({ health: { ok: true, commitSha: FIX_SHA } }),
      launcher: new FakeLauncher(superficialApp),
      artifactDir: path.join(state.dir, "artifacts"),
      knownSecrets: [],
      clock: fakeClock(),
    });
    assert.equal(statusOf(db, caseId), "WAITING_FOR_FIX");
    const verificationEffects = db.select().from(sideEffects).where(eq(sideEffects.runId, verifyJob.runId)).all();
    const expectedVerificationTypes = [
      "github.verification_comment",
      "linear.verification_comment",
      "linear.apply_labels",
      "slack.reply",
    ];
    for (const type of expectedVerificationTypes) {
      assert.equal(verificationEffects.filter((effect) => effect.type === type).length, 1, `expected one ${type} side effect`);
    }
    const duplicatedVerificationEffects = expectedVerificationTypes.reduce(
      (duplicates, type) => duplicates + Math.max(0, verificationEffects.filter((effect) => effect.type === type).length - 1),
      0,
    );
    assert.equal(duplicatedVerificationEffects, 0);

    const newSha = "fedcba9876543210";
    const secondAttempt = await acceptMergedPullRequest(
      db,
      { repository: REPOSITORY, pr: 85, commitSha: newSha, deliveryId: "eval-8-new-sha" },
      async () => mergeMetadata(caseId, 85, newSha, "2026-09-13T12:31:00.000Z"),
      { expectedRepository: REPOSITORY, defaultBranch: "main" },
    );
    assert.ok(secondAttempt.ok && !secondAttempt.duplicate, "a new SHA after STILL_BROKEN must be accepted");
    const mergeTransitions = db.select({ n: count() }).from(transitions).where(eq(transitions.eventType, "fix_merged")).get()!.n;
    const firstAttemptRows = db.select({ n: count() }).from(fixAttempts).where(eq(fixAttempts.commitSha, FIX_SHA)).get()!.n;
    const acceptedMergeEvents = db.select({ n: count() }).from(inboundEvents).where(eq(inboundEvents.eventType, "github_merge")).get()!.n;
    assert.equal(firstAttemptRows, 1);
    assert.equal(mergeTransitions, 2, "one original merge plus one legitimate new-SHA merge");
    assert.equal(acceptedMergeEvents, 2);
    return {
      actual: "ONE_VERIFICATION",
      verification_jobs_after_duplicate: verificationJobs.length,
      first_sha_attempts: firstAttemptRows,
      duplicate_merge_was_noop: duplicate.duplicate,
      new_sha_after_still_broken_accepted: true,
      verification_side_effect_rows: verificationEffects.length,
      duplicate_side_effects: duplicatedVerificationEffects,
    };
  } finally { state.cleanup(); }
}

const definitions: Array<{ id: number; name: string; expected: EvalActual; run: () => Promise<Record<string, unknown>> }> = [
  { id: 1, name: "Real billing bug", expected: "REPRODUCED", run: eval1 },
  { id: 2, name: "Same flow after actual fix", expected: "VERIFIED_FIXED", run: () => verificationEval("fixed", "VERIFIED_FIXED", "eval-2") },
  { id: 3, name: "Superficial UI fix; backend still broken", expected: "STILL_BROKEN", run: () => verificationEval("superficial", "STILL_BROKEN", "eval-3") },
  { id: 4, name: "Ambiguous report", expected: "INCONCLUSIVE", run: eval4 },
  { id: 5, name: "Staging unavailable", expected: "INCONCLUSIVE", run: eval5 },
  { id: 6, name: "Duplicate Slack event", expected: "ONE_CASE", run: eval6 },
  { id: 7, name: "Interrupted Linear response", expected: "ONE_ISSUE", run: eval7 },
  { id: 8, name: "Duplicate GitHub merge webhook", expected: "ONE_VERIFICATION", run: eval8 },
];

async function runOne(definition: typeof definitions[number]): Promise<EvalResult> {
  const started = Date.now();
  try {
    const details = await definition.run();
    const actual = details.actual as EvalActual;
    return { id: definition.id, name: definition.name, expected: definition.expected, actual, pass: actual === definition.expected, duration_ms: Date.now() - started, details };
  } catch (error) {
    return { id: definition.id, name: definition.name, expected: definition.expected, actual: "ERROR", pass: false, duration_ms: Date.now() - started, details: {}, error: (error as Error).stack ?? String(error) };
  }
}

function ratio(correct: number, total: number) {
  return { correct, total, rate: total === 0 ? 0 : correct / total };
}

function metricsFor(results: EvalResult[]): Metrics {
  const byId = new Map(results.map((result) => [result.id, result]));
  const reproductionIds = [1, 5];
  const verificationIds = [2, 3];
  const inconclusiveIds = [4, 5];
  const browserIds = [1, 2, 3];
  const validSpecResults = results.filter((result) => [1, 2, 3, 5].includes(result.id));
  const falseVerified = results.filter((result) => result.actual === "VERIFIED_FIXED" && result.expected !== "VERIFIED_FIXED").length;
  const duplicateEffects = results.reduce((sum, result) => sum + Number(result.details.duplicate_side_effects ?? 0), 0);
  const modelCalls = results.reduce((sum, result) => sum + Number(result.details.model_calls ?? 0), 0);
  const passed = (ids: number[]) => ids.filter((id) => byId.get(id)?.pass).length;
  const validSpecs = validSpecResults.filter((result) => result.pass && result.details.spec_valid === true).length;
  return {
    reproduction_classification_accuracy: ratio(passed(reproductionIds), reproductionIds.length),
    verification_accuracy: ratio(passed(verificationIds), verificationIds.length),
    false_verified_fixed_count: falseVerified,
    duplicate_external_side_effects: duplicateEffects,
    correct_inconclusive_classification: ratio(passed(inconclusiveIds), inconclusiveIds.length),
    reprospec_validation_success: { valid: validSpecs, total: validSpecResults.length, rate: validSpecResults.length ? validSpecs / validSpecResults.length : 0 },
    model_calls_during_verification: modelCalls,
    golden_path_e2e_success: { passed: passed(browserIds), total: browserIds.length, rate: passed(browserIds) / browserIds.length },
    seeded_eval_accuracy: ratio(results.filter((result) => result.pass).length, results.length),
  };
}

function updateDocs(results: EvalResult[]): void {
  const file = path.join(ROOT, "docs/EVALS.md");
  let source = fs.readFileSync(file, "utf8");
  const actual = (id: number) => {
    const result = results.find((item) => item.id === id)!;
    return result.actual === "ERROR" ? "`ERROR`" : `\`${result.actual}\``;
  };
  const pass = (id: number) => results.find((item) => item.id === id)!.pass ? "PASS" : "FAIL";
  const replacements: Record<number, RegExp> = {
    1: /^\| 1\. Real billing bug .*$/m,
    2: /^\| 2\. Fixed build .*$/m,
    3: /^\| 3\. Superficial fix .*$/m,
    4: /^\| 4\. Ambiguous report .*$/m,
    5: /^\| 5\. Staging unavailable .*$/m,
    6: /^\| 6\. Duplicate Slack event .*$/m,
    7: /^\| 7\. Interrupted Linear response .*$/m,
    8: /^\| 8\. Duplicate merge webhook .*$/m,
  };
  const labels: Record<number, string> = { 1: "Real billing bug", 2: "Fixed build", 3: "Superficial fix", 4: "Ambiguous report", 5: "Staging unavailable", 6: "Duplicate Slack event", 7: "Interrupted Linear response", 8: "Duplicate merge webhook" };
  const expected: Record<number, string> = { 1: "`REPRODUCED`", 2: "`VERIFIED_FIXED`", 3: "`STILL_BROKEN`", 4: "`SPEC_FAILED` / inconclusive", 5: "`INCONCLUSIVE`", 6: "one case", 7: "one issue", 8: "one verification" };
  for (const id of Object.keys(replacements).map(Number)) {
    source = source.replace(replacements[id]!, `| ${id}. ${labels[id]} | ${expected[id]} | ${actual(id)} | ${pass(id)} |`);
  }
  source = source.replace(/^\| 8b\. New SHA after STILL_BROKEN .*$/m, `| 8b. New SHA after STILL_BROKEN | accepted | \`${results.find((item) => item.id === 8)?.details.new_sha_after_still_broken_accepted === true ? "accepted" : "not accepted"}\` | ${pass(8)} |`);
  fs.writeFileSync(file, source);
}

async function main(): Promise<void> {
  const selectedArg = process.argv.find((arg) => arg.startsWith("--eval="));
  const selected = selectedArg ? Number(selectedArg.split("=")[1]) : null;
  const selectedDefinitions = selected === null ? definitions : definitions.filter((definition) => definition.id === selected);
  if (selected !== null && selectedDefinitions.length === 0) throw new Error(`Unknown eval ${selected}`);
  const results: EvalResult[] = [];
  for (const definition of selectedDefinitions) {
    process.stdout.write(`Eval ${definition.id}: ${definition.name} ... `);
    const result = await runOne(definition);
    results.push(result);
    console.log(result.pass ? `PASS (${result.actual})` : `FAIL (${result.actual})`);
    if (result.error) console.error(result.error);
  }
  const metrics = metricsFor(results);
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    suite: "CaseClosed reliability evaluation",
    passed: results.every((result) => result.pass),
    results,
    metrics,
    failed_scenarios: results.filter((result) => !result.pass).map((result) => ({ id: result.id, name: result.name, error: result.error ?? null })),
    highest_risk_remaining_failure_mode: "Model-generated ReproSpec sufficiency and semantic quality are not exercised against a live model in this deterministic suite.",
  };
  const resultsDir = path.join(ROOT, "evals/results");
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes("--update-docs") && selected === null) updateDocs(results);

  console.log("\nCaseClosed reliability summary");
  console.log(`Seeded evals: ${metrics.seeded_eval_accuracy.correct}/${metrics.seeded_eval_accuracy.total}`);
  console.log(`Reproduction accuracy: ${metrics.reproduction_classification_accuracy.correct}/${metrics.reproduction_classification_accuracy.total}`);
  console.log(`Verification accuracy: ${metrics.verification_accuracy.correct}/${metrics.verification_accuracy.total}`);
  console.log(`Correct INCONCLUSIVE: ${metrics.correct_inconclusive_classification.correct}/${metrics.correct_inconclusive_classification.total}`);
  console.log(`Duplicate external side effects: ${metrics.duplicate_external_side_effects}`);
  console.log(`Model calls during verification: ${metrics.model_calls_during_verification}`);
  console.log(`*** FALSE VERIFIED_FIXED: ${metrics.false_verified_fixed_count} ***`);
  console.log(`Machine result: ${path.relative(ROOT, path.join(resultsDir, "latest.json"))}`);
  if (!report.passed) process.exitCode = 1;
}

await main();
