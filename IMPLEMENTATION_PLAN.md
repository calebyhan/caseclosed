# CaseClosed MVP implementation plan

This is an execution plan, not an implementation. Repository review completed on 2026-09-13. No product code, dependencies, integrations, deployments, or eval results were created by this planning task.

Read: [README.md](README.md), [PRD](docs/PRD.md), [CONTRACTS](docs/CONTRACTS.md), [ARCHITECTURE](docs/ARCHITECTURE.md), [REPROSPEC](docs/REPROSPEC.md), [STATE_MACHINE](docs/STATE_MACHINE.md), [EVALS](docs/EVALS.md), [DEMO](docs/DEMO.md), the [existing schedule](docs/IMPLEMENTATION_PLAN.md), `.gitignore`, and `LICENSE`. The tracked repository is documentation only: no application, package manifest, migrations, tests, deployment configuration, or existing framework dependencies.

This root document is the implementation handoff requested for the full `/MVP`. The existing `docs/IMPLEMENTATION_PLAN.md` remains historical scheduling context. Its assumed four-person/24-hour schedule and cut ladder are not acceptance criteria. Do not drop MVP features or advance any `/CUT*` work. Milestone 0 synchronizes the documented contract corrections below before feature implementation.

The required loop is: real Slack intake → sufficient, validated ReproSpec → fixture reset and browser reproduction → deterministic verdict and evidence → one Linear issue → human-authored GitHub fix merged → matching deployed SHA confirmed → original experiment replayed → deterministic verification → real external updates. A superficial fix must produce `STILL_BROKEN`, followed by a second human fix and `VERIFIED_FIXED`. Linear stays open.

## Planning decisions and documentation corrections

User constraints take precedence, followed by the PRD's MVP requirements and the explicit classification tables. Keep the documented contract shapes except for the narrow amendments identified here and in section 3. These amendments fill missing implementation contracts; they do not add product features.

| Source / gap | Binding MVP decision |
|---|---|
| REPROSPEC “Recovery,” ARCHITECTURE browser budgets, and the old schedule allow an LLM call during verification; README, PRD, Evals, and literal replay forbid it. | Disable verification recovery entirely. Verification has no model dependency, including summaries. An unresolved saved action is `INCONCLUSIVE` with `step_unresolvable`. Retain `plan_recovered` as `false` for compatibility. |
| REPROSPEC's illustrative resolved plan flattens actions, unlike CONTRACTS §4. | Use `{ step_id, action: BrowserAction }` everywhere. Bind the saved plan to one immutable spec and successful reproduction run. |
| REPROSPEC lists locator fallback strategies which BrowserAction cannot encode. | Element actions use exact accessible role and name only. No label/text/test-ID substitution, coordinates, raw CSS, vision, or semantic recovery. The separate `text_visible` assertion remains supported. |
| CONTRACTS observations cannot represent hidden elements or timed URL checks; observation epochs and completeness are absent. | Add timestamped probe facts, explicit completed windows, action/response ordering, and collection errors as specified in §3.4. Missing measurement is different from a measured absence. |
| General prose says mixed evidence is inconclusive, but the verification table says otherwise. | Implement both truth tables exactly: mixed reproduction → `INCONCLUSIVE`; mixed verification → `STILL_BROKEN` unless infrastructure/collection failure dominates. |
| STATE_MACHINE delays leaving `STILL_BROKEN` until another fix is associated; PRD, Eval 3, and DEMO expect the case back in `WAITING_FOR_FIX`. | Finalize the run as `STILL_BROKEN`, record that transition, then immediately transition to `WAITING_FOR_FIX` in the same transaction. Preserve the verdict in run history and outbound payloads. Change the latter transition's trigger to “verification finalized; waiting for another fix.” |
| ARCHITECTURE/CONTRACTS retain `attempt_count/run_after`; PRD cuts the retry scheduler. | Durable FIFO SQLite jobs, one worker, bounded inline retry only. Keep `attempt_count` for diagnostics and restart-persistent limits; omit `run_after` and delayed scheduling. |
| Slack acknowledgment is listed before enqueueing, creating a crash gap. A slash command is also assumed to have a thread timestamp. | Atomically persist case, initial job, and Slack root-message intent before acknowledgment. Create the root asynchronously and persist the returned timestamp; subsequent replies depend on it. |
| The local “write, then save result” idempotency example cannot survive a successful remote create with a lost response. | Persist intent before sending; reconcile uncertain results using provider identity or a stable marker. A local completed-result cache alone does not satisfy Eval 7. See §3.7. |
| Mutable `external_links` cannot retain two fix attempts or target delayed comments correctly. | Add immutable fix attempts; bind verification jobs/runs and frozen comment payloads to their attempt, repository, PR, and SHA. Current external links are display pointers. |
| `retry: true` has no stable identity and could create repeated verification runs. | Require `retry_of_run_id` with `retry: true`. One new trigger per latest inconclusive predecessor; retransmissions return that trigger's existing job/run. |
| A deployment-ready payload does not establish that the build stays deployed while a queued run executes. | Serialize deploy swaps and browser experiments with one local staging lock. Check build SHA immediately before reset/replay and after observation collection. Mismatch/unavailability is `INCONCLUSIVE`. |
| Prebuilt PR-head artifacts cannot truthfully report an unknown future merge SHA. | Deploy an artifact built from the exact accepted merge commit. Prebuild only when that commit exists. Never relabel a different commit's artifact. Use DEMO's recorded-run timing fallback when necessary. |
| Eval 1 names intermediate statuses; Eval 8 implies merge alone creates verification. | Eval 1 asserts `REPRODUCED → ISSUE_FILED → WAITING_FOR_FIX` in history and final waiting state. Eval 8 must also deliver a valid deployment-ready event; merge alone creates zero verification jobs. |
| “2/2 INCONCLUSIVE” includes a report with no executable spec; “9/10 valid specs” includes three insufficient reports. | Count Eval 4 as an inconclusive-class `SPEC_FAILED` case with no browser run. Score correct validated generation/sufficiency decisions over all ten reports, and valid specs over the seven sufficient reports separately. |
| EVALS labels stale-deployment/invalid-transition checks stretch despite required MVP guards. | Test those existing guards in MVP unit/integration tests. Do not expand the seeded product scenarios. |
| Old schedule cuts evidence, sufficiency, `NOT_REPRODUCED`, case page, comments, or evals, and can pull permanent generated tests forward. | Retain the complete MVP. No runtime flags to fake fixes, generated regression-spec export, code-fixing agent, extra intake channel, API twins, or stretch dashboard. |

## 1. Repository structure

Use a root Next.js application, one plain TypeScript worker process, and a separate Next.js staging application in the same repository. Use native npm workspaces for the staging package; no monorepo orchestrator. API, worker, SQLite, artifacts, deployment script, and staging run on one persistent host. Do not deploy the API/worker as independent serverless instances with separate filesystems.

Use TypeScript, Next.js/React, SQLite with Drizzle and a compatible SQLite driver (`better-sqlite3`), Zod, Playwright/Chromium, and the official Gemini client. Use native `fetch` for Slack, Linear GraphQL, and GitHub REST. Use `node:test` through `tsx` for unit/integration tests and Playwright Test for browser tests. Pin compatible versions and commit the lockfile during M1. Do not add LangChain, LangGraph, CrewAI, Redis, Kafka, Temporal, vector databases, or a multi-agent runtime.

The following is the intended structure. Bracketed route names are literal Next.js directories. Files listed under `var/` are runtime output and must be ignored.

