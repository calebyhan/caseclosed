import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Canonical CaseClosed state. Timestamps are epoch milliseconds.

const createdAt = () => integer("created_at").notNull();

/** Single-row table: database-instance identity and case-number allocation. */
export const appMeta = sqliteTable(
  "app_meta",
  {
    id: integer("id").primaryKey(),
    instanceId: text("instance_id").notNull(),
    nextCaseNumber: integer("next_case_number").notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("app_meta_singleton", sql`${t.id} = 1`)],
);

export const cases = sqliteTable(
  "cases",
  {
    id: text("id").primaryKey(),
    caseNumber: integer("case_number").notNull().unique(),
    status: text("status").notNull(),
    report: text("report").notNull(),
    environmentId: text("environment_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceTeamId: text("source_team_id").notNull(),
    sourceChannelId: text("source_channel_id").notNull(),
    sourceUserId: text("source_user_id").notNull(),
    sourceTriggerId: text("source_trigger_id").notNull(),
    sourceThreadTs: text("source_thread_ts"),
    specFailureKind: text("spec_failure_kind"),
    specFailureReasonsJson: text("spec_failure_reasons_json"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("cases_source_trigger_unique").on(t.sourceTeamId, t.sourceTriggerId),
    index("cases_status_idx").on(t.status),
  ],
);

/** One immutable spec per case. Placeholder linkage until spec generation lands. */
export const reproSpecs = sqliteTable("repro_specs", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .unique()
    .references(() => cases.id),
  version: text("version").notNull(),
  specJson: text("spec_json").notNull(),
  specHash: text("spec_hash").notNull(),
  appContextJson: text("app_context_json").notNull(),
  appContextHash: text("app_context_hash").notNull(),
  generationSchemaJson: text("generation_schema_json"),
  modelId: text("model_id"),
  generationModelCalls: integer("generation_model_calls").notNull().default(0),
  createdAt: createdAt(),
});

export const fixAttempts = sqliteTable(
  "fix_attempts",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id),
    repository: text("repository").notNull(),
    prNumber: integer("pr_number").notNull(),
    commitSha: text("commit_sha").notNull(),
    mergedAt: integer("merged_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("fix_attempts_case_pr_sha_unique").on(t.caseId, t.repository, t.prNumber, t.commitSha),
    // A merged PR revision can never be rebound to a different case.
    uniqueIndex("fix_attempts_pr_sha_unique").on(t.repository, t.prNumber, t.commitSha),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id),
    runType: text("run_type").notNull(),
    status: text("status").notNull(),
    result: text("result"),
    specId: text("spec_id")
      .notNull()
      .references(() => reproSpecs.id),
    planId: text("plan_id"),
    attemptId: text("attempt_id").references(() => fixAttempts.id),
    commitSha: text("commit_sha"),
    assertionsPassed: integer("assertions_passed"),
    assertionsTotal: integer("assertions_total"),
    signalsMatched: integer("signals_matched"),
    infraError: integer("infra_error", { mode: "boolean" }).notNull().default(false),
    infraErrorReason: text("infra_error_reason"),
    planRecovered: integer("plan_recovered", { mode: "boolean" }).notNull().default(false),
    modelCalls: integer("model_calls").notNull().default(0),
    observationsJson: text("observations_json"),
    createdAt: createdAt(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("runs_case_idx").on(t.caseId, t.createdAt),
    check("runs_type_valid", sql`${t.runType} IN ('reproduction', 'verification')`),
    check("runs_status_valid", sql`${t.status} IN ('queued', 'running', 'completed')`),
    check("runs_result_iff_completed", sql`(${t.status} = 'completed') = (${t.result} IS NOT NULL)`),
    check(
      "runs_result_matches_type",
      sql`${t.result} IS NULL OR (${t.runType} = 'reproduction' AND ${t.result} IN ('REPRODUCED', 'NOT_REPRODUCED', 'INCONCLUSIVE')) OR (${t.runType} = 'verification' AND ${t.result} IN ('VERIFIED_FIXED', 'STILL_BROKEN', 'INCONCLUSIVE'))`,
    ),
    check("runs_verification_has_attempt", sql`${t.runType} <> 'verification' OR ${t.attemptId} IS NOT NULL`),
    check("runs_infra_reason", sql`${t.infraError} = 0 OR ${t.infraErrorReason} IS NOT NULL`),
  ],
);

export const resolvedPlans = sqliteTable("resolved_plans", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .unique()
    .references(() => cases.id),
  specId: text("spec_id")
    .notNull()
    .references(() => reproSpecs.id),
  specHash: text("spec_hash").notNull(),
  sourceRunId: text("source_run_id")
    .notNull()
    .unique()
    .references(() => runs.id),
  planJson: text("plan_json").notNull(),
  planHash: text("plan_hash").notNull(),
  createdAt: createdAt(),
});

export const browserActions = sqliteTable(
  "browser_actions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    seq: integer("seq").notNull(),
    stepId: text("step_id").notNull(),
    actionJson: text("action_json").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [uniqueIndex("browser_actions_run_seq_unique").on(t.runId, t.seq)],
);

