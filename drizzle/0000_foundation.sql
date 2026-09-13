CREATE TABLE `app_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`next_case_number` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "app_meta_singleton" CHECK("app_meta"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `assertion_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`assertion_id` text NOT NULL,
	`type` text NOT NULL,
	`passed` integer NOT NULL,
	`expected` text NOT NULL,
	`observed` text NOT NULL,
	`details_json` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assertion_results_kind_valid" CHECK("assertion_results"."kind" IN ('assertion', 'signal'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assertion_results_unique` ON `assertion_results` (`run_id`,`kind`,`assertion_id`);--> statement-breakpoint
CREATE TABLE `browser_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`step_id` text NOT NULL,
	`action_json` text NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_actions_run_seq_unique` ON `browser_actions` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `cases` (
	`id` text PRIMARY KEY NOT NULL,
	`case_number` integer NOT NULL,
	`status` text NOT NULL,
	`report` text NOT NULL,
	`environment_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_team_id` text NOT NULL,
	`source_channel_id` text NOT NULL,
	`source_user_id` text NOT NULL,
	`source_trigger_id` text NOT NULL,
	`source_thread_ts` text,
	`spec_failure_kind` text,
	`spec_failure_reasons_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cases_case_number_unique` ON `cases` (`case_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `cases_source_trigger_unique` ON `cases` (`source_team_id`,`source_trigger_id`);--> statement-breakpoint
CREATE INDEX `cases_status_idx` ON `cases` (`status`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`relative_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`sha256` text,
	`meta_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "evidence_relative_path" CHECK("evidence"."relative_path" NOT LIKE '/%' AND "evidence"."relative_path" NOT LIKE '%..%')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_run_path_unique` ON `evidence` (`run_id`,`relative_path`);--> statement-breakpoint
CREATE TABLE `external_links` (
	`case_id` text PRIMARY KEY NOT NULL,
	`slack_channel_id` text,
	`slack_root_ts` text,
	`slack_permalink` text,
	`linear_issue_id` text,
	`linear_issue_identifier` text,
	`linear_issue_url` text,
	`current_attempt_id` text,
	`github_repository` text,
	`github_pr_number` integer,
	`github_pr_url` text,
	`github_commit_sha` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_attempt_id`) REFERENCES `fix_attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `fix_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`repository` text NOT NULL,
	`pr_number` integer NOT NULL,
	`commit_sha` text NOT NULL,
	`merged_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fix_attempts_case_pr_sha_unique` ON `fix_attempts` (`case_id`,`repository`,`pr_number`,`commit_sha`);--> statement-breakpoint
CREATE UNIQUE INDEX `fix_attempts_pr_sha_unique` ON `fix_attempts` (`repository`,`pr_number`,`commit_sha`);--> statement-breakpoint
CREATE TABLE `inbound_events` (
	`event_key` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`payload_hash` text NOT NULL,
	`case_id` text,
	`attempt_id` text,
	`job_id` text,
	`response_json` text NOT NULL,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `fix_attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`case_id` text,
	`run_id` text,
	`attempt_id` text,
	`effect_key` text,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`cycle_attempt_count` integer DEFAULT 0 NOT NULL,
	`retry_generation` integer DEFAULT 0 NOT NULL,
	`model_calls` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `fix_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`effect_key`) REFERENCES `side_effects`(`key`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "jobs_type_valid" CHECK("jobs"."type" IN ('generate_spec', 'reproduce', 'verify', 'deliver_effect')),
	CONSTRAINT "jobs_status_valid" CHECK("jobs"."status" IN ('pending', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_id_unique` ON `jobs` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency_key_unique` ON `jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`seq`);--> statement-breakpoint
CREATE INDEX `jobs_case_idx` ON `jobs` (`case_id`);--> statement-breakpoint
CREATE TABLE `rejected_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`case_id` text,
	`event_type` text NOT NULL,
	`event_key` text,
	`from_status` text,
	`reason` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rejected_events_case_idx` ON `rejected_events` (`case_id`);--> statement-breakpoint
CREATE TABLE `repro_specs` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`version` text NOT NULL,
	`spec_json` text NOT NULL,
	`spec_hash` text NOT NULL,
	`app_context_json` text NOT NULL,
	`app_context_hash` text NOT NULL,
	`generation_schema_json` text,
	`model_id` text,
	`generation_model_calls` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repro_specs_case_id_unique` ON `repro_specs` (`case_id`);--> statement-breakpoint
CREATE TABLE `resolved_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`spec_id` text NOT NULL,
	`spec_hash` text NOT NULL,
	`source_run_id` text NOT NULL,
	`plan_json` text NOT NULL,
	`plan_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`spec_id`) REFERENCES `repro_specs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resolved_plans_case_id_unique` ON `resolved_plans` (`case_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `resolved_plans_source_run_id_unique` ON `resolved_plans` (`source_run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`run_type` text NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`spec_id` text NOT NULL,
	`plan_id` text,
	`attempt_id` text,
	`commit_sha` text,
	`assertions_passed` integer,
	`assertions_total` integer,
	`signals_matched` integer,
	`infra_error` integer DEFAULT false NOT NULL,
	`infra_error_reason` text,
	`plan_recovered` integer DEFAULT false NOT NULL,
	`model_calls` integer DEFAULT 0 NOT NULL,
	`observations_json` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`spec_id`) REFERENCES `repro_specs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `fix_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runs_type_valid" CHECK("runs"."run_type" IN ('reproduction', 'verification')),
	CONSTRAINT "runs_status_valid" CHECK("runs"."status" IN ('queued', 'running', 'completed')),
	CONSTRAINT "runs_result_iff_completed" CHECK(("runs"."status" = 'completed') = ("runs"."result" IS NOT NULL)),
	CONSTRAINT "runs_result_matches_type" CHECK("runs"."result" IS NULL OR ("runs"."run_type" = 'reproduction' AND "runs"."result" IN ('REPRODUCED', 'NOT_REPRODUCED', 'INCONCLUSIVE')) OR ("runs"."run_type" = 'verification' AND "runs"."result" IN ('VERIFIED_FIXED', 'STILL_BROKEN', 'INCONCLUSIVE'))),
	CONSTRAINT "runs_verification_has_attempt" CHECK("runs"."run_type" <> 'verification' OR "runs"."attempt_id" IS NOT NULL),
	CONSTRAINT "runs_infra_reason" CHECK("runs"."infra_error" = 0 OR "runs"."infra_error_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `runs_case_idx` ON `runs` (`case_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `side_effects` (
	`key` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`case_id` text,
	`run_id` text,
	`attempt_id` text,
	`status` text NOT NULL,
	`destination_json` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`provider_identity` text NOT NULL,
	`external_id` text,
	`result_json` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `fix_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "side_effects_status_valid" CHECK("side_effects"."status" IN ('pending', 'sending', 'unknown', 'completed', 'failed')),
	CONSTRAINT "side_effects_completed_has_result" CHECK("side_effects"."status" <> 'completed' OR "side_effects"."external_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `side_effects_provider_identity_unique` ON `side_effects` (`provider_identity`);--> statement-breakpoint
CREATE INDEX `side_effects_case_idx` ON `side_effects` (`case_id`);--> statement-breakpoint
CREATE TABLE `transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`case_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`event_type` text NOT NULL,
	`event_key` text NOT NULL,
	`trigger` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transitions_case_event_unique` ON `transitions` (`case_id`,`event_key`);