```text
/
├── IMPLEMENTATION_PLAN.md
├── README.md
├── LICENSE
├── .gitignore
├── .env.example
├── package.json
├── package-lock.json
├── tsconfig.json
├── next-env.d.ts
├── next.config.ts
├── drizzle.config.ts
├── playwright.config.ts
├── docs/                              # existing docs, synchronized in M0
├── config/environments/staging.json    # non-secret AppContext
├── drizzle/                           # generated, committed SQL migrations
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx                    # minimal service entry
│   │   ├── globals.css
│   │   ├── case/[id]/page.tsx
│   │   └── api/
│   │       ├── slack/command/route.ts
│   │       ├── github/webhook/route.ts
│   │       ├── caseclosed/deployment-ready/route.ts
│   │       ├── cases/[id]/route.ts
│   │       └── evidence/[id]/route.ts  # DB evidence ID, never arbitrary path
│   ├── components/case-detail.tsx      # timeline, runs, assertions, polling
│   ├── contracts/
│   │   ├── repro.ts                    # AppContext, spec, actions, plan, model I/O
│   │   ├── run.ts                      # observations, results, errors
│   │   └── lifecycle.ts                # statuses, events, jobs, HTTP DTOs
│   ├── domain/
│   │   ├── state-machine.ts
│   │   ├── validate-repro-spec.ts
│   │   ├── assertions.ts
│   │   ├── classify.ts
│   │   └── identity.ts                 # hashes and stable operation keys
│   ├── server/
│   │   ├── config.ts                   # validated secrets/runtime config
│   │   ├── composition.ts              # concrete dependencies, server only
│   │   ├── db/
│   │   │   ├── client.ts
│   │   │   ├── schema.ts
│   │   │   ├── repositories.ts
│   │   │   └── migrate.ts
│   │   ├── jobs/
│   │   │   ├── queue.ts
│   │   │   ├── worker.ts
│   │   │   └── recovery.ts
│   │   ├── services/
│   │   │   ├── intake.ts
│   │   │   ├── reproduction.ts
│   │   │   ├── verification.ts
│   │   │   ├── fix-lifecycle.ts
│   │   │   ├── deployment-ready.ts
│   │   │   └── case-query.ts
│   │   ├── model/
│   │   │   ├── client.ts
│   │   │   ├── generation-schema.ts
│   │   │   ├── generate-spec.ts
│   │   │   ├── resolve-step.ts
│   │   │   └── prompts.ts
│   │   ├── browser/
│   │   │   ├── runner.ts
│   │   │   ├── execute-action.ts
│   │   │   ├── observations.ts
│   │   │   └── environment.ts
│   │   ├── evidence/
│   │   │   ├── collector.ts
│   │   │   └── redact.ts
│   │   ├── integrations/
│   │   │   ├── transport.ts
│   │   │   ├── signatures.ts
│   │   │   ├── slack.ts
│   │   │   ├── linear.ts
│   │   │   ├── github.ts
│   │   │   └── render-messages.ts
│   │   └── side-effects/
│   │       ├── ledger.ts
│   │       └── deliver.ts
│   └── shared/staging-lock.ts           # worker and deploy script only
├── staging/acmecloud/
│   ├── package.json
│   ├── tsconfig.json
│   ├── next-env.d.ts
│   ├── next.config.ts
│   └── src/
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── dashboard/page.tsx
│       │   ├── settings/billing/page.tsx
│       │   ├── checkout/page.tsx
│       │   └── api/
│       │       ├── account/route.ts
│       │       ├── subscription/route.ts
│       │       ├── test/reset/route.ts
│       │       └── health/route.ts
│       └── server/
│           ├── fixture.ts
│           ├── session.ts
│           └── build-info.ts
├── scripts/
│   ├── preflight.ts
│   ├── smoke-model.ts
│   ├── create-storage-state.ts
│   ├── smoke-reproduction.ts
│   ├── build-staging.ts
│   ├── deploy-staging.sh
│   ├── deploy-staging.ts
│   ├── retry-job.ts
│   └── run-evals.ts
├── .github/workflows/
│   ├── ci.yml
│   └── deploy-staging.yml
├── fixtures/
│   ├── app-context.staging.json
│   ├── repro-spec.valid.json
│   ├── repro-spec.invalid.json
│   ├── spec-result.insufficient.json
│   ├── resolved-plan.valid.json
│   ├── observations.reproduced.json
│   ├── observations.fixed.json
│   ├── observations.superficial.json
│   ├── observations.infra-error.json
│   └── observations.mixed.json
├── tests/
│   ├── helpers/{database,fake-transport,clock}.ts
│   ├── unit/{contracts,assertions,classify,state-machine,model,association}.test.ts
│   ├── integration/{persistence,jobs,idempotency,slack,fix-lifecycle}.test.ts
│   ├── integration/{deployment-ready,run-finalization,case-query}.test.ts
│   └── e2e/{staging,reproduction,verification,case-page}.spec.ts
├── evals/
│   ├── reports.json
│   ├── scenarios.ts
│   └── results/                        # committed sanitized result summaries
└── var/                               # ignored, persistent local runtime
    ├── caseclosed.sqlite
    ├── artifacts/<run_id>/
    ├── auth/staging.json
    ├── locks/
    └── staging-builds/<commit_sha>/
```

Brace groups in the tree mean the individual named files, not literal filenames. Do not create empty abstraction directories or barrels. `domain/` and `contracts/` import neither database, browser, network, nor model code. Route handlers authenticate/parse and invoke services. Services own transactions and orchestration; adapters never advance case status. The worker is a separate entry point, never started by a Next.js route import.

## 2. Dependency-ordered milestones

Complete each milestone's tests and definition of done before dependent work. “Live” checks require actual configured services; label unavailable credentials as an operational blocker rather than replacing acceptance with a mock. M2/M3/M4 and then model/adapter work may run independently against the frozen contracts. Milestone order also provides a valid sequential path for one coding agent.

### M0 — Resolve contracts and operational prerequisites

- **Objective:** Make the decisions above executable and identify setup dependencies before feature code.
- **Files/modules:** This plan; corrections to README and the eight existing docs; `.env.example` specification; proposed contracts in §3.
- **Required interfaces:** Final spec/action/observation DTOs, event identities, retry payload, side-effect reconciliation, deployment identity, state transitions.
- **Tests required:** Contract review against every existing example and eval; explicit verification that every PRD MVP item maps to a milestone. No claim of an executed product test.
- **Definition of done:** Correct the contradictory docs, including the old plan's status as historical, and record model access as an M1 smoke-test gate. The preferred primary is **Gemini 3.8 Flash**; its API identifier/availability is unverified, so do not invent an ID. M1 records exact primary/fallback API IDs after credentialed checks; a fallback must be a configured, tested choice and visibly recorded when used. M0 completes with this operational gate identified, without depending on M1.
- **Dependencies:** None. Setup record names the one host, staging origin, public API URL/tunnel, Slack workspace/channel/app, Linear team and labels, GitHub repository/default branch/webhook, CI deployment access, storage-state path, and artifact directory. Configure external Linear/GitHub automation so the demo does not independently auto-close the issue.

### M1 — Scaffold the smallest runnable workspace

- **Objective:** Establish the two apps, worker entry point, configuration validation, and test commands.
- **Files/modules:** Package/config files, `src/server/config.ts`, composition/worker entry, `staging/acmecloud/` shell, scripts/preflight/model smoke, CI, gitignore.
- **Required interfaces:** Typed runtime config; injected HTTP transport/clock; Node-runtime route handlers; one shared absolute database/artifact path.
- **Tests required:** Install from lockfile, typecheck, test discovery, Next builds for both packages, Chromium launch, invalid/missing config failures, actual model structured-output smoke.
- **Definition of done:** API and staging start independently; worker starts exactly once; `npm run dev`, `worker`, `staging:dev`, `db:migrate`, `test:unit`, `test:integration`, `test:e2e`, `typecheck`, `build`, and `evals` have documented purposes. Future milestones fill pending commands before declaring them usable. Secrets, SQLite/WAL files, auth state, artifacts, and nested Next output are ignored.
- **Dependencies:** M0. Do not spend this milestone on UI styling or integration SDK frameworks.

### M2 — Build the controlled AcmeCloud experiment

- **Objective:** Supply a real, independently restartable target with deterministic reset and accessible controls.
- **Files/modules:** Staging routes/server files, AppContext, storage-state/build scripts, staging tests.
- **Required interfaces:** Reset, health, account and subscription endpoints in §3.8; exact landmarks from ARCHITECTURE; `pro_monthly_customer` fixture.
- **Tests required:** Repeated reset restores identical monthly-Pro state; unauthorized reset rejected; missing session handled; radio Annual, button Upgrade, status Loading, heading Checkout resolve uniquely; UI/network outcomes for buggy, superficial, and fixed commits.
- **Definition of done:** Three real source revisions/artifacts exist: buggy gives 500 plus persistent spinner; superficial clears spinner but retains 500/no checkout; fixed gives 200 plus checkout. Fixed revisions are prepared as human-authored demo fixes, not generated by CaseClosed. Health reports build provenance. Stopping the process supplies the unavailable scenario.
- **Dependencies:** M1. AppContext is identical across variants and contains application knowledge; generator source contains none of these app-specific facts.

### M3 — Implement strict contracts and the deterministic verdict engine

- **Objective:** Establish correct classification before any model/browser integration.
- **Files/modules:** `src/contracts/*`, `domain/validate-repro-spec.ts`, `assertions.ts`, `classify.ts`, `identity.ts`, all JSON fixtures, unit tests.
- **Required interfaces:** `validateReproSpec`, `evaluateChecks`, `classify`, immutable experiment identity, amended observations.
- **Tests required:** Every assertion/signal variant and truth-table row; infrastructure dominance; both mixed patterns; empty/missing/duplicate facts; response method/OPTIONS/last-match/ties/no-match; timing boundaries; hidden/absent elements; timed URLs; schema/semantic/path guards.
- **Definition of done:** Fixtures classify correctly without I/O or model calls. Counts derive from the spec; invalid/incomplete observations cannot produce a success verdict. The nested resolved-plan shape and snapshots/hashes are fixed.
- **Dependencies:** M1 and M0 contracts. Does not require a running staging app or model.

