# Implementation Plan

## Assumptions — adjust here

These three were not specified anywhere in the docs, so the plan below assumes them. Change them here and the schedule scales; nothing downstream hardcodes them.

| Assumption | Value | If it's wrong |
|---|---|---|
| Working hours | **24** | Under 16h: cut the case page to a JSON dump and drop Evals 6–8. Over 36h: pull `/CUT2` into the main build. |
| Team size | **4** | At 3, lane D folds into lane C and Linear/GitHub adapters slip to H+14. At 2, cut Slack intake to an HTTP endpoint and demo from the case page. |
| Staging app | **net-new** | If it already exists, lane A finishes by H+4 and joins lane B. |

Hours are labelled `H+n` from kickoff, not clock time.

---

## Scoring map

| Weight | Category | What earns it | Where it is built |
|---:|---|---|---|
| 30% | Technical execution | The loop actually runs end to end against real Slack / Linear / GitHub / staging | H+16 checkpoint |
| 25% | Reliability & evaluation | **A populated results table in `EVALS.md`**, truth-table tests, `INCONCLUSIVE` handling, idempotency evidence | Lane B H+1–H+6, lane C H+7+, H+20–22 |
| 20% | Usefulness | The `STILL_BROKEN` catch; a Linear issue a real engineer would want to receive | H+20 checkpoint, lane D |
| 15% | Originality | Zero-model-call replay, verification as an independent experiment, `INCONCLUSIVE` as a first-class verdict | Already in the design |
| 10% | Demo clarity | Five clean beats, narrated | `DEMO.md`, rehearsal |

Three consequences worth internalising before hour one.

**Reliability is worth almost as much as the working system.** The eval suite is not a nice-to-have that happens if time remains — it is a quarter of the score, and it is the category most hackathon projects score near zero in because they have nothing to show. CaseClosed already has the design for it. Finish it.

**The scoring artifact for that 25% is a filled-in results table.** Not the idempotency layer, not the truth table, not the design docs — the table in `EVALS.md` with real values in the Actual column. An eval that exists in code but was never run scores nothing. Reserve H+20–22 for running all eight and writing down what happened, including anything that failed. An honest table with one failure is worth far more than an empty one.

**Originality is already banked.** Zero-model-call verification, replay-don't-regenerate, and first-class `INCONCLUSIVE` are the novel claims, and they cost no additional hours because they are structural. Do not spend time chasing more novelty. Spend it making the novelty you have demonstrably true.

---

## Build order: walking skeleton first

The failure mode for a project this size is four beautiful components that meet for the first time at H+20. So the schedule is arranged so that **an end-to-end path exists by H+8** and everything after that replaces a fake part with a real one.

At every checkpoint below, something is demoable. If time runs out at any checkpoint, you still have a story.

```text
H+8   hardcoded spec → real browser run → real assertions → console output
H+12  Slack in, Linear out, real spec generation
H+16  merge → deploy → verify loop closes
H+20  STILL_BROKEN loop, case page
H+22  all evals run, results table populated
H+24  buffer, rehearsal
```

---

## Hour 0–1: freeze the contracts (everyone, together)

Do not split up before this is done. It is the only hour where being in the same conversation matters more than typing.

