# CaseClosed

**CaseClosed turns customer-reported bugs into reproducible tests, routes evidence to engineering, and independently verifies the fix before the case can be considered resolved.**

## Demo

[Watch the CaseClosed demo](demo.mp4)

## Project overview

Support teams report bugs in natural language. Engineering then spends time reproducing the issue, gathering context, and later trusting that a merged fix actually resolved the original customer failure.

CaseClosed closes that loop:

```text
Slack bug report
  ↓
LLM creates ReproSpec
  ↓
Playwright reproduces bug
  ↓
Deterministic assertions classify outcome
  ↓
Linear issue with evidence
  ↓
GitHub fix merged + deployed
  ↓
Same ReproSpec replayed — with zero model calls
  ↓
VERIFIED_FIXED or STILL_BROKEN
```

The LLM interprets intent. **Code establishes truth.**

## External apps and services

- **Google Gemini** — converts a sufficiently detailed report into a ReproSpec and resolves semantic reproduction steps. It is never used during verification replay.
- **Slack** — receives bug reports and publishes case-progress updates.
- **Linear** — receives engineering issues, evidence, labels, and verification comments. CaseClosed deliberately does not close issues automatically.
- **GitHub** — supplies signed merge webhooks and PR lifecycle context; a SHA-matched deployment-ready event gates verification.
- **AcmeCloud staging app** — the included controlled target application that Playwright drives to reproduce and verify the billing bug.

The local implementation uses SQLite/Drizzle for durable case and job state, plus Playwright/Chromium for browser automation. External credentials are optional for deterministic local tests and required for the full live workflow.

## Core product guarantees

- A bug is not reproduced unless the observed state matches explicit failure criteria, evaluated by a fixed classification truth table.
- A fix is not verified because a PR merged.
- Verification reuses the same ReproSpec, fixture, assertions, and resolved action plan used during reproduction.
- **The verification execution path contains zero model calls.**
- `INCONCLUSIVE` is a valid outcome — both when the experiment cannot complete and when the evidence is mixed.
- External writes are idempotent, keyed on event identity rather than case status.
- CaseClosed does **not** automatically close Linear issues.

## Tech stack

- TypeScript
- Next.js
- Gemini (model ID pinned in `.env.example`, fallback configured)
- Playwright + Chromium
- SQLite + Drizzle (WAL, single worker)
- Zod
- Slack API
- Linear API
- GitHub API + webhooks

## Setup and local development

Requires Node.js 22+ and the Playwright Chromium browser. Start with a local-only configuration:

```bash
npm install
cp .env.example .env.local
# Set STAGING_TEST_SECRET in .env.local to a random value with at least 16 characters.
npx playwright install chromium
npm run db:migrate
```

In separate terminals, start the controlled target app, CaseClosed, and its single worker:

```bash
npm run staging:dev  # http://localhost:3001
npm run dev          # http://localhost:3000
npm run worker
```

For the end-to-end workflow, fill in the relevant Gemini, Slack, Linear, and GitHub values in `.env.local`. Keep real secrets out of source control. The complete variable descriptions and safe defaults are in [`.env.example`](.env.example).

| Command | Purpose |
|---|---|
| `npm install` | Install both workspaces from the lockfile |
| `npm run db:migrate` | Create/upgrade the SQLite database (`DATABASE_PATH`, WAL) |
| `npm run dev` | CaseClosed API + case page on `:3000` |
| `npm run worker` | The single job worker (refuses to start if another holds `var/locks/worker.lock`) |
| `npm run staging:dev` | AcmeCloud staging app on `:3001` (buggy annual upgrade) |
| `npm run db:seed-dev` | Dev only: create one case through the real intake/spec services |
| `npm run db:generate` | Generate a migration after changing `src/server/db/schema.ts` |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint for both apps |
| `npm test` | Unit, integration (temporary SQLite DBs), and staging tests |
| `npm run build` / `npm run staging:build` | Production builds |
| `npm run evals` | Reliability eval suite (real Playwright against pinned staging builds); writes `evals/results/latest.json` |
| `npm run demo:staging` | Restart staging on the checked-out revision and wait until `/api/health` reports its SHA |
| `npm run demo:reset` | Demo only: clear canonical state (next case `CC-0042`) and reset the staging fixture |
| `npm run demo:preflight` | Check credentials, public tunnel, GitHub webhook target, staging health, and the prepared fix PR |
| `npm run demo:deploy -- --pr <n>` | Local deploy job: fast-forward to PR `<n>`'s merge commit, restart staging, confirm the SHA, POST deployment-ready |