export const assertionResults = sqliteTable(
  "assertion_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    kind: text("kind").notNull(),
    assertionId: text("assertion_id").notNull(),
    type: text("type").notNull(),
    passed: integer("passed", { mode: "boolean" }).notNull(),
    expected: text("expected").notNull(),
    observed: text("observed").notNull(),
    detailsJson: text("details_json"),
  },
  (t) => [
    uniqueIndex("assertion_results_unique").on(t.runId, t.kind, t.assertionId),
    check("assertion_results_kind_valid", sql`${t.kind} IN ('assertion', 'signal')`),
  ],
);

/** Evidence metadata. Files live under ARTIFACT_DIR; only relative paths are stored. */
export const evidence = sqliteTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    kind: text("kind").notNull(),
    relativePath: text("relative_path").notNull(),
    mimeType: text("mime_type").notNull(),
    sha256: text("sha256"),
    metaJson: text("meta_json"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("evidence_run_path_unique").on(t.runId, t.relativePath),
    check("evidence_relative_path", sql`${t.relativePath} NOT LIKE '/%' AND ${t.relativePath} NOT LIKE '%..%'`),
  ],
);

/** Current display pointers. Historical targets live on attempts, runs and effects. */
export const externalLinks = sqliteTable("external_links", {
  caseId: text("case_id")
    .primaryKey()
    .references(() => cases.id),
  slackChannelId: text("slack_channel_id"),
  slackRootTs: text("slack_root_ts"),
  slackPermalink: text("slack_permalink"),
  linearIssueId: text("linear_issue_id"),
  linearIssueIdentifier: text("linear_issue_identifier"),
  linearIssueUrl: text("linear_issue_url"),
  currentAttemptId: text("current_attempt_id").references(() => fixAttempts.id),
  githubRepository: text("github_repository"),
  githubPrNumber: integer("github_pr_number"),
  githubPrUrl: text("github_pr_url"),
  githubCommitSha: text("github_commit_sha"),
  updatedAt: integer("updated_at").notNull(),
});

/** Accepted inbound business events, keyed on event identity. */
export const inboundEvents = sqliteTable("inbound_events", {
  eventKey: text("event_key").primaryKey(),
  eventType: text("event_type").notNull(),
  payloadHash: text("payload_hash").notNull(),
  caseId: text("case_id").references(() => cases.id),
  attemptId: text("attempt_id").references(() => fixAttempts.id),
  jobId: text("job_id"),
  responseJson: text("response_json").notNull(),
  receivedAt: integer("received_at").notNull(),
});

export const sideEffects = sqliteTable(
  "side_effects",
  {
    key: text("key").primaryKey(),
    type: text("type").notNull(),
    caseId: text("case_id").references(() => cases.id),
    runId: text("run_id").references(() => runs.id),
    attemptId: text("attempt_id").references(() => fixAttempts.id),
    status: text("status").notNull(),
    destinationJson: text("destination_json").notNull(),
    payloadJson: text("payload_json").notNull(),
    payloadHash: text("payload_hash").notNull(),
    /** Preallocated provider UUID or marker, reused on every delivery attempt. */
    providerIdentity: text("provider_identity").notNull().unique(),
    externalId: text("external_id"),
    resultJson: text("result_json"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
    sentAt: integer("sent_at"),
    completedAt: integer("completed_at"),
  },
  (t) => [
    index("side_effects_case_idx").on(t.caseId),
    check(
      "side_effects_status_valid",
      sql`${t.status} IN ('pending', 'sending', 'unknown', 'completed', 'failed')`,
    ),
    check("side_effects_completed_has_result", sql`${t.status} <> 'completed' OR ${t.externalId} IS NOT NULL`),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    /** Monotonic insertion order; FIFO claims order by this column. */
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    caseId: text("case_id").references(() => cases.id),
    runId: text("run_id").references(() => runs.id),
    attemptId: text("attempt_id").references(() => fixAttempts.id),
    effectKey: text("effect_key").references(() => sideEffects.key),
    payloadJson: text("payload_json").notNull(),
    payloadHash: text("payload_hash").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    cycleAttemptCount: integer("cycle_attempt_count").notNull().default(0),
    retryGeneration: integer("retry_generation").notNull().default(0),
    modelCalls: integer("model_calls").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.seq),
    index("jobs_case_idx").on(t.caseId),
    check("jobs_type_valid", sql`${t.type} IN ('generate_spec', 'reproduce', 'verify', 'deliver_effect')`),
    check("jobs_status_valid", sql`${t.status} IN ('pending', 'running', 'completed', 'failed')`),
  ],
);

export const transitions = sqliteTable(
  "transitions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    eventType: text("event_type").notNull(),
    eventKey: text("event_key").notNull(),
    trigger: text("trigger").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("transitions_case_event_unique").on(t.caseId, t.eventKey)],
);

/** Refused events. No FK on case_id: unmapped events are still audited. */
export const rejectedEvents = sqliteTable(
  "rejected_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    caseId: text("case_id"),
    eventType: text("event_type").notNull(),
    eventKey: text("event_key"),
    fromStatus: text("from_status"),
    reason: text("reason").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("rejected_events_case_idx").on(t.caseId)],
);