1. Agree and commit `docs/CONTRACTS.md` → `src/contracts/`.
2. Commit every fixture in [CONTRACTS §10](CONTRACTS.md#10-mock-fixtures-for-parallel-work). The `observations.*` fixtures are what let lanes B and C proceed without each other.
3. Stand up the repo: Next.js, Drizzle, SQLite in WAL, Zod, Playwright, `.env.example`.
4. Start the named tunnel and put its URL in the Slack app config and the GitHub webhook. A named tunnel survives restarts; an unnamed one will change URL at H+9 and cost you forty minutes.
5. Confirm the Gemini model ID resolves against your key with a one-line script. Record the exact ID in `.env.example`. Do this now, not at H+11.

**Exit criteria:** every lane can `import` its types and run its tests against fixtures.

---

## Lanes

Four parallel tracks. Each owns its files; the contracts are the seam.

### Lane A — staging app (`AcmeCloud`)

On the critical path for every other lane. Nothing can be tested end to end until it exists, so it starts at hour zero and ships early.

- **H+1–H+4** — three routes, the `pro_monthly_customer` fixture, `POST /api/test/reset`, `GET /api/health`. Deliberate accessible roles and names per the table in [ARCHITECTURE](ARCHITECTURE.md#accessibility-requirements) — this is the requirement everything else depends on, not a polish pass.
- **H+4–H+6** — the **buggy** build: `POST /api/subscription` returns 500 on annual upgrade, spinner never clears. Deployed and confirmed live.
- **H+6–H+8** — `config/environments/staging.json` (AppContext), plus branches for the **superficially fixed** and **fixed** builds. Open PR A and PR B now, while it is calm.
- **H+8–H+10** — `scripts/deploy-staging.sh` and `.github/workflows/deploy-staging.yml`: check out SHA, swap pre-built artifact, restart, poll `/api/health` until the SHA matches, `POST` deployment-ready.
- **H+10+** — join lane B or lane C.

Pre-build the fixed artifacts. Demo-day deploy must be a restart, not a compile — the demo budget allows 8 seconds.

### Lane B — browser worker + assertion engine

The assertion engine has no dependency on Playwright. Build it first, against fixtures, and it will be correct before a browser ever opens.

- **H+1–H+4** — `classify()` as a pure function. Unit-test **every row** of both truth tables, including the mixed-evidence rows. This is the product thesis in code; it deserves the most tests in the repo.
- **H+4–H+6** — `network_status` matching: OPTIONS dropped, method matched, last-match wins, no-match fails. Test each rule separately.
- **H+6–H+10** — Playwright runner: fixture reset, fresh context, storage state, action execution, `RunObservations` emission. Element and text probes, budget enforcement, `infra_error` mapping.
- **H+10–H+13** — step resolution via the model wrapper; persist resolved actions; promote the resolved plan on `REPRODUCED`.
- **H+13–H+15** — literal replay path for verification. Assert `model_calls === 0`. Single-step recovery with the `plan_recovered` flag.
- **H+15+** — evidence collector: screenshots, network, console, artifact layout.

### Lane C — state machine, persistence, API, case page

- **H+1–H+4** — Drizzle schema, migrations, WAL, `busy_timeout`. The guarded `transition()` function with the full `(from, to)` table; `rejected_events` on refusal.
- **H+4–H+7** — `jobs` table, single-worker claim loop with `run_id` reuse on retry. `side_effects` table and the `withIdempotency(key, fn)` wrapper — every outbound write goes through it, no exceptions.
- **H+7–H+9** — **Evals 6–8 against the fake transport**, written immediately after `withIdempotency` exists while the semantics are fresh. Includes the 8b companion assertion: a new SHA after `STILL_BROKEN` must be accepted.
- **H+9–H+12** — GitHub webhook handler, signature verification, PR association parsing, merge dedupe on `(case_id, pr_number, commit_sha)`. Deployment-ready endpoint with all four guards.
- **H+12–H+15** — case page: timeline, run cards, assertion table, evidence, external links. Poll every 2s. The assertion table is the part that matters; it is what makes a verdict legible. Stop there if the clock is tight.
- **H+15+** — eval harness for Layer 1: database reset, build-variant switch, report submission, assertions on final state.

### Lane D — Gemini + integrations

- **H+1–H+3** — the model wrapper: `responseSchema` from Zod, 20s timeout, retry budget, per-run call counter, fallback model config.
- **H+3–H+6** — spec generation: prompt assembly from report + AppContext, `{ sufficient, missing, spec }` parsing, the `sufficient === (spec !== null)` invariant, validation-error feedback loop.
- **H+6–H+9** — Slack: signature verification, 3-second ack, `trigger_id` dedupe, threaded updates for every state change.
- **H+9–H+12** — Linear: idempotent issue creation with the full evidence body, labels, verification comments.
- **H+12–H+14** — GitHub PR comments for both verdicts.
- **H+14+** — `evals/reports.json` (10 labeled reports) and prompt tuning against it.

---

## Integration checkpoints

Hard stops. Everyone converges, the checkpoint passes, then lanes resume.

### H+8 — first skeleton

Run a **hardcoded** ReproSpec (`fixtures/repro-spec.valid.json`) through the real Playwright worker against the real buggy staging build, classify with the real assertion engine, print the result to console. No Slack, no Linear, no model.

> If this prints `REPRODUCED`, the hard half of the product works.

Slipping here is the signal to cut, and the first thing to cut is the case page.

### H+12 — intake and handoff

Slack `/caseclosed` → real spec generation → reproduction → real Linear issue → Slack reply. The whole left half of the demo.

### H+16 — the loop closes

Merge PR B → webhook → deploy → deployment-ready → verification → `VERIFIED_FIXED` → GitHub and Linear comments. The happy path is now end to end.

### H+20 — the demo

Merge PR A first → `STILL_BROKEN` → back to `WAITING_FOR_FIX` → merge PR B → `VERIFIED_FIXED`. Case page renders the whole history.

This checkpoint is the actual product. Protect the hours before it.

### H+20–H+22 — run the evals (hard milestone, 25% of the score)

Run all eight scenarios plus 8b and write real values into the `EVALS.md` result table. This is not a buffer activity and it is not conditional on the rest going well — it is the deliverable for the largest category after technical execution.

Record failures honestly. A table showing 7/8 with a named cause reads as a team that measured its system; an empty table reads as a team that didn't.

### H+22–H+24 — buffer and rehearsal

Rehearse the demo end to end **twice**, timing both verification runs against the budget in `DEMO.md`. Something will break in rehearsal — that is what the buffer is for.

---

## Cut ladder

Ordered by points lost per hour saved, not by convenience. Cut from the top.

1. **Evidence polish** — screenshots only, drop the artifact layout. (Demo clarity, 10%.)
2. **Case page → a raw JSON view at `/api/cases/:id`.** Frees ~2h. It is still a usable demo fallback, and a well-narrated JSON view costs little in a 10% category.
3. **GitHub PR comments** — Slack and Linear already carry the story. (Technical execution, marginal.)
4. **Eval 4 / the sufficiency gate** — hardcode `sufficient: true` and accept the documented loss. One eval of eight.
5. **`NOT_REPRODUCED` handling** — the demo never reaches it.
6. **Reduce golden-path trials from 3 to 1** — weakens the reliability claim but keeps every eval present.

**Never cut, in any scenario:**

- the classification truth table and its tests,
- **running all eight evals and populating the results table**,
- literal replay with zero model calls,
- the `STILL_BROKEN` loop,
- fixture reset before every run,
- `withIdempotency` on outbound writes.

Note what moved. Evals 6–8 were previously second on this list; under a 25% reliability weight they belong in the never-cut set, because the idempotency layer shipping untested scores nothing in the category it was built for. The case page moved up to take their place — it serves a 10% category and has a cheap substitute.

Those six *are* the product and the score. Everything above them is presentation.

---

## Standing risks

| Risk | Mitigation |
|---|---|
| Staging app slips → nothing is testable | Lane A ships the buggy build by H+6, before anything else needs it |
| Tunnel URL changes mid-build | Named tunnel from hour 0 |
| Gemini model ID or quota surprise | Verified in hour 0; fallback model in config |
| Accessible names added late → locators flake | Part of lane A's H+1–H+4 definition of done |
| Demo deploy too slow for two verification runs | Pre-built artifacts; measured at H+20 rehearsal; documented fallback in `DEMO.md` |
| SQLite lock contention | WAL + `busy_timeout` + single worker, decided in hour 1 |
| Components meet for the first time late | H+8 skeleton checkpoint |