### M4 — Implement canonical persistence and guarded transitions

- **Objective:** Make lifecycle history, experiment identity, and run results durable and auditable.
- **Files/modules:** DB schema/client/migrations/repositories, state machine, case-query service, persistence/state tests.
- **Required interfaces:** Transactional repository and event-guarded transitions in §3.1–3.2; normalized result/evidence rows plus observation snapshot.
- **Tests required:** Empty-DB migration; foreign keys/unique constraints; every allowed edge and representative forbidden edge; stale expected-status update; semantic preconditions; rejection logging survives refusal; failed transaction leaves no partial case/spec/run/job.
- **Definition of done:** Cases advance only through one guarded path. Every accepted transition and rejected event is queryable. A stored verdict can be recomputed from its immutable spec/observations without a model or browser.
- **Dependencies:** M3.

### M5 — Implement durable jobs and prove outbound idempotency

- **Objective:** Survive duplicate triggers, process restarts, and uncertain remote responses without duplicate business effects.
- **Files/modules:** Queue/worker/recovery, ledger/deliver, transport, fake transport helper, job-retry script, integration tests.
- **Required interfaces:** `enqueueUnique`, `claimNext`, stable `job.run_id`, immutable effect request, adapter `reconcile/send`.
- **Tests required:** Duplicate enqueue before claim; one worker/one browser slot; restart after claim and after result commit; no retry-created run ID; completed result never replays browser; remote success then dropped response and process restart; unknown outcome never blindly creates again.
- **Definition of done:** Side-effect intent is persisted before network calls; fake remote entity counts and database counts agree. Interrupted browser runs finalize the existing run as inconclusive. Retry counts survive restart. Operational failures remain visible without changing a deterministic verdict.
- **Dependencies:** M4. Complete this foundation before live writes.

### M6 — Implement model interpretation and per-step resolution

- **Objective:** Convert reports and current page context into validated data with bounded model use.
- **Files/modules:** Model client/schema/prompts/generate/resolve, spec-generation job handling, `evals/reports.json`, model tests.
- **Required interfaces:** `SpecGenerator.generate`, `StepResolver.resolve`, shared audited model wrapper and per-run counter.
- **Tests required:** Sufficiency invariant; nonempty missing reasons when insufficient; malformed/semantically invalid responses with validation feedback; exactly three maximum generation calls, including restart after dispatch before response; 20-second timeout; bounded action retry; fallback counted; no app facts hardcoded; prompt contains no configured secrets.
- **Definition of done:** Ten labeled reports exist, seven sufficient/three insufficient. Valid spec and source inputs are stored once; invalid/insufficient reports end in `SPEC_FAILED` with a reason, no browser job, no Linear issue. Provider/configuration failures are visible job errors rather than invented insufficiency. Report live corpus metrics separately from mock tests.
- **Dependencies:** M3–M5. Staging browser integration is not needed for mock resolver tests.

### M7 — Deliver the real reproduction walking skeleton

- **Objective:** Reset staging, run constrained actions, collect complete evidence, and classify the real behavior.
- **Files/modules:** Browser runner/action/observations/environment, evidence collector/redaction, reproduction service, smoke script, browser tests.
- **Required interfaces:** `BrowserRunner.reproduce`, shared environment lock, observer facts, `EvidenceCollector`, transactional `finalizeRun`.
- **Tests required:** Fixture-spec smoke against real buggy/fixed/unavailable builds; exact locator uniqueness; same-origin restriction; action/time budgets; fresh storage state; network listeners armed before actions; probe windows in parallel; screenshots/logs and redaction; incomplete evidence maps to inconclusive.
- **Definition of done:** First run a fixture spec through the real browser and classifier, then replace fixture generation/resolution with M6. Live report-to-reproduction works. Only `REPRODUCED` promotes the successful plan. Persist all actions and evidence together with the final result.
- **Dependencies:** M2–M6. The fixture-only smoke is a test seam, never the final intake implementation.

### M8 — Prove literal zero-model verification

- **Objective:** Independently reject the superficial fix and accept the real fix using the original experiment.
- **Files/modules:** Verification service, shared runner's replay entry, immutable plan loading/validation, verification browser tests.
- **Required interfaces:** `BrowserRunner.verify` with no resolver/model parameter; run-bound spec/plan/fixture/SHA; deterministic result renderer.
- **Tests required:** Buggy reproduction → superficial replay gives `STILL_BROKEN`; fixed replay gives `VERIFIED_FIXED`; model wrapper replaced with a throwing stub plus persisted call count zero; byte/hash equality; renamed/missing locator, tampered plan/context, missing step, reset failure, and browser crash are inconclusive.
- **Definition of done:** Verification neither regenerates data nor changes actions/assertions/timeouts. Each original step executes in order. `plan_recovered=false`, `model_calls=0`, and complete evidence are recorded for every verification run.
- **Dependencies:** M7. Tests may create authorized lifecycle fixtures in temporary databases; the product exposes no bypass endpoint.

### M9 — Wire real Slack intake and Linear handoff

- **Objective:** Turn a real slash command into one useful engineering issue and one Slack thread.
- **Files/modules:** Slack route/signatures/intake/adapter, Linear adapter, message renderer, relevant effect handlers/tests.
- **Required interfaces:** Signature-verified intake; `SlackAdapter`; `LinearAdapter`; root dependency; reconciled external UUID and identifier.
- **Tests required:** Raw-body signature and timestamp validation; invalid input; duplicate trigger returns same case; acknowledgment under three seconds while worker is busy; one root; lost Slack/Linear response reconciliation; no Linear issue for insufficient/not-reproduced/inconclusive cases.
- **Definition of done:** Real Slack → real model → real browser → one real Linear issue → threaded Slack evidence/link. Issue contains original report, expected/actual, steps, failing assertion observations, screenshot, and case URL. Link completion atomically advances to `WAITING_FOR_FIX`.
- **Dependencies:** M5–M7. Use dedicated test destinations; this is the first live intake/handoff checkpoint.

### M10 — Implement GitHub association and deployment-gated verification

- **Objective:** Accept a real human fix only through merge followed by confirmation of the exact deployed commit.
- **Files/modules:** GitHub webhook/adapter, fix-lifecycle/deployment-ready services/routes, shared lock, deploy scripts/workflow, tests.
- **Required interfaces:** Immutable `FixAttempt`, merge event identity, deployment DTO with explicit retry predecessor, health SHA and job reservation.
- **Tests required:** Open/unmerged/unassociated/wrong-repository/conflicting-reference PRs cannot verify; corrected-body association on redelivery uses fetched metadata; duplicate merge before/after processing; merge alone creates no verification job; early/stale/wrong-PR/wrong-SHA/wrong-secret ready events; duplicate ready while queued/running/finished; delayed duplicate explicit retry; deploy/run mutual exclusion and SHA change detection.
- **Definition of done:** Actual GitHub merge plus actual deployment triggers M8. CI and local fallback use the same deploy script/endpoint. New SHA accepted after failed fix, while old/duplicate events preserve history. No merge or health response alone can finalize a verdict.
- **Dependencies:** M2, M4–M5, M8–M9.

### M11 — Finish the two-fix loop and all external projections

- **Objective:** Carry each run's evidence to the correct Slack thread, Linear issue, and GitHub PR.
- **Files/modules:** Verification finalization, integration adapters/renderers, effect handlers, end-to-end lifecycle tests.
- **Required interfaces:** Frozen per-run notification targets; managed-label reconciliation; transient-state transitions; inconclusive retry.
- **Tests required:** PR A superficial → waiting → PR B real fix; no duplicated comments; delayed A notification targets A; stale label intent cannot undo B's label; inconclusive preserves issue/merge/plan; retry gets new run while job retry does not; Linear state never changed.
- **Definition of done:** One case, one spec, one plan, one Linear issue, three completed runs, two fix attempts, both PR comments and Slack/Linear updates. Final verdict is `VERIFIED_FIXED`; Linear remains open. Inconclusive verification has an explicit, tested retry route.
- **Dependencies:** M10.

### M12 — Ship the database-backed case page and evidence access

- **Objective:** Make every verdict inspectable and provide the demo's persisted-state fallback.
- **Files/modules:** Case route/API/query, case-detail component, evidence-ID route, case-page tests.
- **Required interfaces:** Read-only `CaseDetail` DTO with transitions/rejections, spec, runs, assertions, evidence, external links, and operational job/effect errors.
- **Tests required:** Real persisted case renders every required section; failed/absent evidence is labeled; correct run/PR associations; active polling every two seconds; terminal case with pending projections continues polling until delivery settles; arbitrary filesystem paths inaccessible.
- **Definition of done:** Original report/environment/status, timeline, readable ReproSpec, run cards, full assertion/signal tables, screenshots, network/console, external IDs/links, and errors are visible. No model/browser/external API reads on page load. No auth/dashboard/admin expansion.
- **Dependencies:** M4, M7, M11. Presentation can be developed earlier using stored fixtures.

