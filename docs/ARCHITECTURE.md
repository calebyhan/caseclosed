# Architecture

## Overview

```text
Slack
  │
  │ /caseclosed  (ack < 3s, work async)
  ▼
CaseClosed API
  │
  ├──────────────► SQLite / Drizzle
  │                 canonical state
  │
  ├──────────────► Gemini
  │                 interpretation + step resolution
  │
  ├──────────────► Browser Worker / Playwright
  │                 execution + evidence
  │
  ├──────────────► Linear
  │                 engineering artifact
  │
  └──────────────► GitHub
                    fix lifecycle + verification trigger

Browser Worker
  │
  ▼
Controlled staging app  (AcmeCloud)
  ▲
  │ deploy + POST /deployment-ready
  │
GitHub Actions / scripts/deploy-staging.sh
```

## Architectural rule

> The LLM interprets intent. Code establishes truth.

The LLM is used only where ambiguity is useful:
- bug report interpretation,
- judging whether a report is sufficient,
- resolving a semantic step into a constrained browser action,
- engineer-readable summaries.

Deterministic code owns:
- state transitions,
- schema validation,
- assertion evaluation and the classification truth table,
- idempotency,
- retries,
- external write deduplication,
- the verification verdict.

The verification execution path contains **zero model calls**. See [Resolve once, replay literally](REPROSPEC.md#resolve-once-replay-literally).

---

## Canonical state

The CaseClosed database is the source of truth. Slack, Linear, and GitHub are projections; they may trigger transitions but they do not own the lifecycle.

Core persisted entities:

```text
cases
runs
repro_specs
resolved_plans
browser_actions
assertion_results
evidence
external_links
jobs
side_effects
rejected_events
```

The authoritative Drizzle schema is frozen in [`docs/CONTRACTS.md`](CONTRACTS.md) before implementation starts. Sketch:

### `cases`
```text
id  status  report  source_type  source_channel_id  source_thread_ts
source_trigger_id  environment_id  created_at  updated_at
```

### `runs`
```text
id  case_id  run_type(reproduction|verification)  status  result
infra_error  infra_error_reason  plan_recovered  commit_sha
started_at  finished_at
```

### `external_links`
```text
case_id  slack_thread_ts  linear_issue_id
github_repo  github_pr_number  github_commit_sha
```

### `side_effects`
```text
idempotency_key(unique)  type  external_id  completed_at  result_json
```

### `rejected_events`
```text
id  case_id  event_type  reason  payload_json  created_at
```

---

## Concurrency model

State this up front so nobody builds a distributed queue by accident.

- **One worker process. Runs are serialized.** Playwright plus a single staging fixture cannot safely run two cases at once — the fixture reset would race.
- SQLite in **WAL mode**, `busy_timeout` set. Without this you will spend an hour on `SQLITE_BUSY` under webhook load.
- Jobs are claimed with a single `UPDATE … WHERE status = 'pending'` guarded by the process's own mutex. No multi-worker claim protocol in the MVP.

---

## Components

### 1. CaseClosed API

Next.js route handlers.

- Slack slash command handler
- GitHub webhook handler
- deployment-ready endpoint
- case page API
- job enqueueing
- guarded state transitions

**Slack's 3-second rule.** Slack fails a slash command that does not respond within 3 seconds, then retries it. Spec generation and browser runs take far longer. The handler must:

1. verify the Slack signature,
2. dedupe on `trigger_id`,
3. persist the case,
4. return a `200` with an immediate acknowledgement,
5. enqueue everything else.

All subsequent updates go to the thread via `chat.postMessage`, not as the command response.

**Public URL required.** Slack and GitHub both need to reach this service. Use `cloudflared tunnel` or `ngrok` and set the resulting URL in the Slack app config and the GitHub webhook. Do this in hour one — a stale tunnel URL is a classic mid-hackathon time sink, and the URL changes on restart unless the tunnel is named.

### 2. Job worker

- claims durable jobs,
- runs reproduction,
- runs verification,
- performs external side effects,
- retries transient failures.

```text
id  case_id  type  status  attempt_count  run_after  idempotency_key  payload_json
```

The worker must be safe to restart without losing a case. A retried job **resumes its existing run** rather than creating a new one — see [run identity](STATE_MACHINE.md#job-retries-and-run-identity).

### 3. Gemini layer

Two uses, both structured:

1. report + AppContext → `{ sufficient, missing, spec }`
2. step intent + accessibility tree + AppContext → one `BrowserAction`

And one unstructured use: evidence → engineer-readable summary.

**Structured output.** Define every shape as a Zod schema in `docs/CONTRACTS.md`, convert with `zod-to-json-schema`, and pass it as the model's `responseSchema` with a JSON response MIME type. Parse the response back through the same Zod schema — the JSON schema constrains generation, Zod is what actually validates. On failure, return the Zod errors to the model and retry (2 retries for spec generation, 1 re-resolution per run for actions).

**Operational guards:**
- hard timeout of 20s per model call; a timeout counts against the retry budget,
- confirm the exact model ID resolves against your key before implementation starts, and record it in `.env.example`,
- name a fallback model in config so a quota or availability problem is a one-line change, not a rewrite.

The model is never the final judge of pass/fail.

### 4. Browser worker

Playwright + Chromium.

- reset fixture before every run,
- load authenticated storage state,
- execute constrained browser actions,
- capture evidence,
- emit structured observations.

Budgets, locator order, and the action union are defined in [`docs/REPROSPEC.md`](REPROSPEC.md#budgets). Summary:

```text
max browser actions:      15
max run duration:         45s
per-action timeout:        5s
step re-resolutions:        1  (verification only)
fresh browser context:    yes
fixture reset:            yes
allowed domains:     staging only
```

No coordinate clicking, no raw CSS selectors.

### 5. Assertion engine

Pure function: `(RunObservations, ReproSpec) → RunResult`. No I/O, no LLM.

Supported assertions and failure signals, their matching rules, and the classification truth table all live in [`docs/REPROSPEC.md`](REPROSPEC.md). The truth table is implemented exactly once and unit-tested row by row.

### 6. Evidence collector

Capture per run:

```text
before.png
failure.png      (on any failed assertion or matched signal)
after.png
network.json
console.json
actions.json     (resolved actions, in order)
assertions.json  (one row per assertion and signal, with observed value)
result.json      (RunResult, including infra_error and plan_recovered)
```

Playwright trace and video are out of MVP scope.

### 7. Case page

One line of scope in the original PRD, but the demo ends on it and names it as the fallback when an external UI is slow. It is the safety net, so it gets a spec.

`/case/[id]` renders, server-side, from the database only:

- **Header** — case ID, current status, original report, environment, elapsed time.
- **Timeline** — every state transition with timestamp and trigger, including rejected transitions and rejected events.
- **ReproSpec** — goal, steps, assertions, failure signals, rendered readably rather than as raw JSON.
- **Runs** — one card per run: type, result, duration, `infra_error` reason, `plan_recovered` flag.
- **Assertion table** — per run, one row per assertion and signal: expected, observed, pass/fail. This is the screen that proves the verdict.
- **Evidence** — screenshots inline, network and console collapsible.
- **External links** — Slack thread, Linear issue, GitHub PR, with the stored external IDs visible.

Polls every 2s while the case is in a non-terminal state. No auth in the MVP.

---

## External integration responsibilities

### Slack

Input: `/caseclosed <report>`

Output: one thread per case — case created, reproduction result, Linear link, verification result.

Dedupe key: `trigger_id`. Slack does not define case state.

### Linear

Create an issue only after `REPRODUCED`. Contents: original report, ReproSpec summary, expected vs. actual, network and console evidence, screenshots, CaseClosed ID and link.

Labels: `caseclosed-reproduced`, `caseclosed-verified`, `caseclosed-still-broken`.

CaseClosed never auto-closes the issue.

### GitHub

Required: read PR metadata, receive the PR merge webhook, comment on a PR. No repository write access needed.

Association: PR body contains `Fixes ENG-142` or `CaseClosed: CC-0042`.

```text
PR merged
  ↓
FIX_MERGED                (persist merge commit SHA)
  ↓
WAITING_FOR_DEPLOYMENT
  ↓
deployment-ready event    (SHA must match)
  ↓
VERIFYING
```

Merge alone never proves a fix.

---

## Deployment-ready contract

The original design specified the endpoint but never who calls it, which left a hole in the middle of the demo: a PR is merged at 1:00 and verification starts by 1:15 — something has to happen in between.

### Mechanism

The staging app's buggy behavior is controlled by application code, not by a runtime toggle — the fix PR is a real code change. Deployment is a pull-and-restart:

`.github/workflows/deploy-staging.yml`, on push to `main`:

1. check out the merge commit,
2. build,
3. restart staging (or hit the platform deploy hook) and wait for its health check to report the new SHA,
4. `POST` to the deployment-ready endpoint.

```http
POST /api/caseclosed/deployment-ready
X-CaseClosed-Secret: <STAGING_TEST_SECRET>
```

```json
{ "pr": 84, "commit_sha": "abc123" }
```

`scripts/deploy-staging.sh` performs the identical sequence locally. It is the demo-day fallback if Actions is slow, and it is what you use while developing. Both paths call the same endpoint with the same payload — never a manual state edit.

Staging exposes `GET /api/health` returning `{ "commit_sha": "abc123" }` so the deploy step can confirm the new build is actually live before signalling. This is what replaces an arbitrary sleep.

### Guards

The endpoint rejects, persisting to `rejected_events` without transitioning, when:
- the shared secret is missing or wrong,
- `commit_sha` does not match the case's persisted `github_commit_sha`,
- the case is not in `WAITING_FOR_DEPLOYMENT` or `VERIFICATION_INCONCLUSIVE`,
- the `(case_id, commit_sha)` pair already has a verification run and `retry` is not set.

---

## Staging app contract

`AcmeCloud`. This is on the critical path for every other component — nothing can be tested end to end until it exists — so it starts at hour zero.

Routes:

```text
/dashboard
/settings/billing
/checkout
```

Seeded fixture:

```text
id:             pro_monthly_customer
email:          test@acmecloud.local
plan:           pro_monthly
billing_period: monthly
```

### Accessibility requirements

Every landmark in the environment's AppContext must have a **stable, deliberate accessible role and name**. The locator strategy, the assertions, and the resolved plan all depend on it. Concretely, for the golden path:

| Element | Role | Accessible name |
|---|---|---|
| Annual billing option | `radio` | `Annual` |
| Submit button | `button` | `Upgrade` |
| In-flight spinner | `status` | `Loading` |
| Checkout screen | `heading` | `Checkout` |
| Success confirmation | `heading` | `Upgrade complete` |

Use semantic elements and `aria-label` where needed. This is part of building the app, not a cleanup pass.

### Endpoints

```http
POST /api/test/reset
X-CaseClosed-Secret: <STAGING_TEST_SECRET>
```
```json
{ "fixture": "pro_monthly_customer" }
```

```http
GET /api/health   →   { "commit_sha": "abc123", "build": "…" }
```

Every reproduction and verification starts from a fixture reset.

### Build variants

Three application states are needed, all reached by real code changes on real branches:

1. **buggy** — `POST /api/subscription` returns 500 for the annual upgrade; the spinner never clears.
2. **superficially fixed** — the spinner clears, the API still returns 500, checkout never renders. This is Eval 3 and the most important adversarial case.
3. **fixed** — the API returns 200 and checkout renders.

A fourth condition, **staging unavailable**, is produced by stopping the process — not by a flag.

### Authentication

Playwright storage state or an internal test session. Do not spend MVP time on real login.

---

## Idempotency

Every external write uses a stable idempotency key.

```text
slack:case-created:<trigger_id>
linear:create:<case_id>
slack:repro-result:<run_id>
slack:verify-result:<run_id>
github:verify-comment:<run_id>
linear:verify-comment:<run_id>
```

Verification-side keys are scoped to `<run_id>`, not to the PR number. A PR-scoped key would collapse the two verification runs of a `STILL_BROKEN → WAITING_FOR_FIX → VERIFIED_FIXED` sequence into one, suppressing the second comment. Run-scoped keys are only stable because a job retry resumes its existing run.

```text
if side_effect exists for key:
    return stored result
else:
    execute write
    persist external result under key
```

---

## Retry policy

Retry: network timeouts, 429s, transient 5xx.

Do not retry: schema validation failures beyond the model budget, permission failures, invalid credentials, deterministic assertion failures.

External create operations must be idempotent before they are retried.

---

## Secrets

```text
GEMINI_API_KEY
GEMINI_MODEL
GEMINI_FALLBACK_MODEL
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
LINEAR_API_KEY
GITHUB_WEBHOOK_SECRET
GITHUB_TOKEN
DATABASE_PATH
STAGING_BASE_URL
STAGING_TEST_SECRET
PUBLIC_BASE_URL
```

Never place secrets in SQLite records intended for display, in a ReproSpec, in an LLM prompt, or in Slack / Linear / GitHub output.

### Minimum permissions

- **Slack** — receive slash command, post and reply to messages.
- **Linear** — create issue, read issue, create comment, apply labels.
- **GitHub** — receive webhook, read PR, comment on PR.

---

## Swappable integration endpoints

Keep external API base URLs configurable:

```text
SLACK_BASE_URL
LINEAR_BASE_URL
GITHUB_BASE_URL
```

The MVP does **not** ship deterministic API twins — see [`docs/EVALS.md`](EVALS.md) for how idempotency is tested instead. These variables exist so that swapping in a recorded or fake transport later is a config change rather than a refactor.
