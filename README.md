# CaseClosed

**CaseClosed turns customer-reported bugs into reproducible tests, routes evidence to engineering, and independently verifies the fix before the case can be considered resolved.**

## Why

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

## MVP integrations

- **Slack** — case intake and progress updates
- **Linear** — engineering issue and verification evidence
- **GitHub** — fix PR lifecycle and merge trigger
- **Browser / staging app** — controlled reproduction and verification environment

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