### M13 — Execute evals and rehearse the actual demo

- **Objective:** Demonstrate complete MVP behavior and record honest reliability results.
- **Files/modules:** Eval harness/corpus/results, tests, EVALS result table, DEMO setup/runbook, README commands.
- **Required interfaces:** Scenario setup and bounded waits over persisted state; actual Slack submission procedure; deploy helper; per-trial external identity namespace.
- **Tests required:** All eight evals plus companion 8b; three complete clean-database golden paths; ten-report corpus; every verification model counter; live integrations; two timed demo rehearsals.
- **Definition of done:** Populated EVALS table and linked sanitized result artifacts include actual outcomes, counts, SHAs, run IDs, call counts, and named failures. Required deterministic gates pass; Eval 3 never fails; false verified fixes and duplicate effects/runs are zero. Verify both deploy and replay timing; use honest persisted-run fallback if needed.
- **Dependencies:** M11–M12 and all earlier checks. An unavailable live dependency is an incomplete acceptance check, not a passing simulated eval.

## 3. Core interfaces and ownership

These are intended TypeScript boundaries; convert data shapes to Zod where they cross process, storage, model, or HTTP boundaries. Preserve existing schema version `"1"` because no implementation/data exists yet. Record the amendments in CONTRACTS before freezing them.

### 3.1 State machine and persistence

```ts
type RunType = "reproduction" | "verification";
type TransitionDecision =
  | { accepted: true; next: CaseStatus }
  | { accepted: false; reason: string };

decideTransition(state: CaseSnapshot, event: CaseEvent): TransitionDecision;

interface CaseRepository {
  transaction<T>(work: (tx: CaseTx) => T): T; // synchronous; no external I/O
  getCaseDetail(caseId: string): CaseDetail | null;
  loadExperiment(caseId: string): ExperimentSnapshot;
}
// CaseTx exposes guarded transition, run finalization, link/attempt insertion,
// and unique job/effect insertion. It is not a public arbitrary-status setter.
```

`CaseEvent` is a discriminated union of `spec_created`, `spec_failed`, `reproduction_claimed`, `reproduction_completed`, `issue_confirmed`, `fix_merged`, `deployment_ready`, `verification_completed`, `verification_retry`, and the internal `await_fix`/`await_deployment` edges. Each carries `event_key`, case ID, and relevant spec/run/attempt/job identity. The state machine checks both the allowed pair and event-specific facts. Only services construct completion events from persisted classifier results.

Keep all documented statuses. The transition table in STATE_MACHINE is authoritative with the immediate `STILL_BROKEN → WAITING_FOR_FIX` correction above. Record transient `FIX_MERGED`, `ISSUE_FILED`, and `STILL_BROKEN` transitions even when their successor is committed immediately. No public “set status” API.

Required semantic guards: valid stored spec before reproduction; completed matching reproduction before plan promotion; reconciled Linear ID before `ISSUE_FILED`; accepted merge attempt before deployment wait; matching accepted deployment before verification; same run type/case/attempt and complete deterministic result before finalization. A stale worker result cannot finalize a newer attempt.

Use short SQLite transactions, WAL, foreign keys, and a finite `busy_timeout` below Slack's acknowledgment budget (start at 1000 ms). Conditional status updates use the expected current status. Rejected operations commit a redacted `rejected_events` row and no transition; do not throw in a way that rolls the audit row back.

Use the CONTRACTS tables with these explicit constraints/additions:

| Entity | Required identity and additions |
|---|---|
| `cases` | Primary ID `CC-` plus a monotonically allocated number, padded to at least four digits. Store Slack workspace/user IDs and nullable thread timestamp. Unique `(source_team_id, source_trigger_id)`. Store spec failure kind/reasons. |
| `app_meta` (small addition) | Database-instance UUID and next-case sequence, allocated transactionally. External markers include instance UUID so fresh eval databases cannot collide with old remote `CC-0001` objects. |
| `repro_specs` | One immutable row per case; spec JSON/hash, schema version, canonical AppContext JSON/hash, generation-schema snapshot, model ID and generation call count. Store exact normalized input snapshots; never overwrite after reproduction. |
| `resolved_plans` | One immutable row per case; spec ID/hash, source reproduction run ID, nested plan JSON/hash. Require exactly one successful action for every spec step in order. |
| `runs` | `queued/running/completed` status; nullable result until finalized; spec ID, nullable plan ID before promotion, attempt ID for verification, immutable commit SHA, observation JSON, counters/times. Type/result consistency enforced. |
| `browser_actions` | Unique `(run_id, seq)`; action attempts include timestamp, success, error, step ID. Winning plan includes only the one successful action per step. |
| `assertion_results` | Unique `(run_id, kind, assertion_id)`; raw expected/observed details and passed/matched flag. Totals come from the spec. |
| `evidence` | ID, run ID, kind, relative path, MIME type, hash, metadata. Unique finalized artifact name per run. |
| `fix_attempts` (addition) | ID, case ID, repository, PR number, merge SHA, merged timestamp. Unique `(case_id, repository, pr_number, commit_sha)` and globally unique `(repository, pr_number, commit_sha)`: one merged PR revision cannot be rebound to another case. Never overwrite earlier attempts. |
| `external_links` | One row per case; Slack root/permalink; Linear UUID, human identifier, URL; current GitHub attempt pointer/URL. Historical targets live with attempts/runs/effects. |
| `inbound_events` (addition) | Unique accepted business event key, payload hash, type, case/attempt/job IDs, saved response, receipt time. Rejected premature events do not reserve this key permanently. |
| `jobs` | Unique idempotency key; type, status, case/run/attempt IDs, frozen payload, cumulative attempt count, delivery-cycle attempt count, retry generation, model-call count, error, created/started/finished times. Model counts are independent of job/HTTP attempts. No `run_after`. |
| `side_effects` | Key primary key; `pending/sending/unknown/completed/failed`; frozen destination/payload/hash; preallocated provider UUID or marker; external ID/result; attempts/error/times. |
| `transitions` / `rejected_events` | Chronological ID/timestamp and trigger/event key. Rejections allow null case ID for unauthenticated/unmapped events, retaining only safe metadata. |

Run/job/evidence/attempt IDs are random UUIDs. Case number allocation uses `app_meta` within intake's transaction; it is not `SELECT MAX(id)+1` outside a transaction. Normalize hashes with recursive sorted-object-key JSON serialization, preserving array order, UTF-8, and the `sha256:` prefix. Snapshot the parsed/defaulted values actually used.

Atomic units:

1. Intake: accepted event + case + generation job + Slack root effect and delivery job; then acknowledge.
2. Spec success: immutable spec + `SPEC_CREATED` + unique reproduction job.
3. Browser-job claim: set running job, allocate/set `run_id` once, snapshot experiment/attempt, and enter `REPRODUCING` if applicable. A verification job already reserved by deployment acceptance is displayed as queued until claimed.
4. Run finalization: observation/result/action/assertion/evidence records + immutable plan on reproduction success + transition(s) + all resulting effect/job intents + browser job completion.
5. Linear confirmation: completed effect + stored issue identifiers + `ISSUE_FILED → WAITING_FOR_FIX` + link notification intent.
6. Merge acceptance: accepted event + immutable attempt + current pointer + `FIX_MERGED → WAITING_FOR_DEPLOYMENT`.
7. Deployment acceptance: event identity + unique verification job + `VERIFYING`; retry first records `VERIFICATION_INCONCLUSIVE → WAITING_FOR_DEPLOYMENT`.

Append action intent before dispatch and action outcome after completion using short run-scoped writes; write captured screenshots and checkpoint logs as they become available. Finalization validates/upserts these rows by stable sequence/identity rather than duplicating them. A crash preserves only already-durable observations/artifacts: mark all lost or uncertain data `not_observed`, never reconstruct it as fact. Artifacts are written/renamed to finalized files before the DB finalization transaction. An orphan file after a crash is not a finished run. No transaction spans a model, browser, HTTP call, or sleep.

### 3.2 Job queue and recovery

```ts
type JobType = "generate_spec" | "reproduce" | "verify" | "deliver_effect";
enqueueUnique(tx: CaseTx, job: NewJob): { jobId: string; created: boolean };
claimNext(): ClaimedJob | null;
processJob(job: ClaimedJob): Promise<void>;
recoverInterruptedJobs(): Promise<void>;
```