Staging test endpoints require the `X-CaseClosed-Secret` header: `POST /api/test/reset { "fixture": "pro_monthly_customer" }` restores the seeded account, and `POST /api/test/session { "fixture": "pro_monthly_customer" }` sets the internal test-session cookie (no login workflow).

Implemented: canonical SQLite state and guarded transitions, durable jobs and side-effect reconciliation, Gemini spec generation, Playwright reproduction and literal zero-model verification replay, Slack intake/thread updates, Linear issue/comments/labels, GitHub merge association/comments, and deployment-gated verification. Real service credentials, webhook URLs, provider labels, and an exact-SHA staging deployment remain environment setup rather than checked-in secrets.

## Reliability testing

Run the ordinary checks with:

```bash
npm run typecheck
npm run lint
npm test
```

`npm test` covers unit, integration, and staging-app tests. Integration tests use temporary SQLite databases and exercise guarded lifecycle transitions, persistence, job recovery, idempotency, reproduction, and verification behavior.

For the reliability suite, run `npm run evals`. It records a machine-readable report at [`evals/results/latest.json`](evals/results/latest.json). The suite runs eight adversarial scenarios: a real reproduced bug, a real fix, a cosmetic-only fix, an insufficient report, unavailable staging, duplicate Slack input, an interrupted Linear response, and duplicate GitHub merge events (including a new SHA after `STILL_BROKEN`). It asserts in particular that false `VERIFIED_FIXED` verdicts, duplicate side effects, and model calls during verification are all zero.

The browser scenarios use real Playwright against pinned staging builds; model resolution and external-service transports are deterministic test doubles so results are repeatable without credentials. Credentialed Slack, Gemini, Linear, and GitHub acceptance runs are documented separately in [`docs/LIVE_ACCEPTANCE.md`](docs/LIVE_ACCEPTANCE.md). See [`docs/EVALS.md`](docs/EVALS.md) for scenario definitions, metrics, and current results.

## Docs

Read in this order.

- [`docs/PRD.md`](docs/PRD.md) — product scope, cut lines, success criteria
- [`docs/CONTRACTS.md`](docs/CONTRACTS.md) — **frozen interfaces; read before writing code**
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — lanes, checkpoints, cut ladder
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design and integration responsibilities
- [`docs/REPROSPEC.md`](docs/REPROSPEC.md) — the reproduction contract and classification truth table
- [`docs/STATE_MACHINE.md`](docs/STATE_MACHINE.md) — lifecycle, transitions, duplicate-event behavior
- [`docs/EVALS.md`](docs/EVALS.md) — reliability evaluation plan
- [`docs/DEMO.md`](docs/DEMO.md) — two-minute demo script

## MVP success criteria

- Slack report starts a CaseClosed case, acknowledged within 3 seconds.
- Gemini judges the report sufficient and produces a valid ReproSpec.
- Playwright reproduces the seeded bug.
- Deterministic evidence proves the failure.
- Exactly one Linear issue is created.
- GitHub merge plus a SHA-matched deployment-ready event triggers verification.
- The original resolved plan is replayed unchanged, with no model calls.
- A superficial fix is classified `STILL_BROKEN` and reopens the loop.
- A real fix is classified `VERIFIED_FIXED`.
- Duplicate events do not cause duplicate side effects.

## Product boundary

Humans:

```text
submit bug
write fix
merge PR
```

CaseClosed:

```text
interpret report
judge whether it is testable
plan reproduction
execute browser workflow
capture evidence
classify outcome
create engineering issue
track fix lifecycle
replay reproduction
verify outcome
update connected systems
```

CaseClosed diagnoses and verifies. It does not write the fix in the MVP.