One worker owns all browser runs and outbound writes. A process mutex guards its claim loop; a startup singleton lock refuses a second worker. Claim pending rows with conditional UPDATE in a transaction. FIFO applies to eligible jobs; a Slack reply is eligible only after its root effect has completed. Failed/blocked effects must not stall unrelated cases.

Job keys: `spec:<case_id>`, `reproduce:<case_id>`, `verify:<case_id>:<sha>:initial`, `verify:<case_id>:<sha>:retry:<predecessor_run_id>`, and `effect:<effect_key>`. Job uniqueness reserves verification before the worker claims it; `jobs.run_id` is assigned atomically on first claim and reused.

Use at most three attempts per automatic delivery cycle for transient integration calls, with short inline delays (500 ms, 1500 ms); honor Retry-After only within a bounded 10-second inline wait, otherwise leave the operational job failed with retry guidance. Use a 10-second HTTP timeout. Persist both cumulative and current-cycle consumed attempts; a process restart does not reset the cycle. Never retry a potentially committed create without reconciliation. Credentials/permissions and deterministic browser verdicts are not retryable. Model budgets are separate and specified below.

On restart:

- Pending jobs remain eligible.
- Completed runs never execute again; resume only their unfinished projection effects.
- An interrupted browser run is finalized under its existing run ID as `INCONCLUSIVE/worker_interrupted`, retaining partial evidence. Do not resume from an action cursor or silently rerun/reset a half-completed experiment.
- A `sending` effect becomes `unknown` and must reconcile before further delivery.
- Unfinished generation resumes only if no spec is committed and its call budget remains.
- `retry-job.ts <job_id>` explicitly starts a new bounded delivery/reconciliation cycle for a failed operational integration job: increment retry generation, reset only its cycle-attempt count, retain cumulative counts and provider identity. An unknown effect gets reconciliation reads, never new permission to blindly send. Generation jobs may resume only their unspent original three-call budget; an exhausted generation budget is not reset. The script refuses completed browser runs and never mutates case statuses directly. A new verification experiment uses the deployment retry contract.

### 3.3 Spec generation and immutable replay contract

```ts
interface SpecGenerator {
  generate(input: {
    caseId: string; report: string; appContext: AppContext;
    appContextHash: string; signal: AbortSignal;
  }): Promise<SpecGenerationResult>;
}
interface StepResolver {
  resolve(input: {
    runId: string; step: ReproSpec["steps"][number];
    accessibilitySnapshot: string; appContext: AppContext;
    signal: AbortSignal;
  }): Promise<BrowserAction>;
}
validateReproSpec(spec: ReproSpec, ctx: AppContext, caseId: string):
  { ok: true; spec: ReproSpec } | { ok: false; errors: ValidationError[] };

type ExperimentSnapshot = {
  caseId: string; specId: string; spec: ReproSpec; specHash: string;
  appContext: AppContext; appContextHash: string;
  planId: string | null; plan: ResolvedPlan | null; planHash: string | null;
};
```

Use CONTRACTS' Zod schemas, strengthened with strict objects, supported ARIA roles, unique nonempty IDs, maximum 15 steps, `min <= max`, and the sufficiency invariant. Require a nonempty `missing` list when insufficient and an empty list when sufficient. The application supplies case/environment/hash identity; verify the generated values match rather than trusting model-provided identity.

Semantic validation checks known fixture/start route, declared endpoint/method for network checks, nonempty URL/text match strings, and supported landmarks where applicable. Reject protocol-relative URLs, backslashes, cross-origin redirects/navigation, credentials in URLs, and paths outside the declared origin/routes. All proposed actions are validated again before browser execution. Retain the documented `finish` union variant as reserved compatibility data, but reject it in MVP step resolution and plan validation: a no-op must not replace the final required interaction. The runner terminates through control flow after executing all steps. At least one real interaction/navigation is required across the completed plan.

AppContext stays constant across the three builds. Persist its normalized snapshot/hash and verify the configured context still matches before replay; context drift yields `INCONCLUSIVE/environment_changed`, not an updated experiment. The plan's schema version alone is not identity.

All model calls go through one wrapper with a 20-second timeout and persisted count before dispatch. Persist generation calls on the generation job before any spec exists; its frozen input payload holds report, AppContext, and generation-schema snapshots even for insufficient/failed reports. Copy the final count to the spec when one is committed. Persist step-resolution calls on the active run. Spec generation permits the initial call plus two retries total, including schema/semantic failures, timeouts, and fallback attempts. Feed validation errors back within that budget. Insufficiency is a valid result, not a reason to spend retries. Provider outages exhausted after retries leave a visible failed generation job; they do not invent missing information.

During reproduction, each step receives one initial resolution. Allow one additional resolution across the entire run for an invalid action or a locator known not to have executed. Do not repeat an interaction after a timeout with uncertain browser effects; return inconclusive. Model calls count against the 45-second browser-run deadline. Use the chosen SDK's supported JSON-schema output path; if discriminated-union generation is rejected, use CONTRACTS' flattened generation schema while keeping strict Zod validation as the only application-facing shape.

Use deterministic summaries/templates for all external output in MVP. This eliminates a third model dependency and preserves zero calls throughout verification and its projections.

### 3.4 Browser runner, assertion engine, and evidence

```ts
interface BrowserRunner {
  reproduce(input: BrowserInput, resolver: StepResolver): Promise<RunObservations>;
  verify(input: BrowserInput & {
    plan: ResolvedPlan; expectedCommitSha: string;
  }): Promise<RunObservations>; // no model/resolver dependency
}
type BrowserInput = {
  runId: string; experiment: ExperimentSnapshot; signal: AbortSignal;
};

type ProbeSample =
  | { at_ms: number; kind: "element"; match_count: number; visible: boolean }
  | { at_ms: number; kind: "text"; visible: boolean }
  | { at_ms: number; kind: "url"; url: string };

type ProbeObservation = {
  check_id: string; check_kind: "assertion" | "signal";
  samples: ProbeSample[]; deadline_ms: number;
  complete: boolean; error?: string;
};
// Extend CONTRACTS.RunObservations with:
// probe_epoch_ms, probes: ProbeObservation[], collection_complete,
// network_window: { started_at_ms, ended_at_ms, complete },
// health_before/health_after, spec_hash/plan_hash/app_context_hash.
// Network rows add seq; action rows add seq and started/finished timestamps.
// Replace the insufficient element_probes/text_probes fields; retain final_url
// for display. All times use the same run-relative monotonic clock.

evaluateChecks(observations: RunObservations, spec: ReproSpec): CheckResults;
classify(observations: RunObservations, spec: ReproSpec, runType: RunType): RunResult;

interface EvidenceCollector {
  start(runId: string): Promise<void>;
  screenshot(kind: "before" | "failure" | "after"): Promise<EvidenceRef>;
  finalize(observations: RunObservations, result: RunResult): Promise<EvidenceRef[]>;
}
```

The runner performs fixture reset, creates a fresh context with the same storage state, checks authentication, starts at the spec's start path, executes every step, and gathers observations. Use a pinned Chromium version, fixed viewport/locale/timezone, no service-worker cache, and no external-origin browsing. No arbitrary JavaScript supplied by the model; fixed instrumentation code is allowed. Multiple popups/tabs are unsupported and fail the experiment.

The 45-second deadline includes reset, browser startup, action resolution/execution, and observation collection; queue wait and initial report-to-spec generation are outside it. Each browser action has a maximum 5-second timeout and all executed actions (including start navigation, waits, and unsuccessful attempts) consume the 15-action budget. Validate total planned action count including start navigation before promoting a plan. Fixture reset is not a browser action. Hard deadline cancels remaining work and closes the context. Standard fixed-fixture replay target is at most 15 seconds, not a weakened deadline.

Observation semantics:

1. Arm network/console collectors before start navigation. Keep setup traffic in diagnostics if useful, but matching uses only same-origin browser responses after the first planned action begins. Exclude reset, health, authentication setup, and all OPTIONS responses.
2. Set the probe epoch immediately after the last planned action completes. Sample current state at that epoch, then collect all assertion/signal probes concurrently. Their deadlines are relative to this one epoch in both reproduction and verification.
3. `element_visible` passes on a uniquely matched visible element within its window. `element_not_visible` passes on observed absence or hiding within its window. Multiple matching elements make measurement ambiguous and invalidate the run. `text_visible` uses exact visible text; `url_contains` uses timestamped URLs. A visible element already present at the epoch qualifies.
4. Use a 50 ms nominal probe cadence and schedule explicit deadline samples. `element_still_visible_after_ms` measures at the first sample in `[after_ms, after_ms + 100 ms]`, rather than succeeding at its first appearance. The fixed 100 ms sampling tolerance is part of the observation protocol, identical in both run types, and is shown with actual sample times. A sample outside that band cannot establish threshold visibility; mark the probe incomplete. A spinner appearing only after the band cannot match this signal. For `within_ms` checks, only successful samples at or before the deadline qualify; a negative completion sample may arrive up to 100 ms late, otherwise collection is incomplete. Test ordinary jitter, excess lateness, and post-window appearance. Never extend windows dynamically.
5. Define the common collection window as the maximum of 5000 ms, assertion/signal `within_ms`, and signal `after_ms`; this is bounded by the existing 10000 ms maximum. Continue network collection until that cutoff, even if DOM assertions pass early. Never stop verification at the first success.
6. Network assertions/signals use exactly the documented method + URL-substring rule and final response by `(timestamp_ms, seq)` within the window. Ignore subsequent GETs for a POST check. A completed window with no matching response yields failed/unmatched and `no_matching_request`. A broken collector/window yields an infrastructure error.
7. Persist facts, completion flags, and actual timings, not just verdict booleans. First-visible/first-hidden events can complete a `within_ms` probe early; otherwise completion requires observing its deadline. Missing/duplicate check IDs, malformed facts, or unexecuted steps invalidate the whole run.

The collector records facts; the pure engine applies the predicates and classification. Retain CONTRACTS' `RunResult` fields and exactly one outcome per assertion and signal, even on infrastructure failure (use `not_observed` for unavailable data). Signal `passed=true` means “matched”; render that terminology clearly. The engine derives totals from the frozen spec and gives infrastructure failure first priority:

| Run type | Ordered condition | Result |
|---|---|---|
| Either | Infrastructure error or invalid/incomplete experiment | `INCONCLUSIVE` |
| Reproduction | At least one signal, at least one failed assertion | `REPRODUCED` |
| Reproduction | No signals, all assertions pass | `NOT_REPRODUCED` |
| Reproduction | Remaining mixed combinations | `INCONCLUSIVE` |
| Verification | No signals, all assertions pass | `VERIFIED_FIXED` |
| Verification | Any signal or any failed assertion | `STILL_BROKEN` |

Keep documented infrastructure reasons and add `worker_interrupted`, `environment_changed`, `deployment_changed`, `observations_incomplete`, and `evidence_write_failed`. Use `step_unresolvable` for missing/ambiguous saved action targets. No successful verification accepts model calls, changed hashes, or `plan_recovered=true`.

Always gather facts needed by assertions/signals regardless of evidence flags. For the MVP, semantic validation requires screenshot/network/console/action evidence flags to be true. Write `before.png`, `after.png`, `failure.png` when assertions fail or signals match, `network.json`, `console.json`, `actions.json`, `assertions.json`, `observations.json`, and `result.json`. On an early infrastructure failure, store whatever was captured and explicit reasons for missing artifacts. Do not fabricate screenshots.

Redact credentials, cookies, authorization headers, sensitive query values, and known secrets before persistence, prompts, or external rendering. Collect network method/URL/status/time rather than response bodies or request headers by default. Use only the synthetic staging account. Evidence access resolves an opaque evidence ID through the DB and validates its local path under the artifact root; external systems receive accessible evidence/case URLs, not local filesystem paths.

### 3.5 Slack and Linear integration

```ts
interface SlackAdapter {
  createCaseThread(request: FrozenSlackRoot): Promise<SlackMessageRef>;
  reply(request: FrozenSlackReply): Promise<SlackMessageRef>;
  reconcile(request: FrozenEffect): Promise<Reconciliation>;
}
interface LinearAdapter {
  createIssue(request: FrozenLinearIssue): Promise<LinearIssueRef>;
  comment(request: FrozenLinearComment): Promise<LinearCommentRef>;
  applyManagedLabels(request: FrozenLabelIntent): Promise<void>;
  reconcile(request: FrozenEffect): Promise<Reconciliation>;
}
```

`POST /api/slack/command` verifies the signature over raw URL-encoded bytes and rejects stale timestamps before trusting fields. Validate workspace, channel, command, report, and trigger identity. Persist the transaction before returning a small ephemeral acknowledgment containing case ID/URL. No model, browser, outbound HTTP, or in-memory fire-and-forget task is on this path. Slack requires acknowledgment within three seconds; its official threading example posts a root and replies using the returned timestamp. [Slack slash-command documentation](https://docs.slack.dev/interactivity/implementing-slash-commands/)

Dedupe exact authenticated `(team_id, trigger_id)` invocations. Log retry headers as diagnostics only. Check real payload behavior early; the documentation's 60-second text-bucket fallback can merge distinct intentional reports, so do not silently adopt it. If trigger IDs are missing/unstable, use a persisted hash of the exact authenticated request's timestamp and raw body for transport redelivery and report its narrower guarantee. A deliberate new slash command creates a new case.

Root creation uses `slack:case-created:<trigger_id>`. Store root timestamp on completion and reply only to it. Send spec-failure reasons, reproduction verdict/evidence, Linear handoff, waiting-for-deployment progress, and each verification verdict. Use persisted event/run identities rather than current status to render delayed replies.

Create Linear only after `REPRODUCED`. Its frozen body contains customer words, goal, expected/actual, steps, assertion observations, network summary, screenshot, CaseClosed ID and URL. Persist both UUID and human identifier such as `ENG-142`. Include the reproduced label in creation where supported; follow-up labels remain ledgered operations.

Preallocate one random UUID in the effect intent for Linear issue/comment creation, reuse it on every request, and query that ID after uncertain success. Linear's published schema currently exposes client-supplied UUID fields for both operations; recheck current behavior in the credentialed adapter smoke test, including duplicate-ID error followed by lookup. [Linear schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql) [Linear GraphQL guide](https://linear.app/developers/graphql)

Preserve user labels. Keep `caseclosed-reproduced`; make `caseclosed-verified` and `caseclosed-still-broken` mutually exclusive according to the newest completed verification. An old delayed label intent is superseded rather than reverting newer state. Inconclusive verification adds a comment but does not imply either verdict label. Never send `stateId`, completion, archive, or close mutations. Do not rely on a GitHub “Fixes” keyword to manage Linear status.

### 3.6 GitHub and deployment-ready handler

```ts
type MergeEvent = {
  eventKey: string; repository: string; pr: number;
  commitSha: string; mergedAt: string; body: string;
};
type DeploymentReady = {
  pr: number; commit_sha: string;
  retry?: boolean; retry_of_run_id?: string;
};
type ReadyResponse = {
  status: "accepted" | "duplicate";
  case_id: string; job_id: string; run_id: string | null;
};

interface GitHubAdapter {
  getPullRequest(repository: string, pr: number): Promise<PullRequestMetadata>;
  comment(request: FrozenGitHubComment): Promise<GitHubCommentRef>;
  reconcile(request: FrozenEffect): Promise<Reconciliation>;
}
acceptMerge(event: MergeEvent): Promise<EventAcceptance>;
acceptDeploymentReady(payload: DeploymentReady): Promise<ReadyResponse>;
```

GitHub route validates the raw-body HMAC, event type, configured repository/default branch, `pull_request.closed`, and `merged: true`. Use the actual `merge_commit_sha`, not PR head SHA. Parse `CaseClosed: CC-<number>` and/or `Fixes <configured Linear team key>-<number>` from the PR body. Match only existing DB identifiers; if references disagree or resolve to multiple cases, reject and log. No fuzzy matching or duplicate-bug search.

A single configured repository is the MVP boundary, so the deployment body need not introduce repository/environment selection. PR + SHA must map to exactly one stored attempt/case. For an unseen merge tuple, fetch current PR metadata through `GitHubAdapter.getPullRequest`, verify repository/number/merged status/merge SHA against the signed event, and parse that current body. This lets a corrected association be picked up on webhook redelivery, whose original payload does not change. Return an already accepted tuple's saved result before a metadata refresh can rebind it. A fetch failure leaves the event unaccepted and eligible for redelivery; never infer a missing association.

Persist accepted merge identity `merge:<case_id>:<repo>:<pr>:<sha>`. Check accepted-event identity before lifecycle guards so late duplicates return the original result. A new merge is accepted only from `WAITING_FOR_FIX`, with a newer merged timestamp than the previous attempt. A new SHA cannot replace an active attempt during deployment/verification or reopen a verified case. Persist and reject other events; no buffering/reordering framework.

Deployment endpoint requirements:

1. Verify `X-CaseClosed-Secret` using constant-time comparison and validate the body. Unauthorized requests return 401; malformed bodies 400; mapping/state/SHA conflicts 409 with a stable reason.
2. Resolve the historical stored attempt from the globally unique repository/PR/full-SHA tuple. Derive the initial key `(case_id, commit_sha, initial)` or retry key with `retry_of_run_id`. After authentication and payload-hash comparison, return an existing accepted key's saved response with its current job/run IDs **before** checking current attempt/status. This also handles an old accepted event after another fix attempt became current.
3. For unseen keys only, compare PR/SHA to the current immutable attempt and require `WAITING_FOR_DEPLOYMENT` for an initial trigger.
4. For a new explicit retry, require `retry=true`, `retry_of_run_id`, current state `VERIFICATION_INCONCLUSIVE`, and that predecessor being the latest completed inconclusive verification for this attempt/SHA. Reserve one job keyed to the predecessor. Duplicates of older retries have already returned at step 2.
5. Record retry transition through `WAITING_FOR_DEPLOYMENT`, reserve the verification job, and enter `VERIFYING` atomically. The job carries frozen attempt/spec/plan identities; claim revalidates them. Return 200 with `accepted` or `duplicate` and the existing job/run identity.
6. A rejected premature event does not consume its accepted-event key. CI may retransmit the same payload after a merge webhook arrives. Log sanitized rejections, never shared secrets.

### 3.7 Idempotent external writes

```ts
type Reconciliation =
  | { kind: "found"; externalId: string; result: unknown }
  | { kind: "safe_to_send" } // provider identity makes retry safe, or no send began
  | { kind: "unknown"; reason: string };

interface EffectAdapter {
  reconcile(effect: FrozenEffect): Promise<Reconciliation>;
  send(effect: FrozenEffect): Promise<ExternalResult>;
}
ensureEffect(tx: CaseTx, effect: NewEffect): string;
deliverEffect(effectKey: string, adapter: EffectAdapter): Promise<void>;
```

Each logical write gets a frozen payload, destination, hash, identity, and delivery job committed with the event that requires it. One key with different payload is a programming error, never an update in disguise.

Keep existing keys:

- `slack:case-created:<trigger_id>`
- `linear:create:<case_id>`
- `slack:repro-result:<run_id>`
- `slack:verify-result:<run_id>`
- `github:verify-comment:<run_id>`
- `linear:verify-comment:<run_id>`

Add `slack:spec-failed:<case_id>`, `slack:linear-link:<case_id>`, `slack:fix-merged:<attempt_id>`, and `linear:labels:<run_id>` for previously unspecified writes. Remote markers include the database-instance UUID plus the logical key. Freeze run-A comments to PR A even after PR B becomes current.

Delivery protocol:

1. Inspect existing ledger state first. Return stored results for `completed`; do not dispatch a `failed` effect without an explicit eligible retry cycle. Treat a recovered `sending` effect as `unknown`.
2. An `unknown` effect must reconcile before any send. `found` completes the effect atomically with dependent link/transition/job changes. `safe_to_send` permits a resend only through provider-enforced identity (such as the same Linear UUID). `unknown` stays unknown and sends nothing.
3. A `pending` effect with no prior uncertain dispatch may send. Persist the already allocated provider UUID/marker and `sending` state, then call `adapter.send` outside the transaction. Never allocate a new identity on retry.
4. On confirmed success, atomically store the result and dependent canonical changes. On timeout, ambiguous 5xx, malformed success, or crash after dispatch, mark unknown and return to reconciliation. Linear uses its preallocated UUID; GitHub comments carry an HTML marker; Slack messages carry a stable case/effect marker and returned IDs when available. A provider-confirmed noncommitting rejection may return to a retryable pending state.
5. Reconciliation enumerates the relevant provider objects with pagination and checks exact marker/destination. Use supported channel history for Slack and PR issue-comments for GitHub. Provision required read permissions in addition to write permissions. No general account-wide search is needed.
6. An absent search result after an uncertain send is not proof that no write committed. Without provider-enforced duplicate identity, keep the effect unknown after bounded read retries; surface it and allow safe later reconciliation. Never issue a second blind Slack/GitHub create. This prioritizes avoiding duplicate writes over claiming guaranteed delivery under an unknowable response.
7. The same logic covers remote success followed by local DB failure. A fake transport must persist its simulated remote objects across client/worker reconstruction and support “commit then drop response.”

This is a concrete limit of the remote APIs, not an exactly-once guarantee supplied by SQLite. Normal and lost-response scenarios with a discoverable remote object must complete automatically; permanently unknown outcomes remain visible operational failures. Resolve them without weakening the no-duplicate rule. A failed projection does not rewrite a browser verdict or close a case.

### 3.8 Deployment, fixture, and artifact operations

`EnvironmentDriver` owns `resetFixture(fixture)`, `readHealth()`, loading storage state, and the shared staging lock. It owns no case transitions or verdict logic.

Staging reset: authenticated `POST /api/test/reset { fixture }` returns 200 with `{ fixture, reset: true }` only after restoring the seeded account. A repeated reset is idempotent. Unknown fixture is 400; invalid secret 401. Use a small process-local staging fixture store; it is test data, not CaseClosed state. Every run resets it, and every build starts with it. The internal test session is supplied by Playwright storage state; absent/invalid session returns a detectable auth failure.

Health: `GET /api/health → { commit_sha, build }`, with no cache. Build metadata comes from an immutable manifest embedded when building that exact clean revision, never the deploy request body. The three app routes and the optional account read endpoint match AppContext. Fix PRs change application source behavior, not runtime configuration flags.

Use one local lock helper for both worker and deploy process, backed by atomic directory creation and owner PID/token on the shared host. Worker holds it from preflight health/reset through evidence finalization and post-run health. Deploy holds it for artifact swap, restart, and health confirmation, then releases before notification so the worker can run. Clean up on normal exit; a dead owner's lock may be reclaimed after a same-host liveness check. A live lock is waited on outside the browser-run clock. Test restart/stale-lock behavior; do not add distributed leases.

`deploy-staging.sh` is a thin wrapper over `deploy-staging.ts --pr <n> --sha <full_sha>`. Both CI and local fallback:

1. Resolve the exact merge SHA and associated PR for the configured repository; never guess a PR number.
2. Build/cache the exact revision under `var/staging-builds/<sha>` before taking the staging lock. Fail if the manifest does not match.
3. Take the lock, swap the active artifact, restart staging only, and poll uncached health until the exact SHA matches or a bounded 60-second deployment timeout expires.
4. Release the lock and POST deployment-ready with the shared secret. Retry transient transport failures and premature-state 409s inline for at most 60 seconds using the same payload; stop on unauthorized, invalid, or stale-attempt errors.
5. Print confirmed SHA, endpoint response, and any blocking reason without secrets. Do not modify CaseClosed tables directly.

The push-to-main GitHub Actions workflow calls this script on the configured persistent host, serializes staging deployments, and never cancels a running deployment to start a newer one. Webhook and Actions arrival order is not assumed. Post-run health mismatch, failed health, or hash drift sets infrastructure failure before classification/finalization. Out-of-band deployments are outside the controlled MVP; the pre/post checks still prevent a simple stale-build success.

A build from a PR head cannot masquerade as its later merge commit to meet the eight-second demo budget. If exact-commit build/deploy is slower, rehearse the documented persisted-run fallback. Do not remove the `STILL_BROKEN` beat.

## 4. Risk register

| Risk | Failure mechanism | Required mitigation and proof | Owner / gate |
|---|---|---|---|
| False `REPRODUCED` | Unrelated 500, setup traffic, hallucinated endpoint, wrong control, all-success-plus-signal contradiction | AppContext semantic validation, same-origin/windowed method matching, unique exact locators, complete spec steps, pure reproduction table. Test unrelated/setup responses and both mixed patterns. | M3, M6–M7 |
| False `NOT_REPRODUCED` | Reset/auth/browser failure mapped to absence; missing probes assumed passing | Infrastructure dominates; measured absence distinguished from missing observations; counts from spec. Test stopped staging, missing session, unobserved negative checks, deadline exhaustion. | M3, M7 |
| False `VERIFIED_FIXED` | Spinner clears while API fails; assertions weakened/skipped; model recovery; early success; stale deployment | Immutable hashes and full replay; zero model imports/calls; all assertions plus zero signals; full windows; shared deployment lock/SHA checks. Eval 3 and tamper/incomplete-observation tests are mandatory. | M8, M10–M13 |
| Duplicate side effects | Crash/timeout between remote commit and ledger completion; mutable keys; new run ID on retry | Persist intent/provider identity before dispatch, reconcile uncertainty, unique keys, fixed run identity. Assert remote object count as well as ledger rows, across restart. | M5, M9, M11 |
| Invalid transitions | Handler sets status directly; stale worker completion; old merge replaces active attempt | One semantic event guard, conditional transactional updates, immutable attempts, accepted-event dedupe before guards; audit refusals. Test each forbidden ordering. | M4, M10 |
| Browser nondeterminism | Shared fixture reset, role collisions, variable waits, request races, incomplete timers | One runner, reset/fresh context, fixed Chromium settings, unique roles, bounded concurrent probes, deterministic network ordering. Fail uncertain experiments as inconclusive. | M2, M7–M8 |
| Deployment races | Ready precedes merge; queued run starts after newer deploy; PR head mislabeled; deployment during replay | Same endpoint/lock for CI and fallback, full immutable SHA, pre/post health, inline resend for early delivery, reject stale attempt, exact-commit manifests. | M10 |
| Retry-loop duplication | Delayed `retry:true` creates another run; dedupe on status drops real second fix | Retry predecessor identity and unique job reservation; merge identity includes case/repo/PR/SHA. Test duplicate old retries and A→B loop. | M5, M10–M11 |
| Wrong external projection | Delayed A result posts to B; old label task undoes verified label; external automation closes issue | Frozen targets, managed-label supersession, no issue state mutation, checked external automation settings. | M9, M11 |
| Model/config dependency | Requested model unavailable, response schema unsupported, fallback hides outage, inference takes too long | Early credentialed smoke, explicit model IDs/counters, strict post-validation, flat generation fallback only, hard budgets; report unmet setup gate. | M0–M1, M6 |
| Unreadable/missing evidence | Local paths sent externally, files absent after “success,” UI hides signal results | Evidence-ID endpoint, finalized artifacts before DB commit, one row per check, source-derived rendering, screenshot in Linear issue. | M7, M9, M12 |
| Eval contamination | Clean DB reuses case IDs but old provider objects remain | Unique DB-instance namespace and provider UUIDs; dedicated destinations; reset only disposable DBs, retain sanitized evidence/results. | M13 |

## 5. Testing strategy

Use tests at the smallest boundary that proves behavior. Do not introduce API twins, a simulator framework, or a second classification implementation.

### Unit tests

Use `node:test` for pure contract validation, path/origin safety, hash stability, all assertion types, every truth-table branch, empty/partial/corrupt observations, timeout boundaries, status guards, event/operation keys, PR-reference parsing, and deterministic message rendering. Stub the clock for timing logic. Test no-match versus collection failure separately.

Model wrapper unit tests use canned transport responses for schema flattening, parsing, sufficiency, feedback, budget exhaustion, timeout, fallback, and counters. They do not count as evidence of live model quality. Verify the verification service's dependency graph contains no model/resolver import and use a throwing model substitute in replay integration tests.

### Integration tests

Use actual migrated temporary SQLite databases, real repositories/services/route handlers, temporary artifact directories, and a fake outbound HTTP transport. It must model provider objects and identity lookup, not merely return canned success or dedupe on behalf of the application.

Cover intake atomicity and signatures; uniqueness at every trigger; transition/rejection commits; worker serialization and restart at each transaction boundary; uncertain remote writes and reconciliation; correct historical targets; label supersession; deployment acceptance/rejection and retry predecessor identity. Read stored results and recompute them. Repeat duplicate events before claim, during execution, and after completion.

Stale SHA, bad secret, wrong status, invalid transitions, and budgets are mandatory MVP guard tests even though EVALS lists some as stretch. They are tests of existing behavior, not additional features.

### Browser and local end-to-end tests

Use Playwright/Chromium with actual AcmeCloud variants and fresh storage state/reset. Test both DOM and network evidence. Local E2E may inject fake external transport to isolate the pipeline, but must be labeled local/mocked and cannot satisfy real-integration acceptance.

Required paths: buggy reproduction; valid fixed-build reproduction yielding `NOT_REPRODUCED`; superficial/fixed verification with the same saved plan; stopped staging; invalid authentication; unresolved saved action; context/spec/plan drift; action/time exhaustion; evidence capture; case page from persisted state; deployment/run exclusion. Negative outcomes must not create Linear issues.

### Seeded evals and live acceptance

Only three code variants plus a stopped staging process are needed. Do not add seeded app behavior switches.

| Eval | Setup and expected persisted outcome |
|---|---|
| 1 | Real Slack report against buggy build; reproduced run; history through issue filing to waiting; one real Linear issue and thread evidence. |
| 2 | Reproduce first, then merge/deploy real fixed revision; `VERIFIED_FIXED`, zero model calls, verified label/comment, issue still open. |
| 3 | Reproduce first, then merge/deploy superficial revision; `STILL_BROKEN` run and immediate waiting case; never verified. |
| 4 | Real ambiguous report; `SPEC_FAILED` with missing reasons, no browser run and no Linear issue. |
| 5 | Stop staging before reproduction; `INCONCLUSIVE` run, `REPRO_INCONCLUSIVE` case, infrastructure reason, no Linear issue. |
| 6 | Duplicate authenticated Slack payload through handler with fake transport; one case/root/side-effect. |
| 7 | Fake Linear commits create, drops response, then client/worker reconstructs; one remote issue, one completed effect with original UUID. |
| 8 | Duplicate merge plus matching duplicate ready deliveries; one accepted fix attempt and verification job/run; one comment per destination. Assert zero verification jobs before ready. |
| 8b | After superficial failure, merge/deploy a distinct new SHA; accepted second attempt and separate run-scoped comments. |

Evals 1–5 use real connected services at the relevant stages. The harness may set up the disposable DB, start/stop/deploy staging revisions, wait for results, and assert state. A human enters the actual slash command and writes/merges the prepared fix PRs as permitted by the product boundary. Do not pretend a direct HTTP fixture or bot-posted message is a real slash-command submission. Capture returned case IDs for assertions. No manual DB edits during the loop.

Record: trial/instance ID, case/run/attempt IDs, build SHAs, spec/plan hashes, actual result, case history, assertion counts, model calls, effect and remote-object counts, elapsed time, artifact links, and failure cause. Retain sanitized JSON summaries in `evals/results/` and fill the existing EVALS Actual/Pass table only after running it. Do not place fabricated sample results in that table.

Acceptance targets:

- Three full clean-database golden paths succeed, each including the superficial-then-real-fix sequence.
- Zero false `VERIFIED_FIXED`, duplicate Linear issues, unintended verification runs, or verification model calls across all trials.
- All eight evals run; at least 7/8 pass. Only Eval 4 is an allowed reported miss under the PRD target; companion 8b and all deterministic guard tests must pass.
- Report correct inconclusive-class handling for Evals 4 and 5 as 2/2 target. If Eval 4 misses, explicitly report that this separate target also missed; do not conceal it behind 7/8.
- At least 9/10 correct schema-valid generation/sufficiency outcomes on the labeled corpus, plus a separate valid-spec count out of seven sufficient reports.
- Rehearse twice and record acknowledgment, reproduction, deployment, and replay durations. Aim for under-three-second acknowledgment, approximately 25-second reproduction, at-most-eight-second deployment-ready, and at-most-15-second replay. Timing misses use DEMO's honest recorded-state fallback, not weakened verification.

## 6. Sequential implementation checklist

1. Complete M0: synchronize contradictory docs with this plan, freeze interface amendments, and record operational prerequisites without implementing stretch scope.
2. Complete M1: scaffold the root API, separate worker and staging app, pin dependencies, validate configuration, and smoke-test the configured Gemini primary/fallback.
3. Complete M2: build accessible AcmeCloud, reset/session/health contracts, immutable AppContext, and three real source variants.
4. Complete M3: implement strict schemas, semantic validation, timestamped observation facts, all assertion types, and both fully tested truth tables.
5. Complete M4: migrate canonical SQLite state, immutable experiment/attempt records, guarded transitions, and transactional query/finalization interfaces.
6. Complete M5: establish unique durable jobs, stable run identity, restart recovery, and intent-first external delivery; prove lost-response reconciliation against fake remote state.
7. Complete M6: implement bounded report interpretation and per-step resolution, persist generation inputs/counts, and create the ten-report labeled corpus.
8. Complete M7: run the fixture-spec walking skeleton against the real browser, then run generated specs; persist complete evidence and promote only reproduced plans.
9. Complete M8: replay the saved plan against superficial and real fixes with zero model calls; fail missing/changed/incomplete experiments as inconclusive.
10. Complete M9: connect actual Slack intake/threading and Linear handoff; prove three-second acknowledgment and exactly one useful engineering issue.
11. Complete M10: connect GitHub merge identity, exact-SHA deployment, shared staging lock, deployment-ready guards, duplicate handling, and explicit retry identity.
12. Complete M11: prove the full PR A → STILL_BROKEN → PR B → VERIFIED_FIXED loop with correct historical comments, current labels, and Linear left open.
13. Complete M12: deliver the read-only case page, complete assertion tables, timeline/rejections, operational errors, evidence links, and polling.
14. Complete M13: run all eight evals plus 8b, three full golden paths, the corpus, and two rehearsals; publish actual measured results and any unmet gates.
15. Stop at the complete MVP. Do not add autonomous fixes, permanent test generation, richer recovery, extra integrations, distributed infrastructure, or any other stretch feature.
