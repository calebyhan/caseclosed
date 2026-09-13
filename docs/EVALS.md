# Evaluation Plan

## Goal

The eval suite should prove that CaseClosed:
1. reproduces the right bug,
2. avoids claiming certainty when the experiment is invalid,
3. does not duplicate external side effects,
4. independently distinguishes a real fix from an incomplete fix.

The key reliability metric is:

> **False `VERIFIED_FIXED` = 0**

## Evaluation philosophy

CaseClosed is evaluated on outcomes, not on whether tool calls returned successfully. A successful external API call does not prove the business workflow is correct.

Each eval inspects the final persisted state and the recorded external side effects.

## How the evals run

Two layers, because they need different machinery.

**Layer 1 — end-to-end (Evals 1–5).** Real Slack, Linear, GitHub, and staging. Driven by a script that resets the database, sets the staging build variant, submits the report, and asserts on final `case.status`, `run.result`, and `side_effects` rows.

**Layer 2 — idempotency (Evals 6–8).** Integration tests against the API and the `side_effects` table with a **fake HTTP transport** for the outbound integrations. No deterministic API twins.

The original plan called for full Slack / Linear / GitHub twins. That is a second implementation of three integrations, and it is not what these evals actually measure. What they measure is whether the idempotency layer collapses duplicate work — which is fully observable at the `side_effects` boundary. Injecting a fake transport that can be told to "succeed but drop the response" gives identical evidence for a fraction of the cost, and it runs in CI in seconds rather than requiring live external state.

The `*_BASE_URL` variables in `docs/ARCHITECTURE.md` exist so this substitution stays a config change.

---

## Core scenarios

### Eval 1 — real billing bug

Build variant: **buggy**. `POST /api/subscription` returns 500 for the annual upgrade.

Input: report describing the monthly → annual upgrade spinner.

Expected:
- `case.status = REPRODUCED` then `ISSUE_FILED`
- `run.result = REPRODUCED`
- exactly one Linear issue
- Slack thread contains the evidence summary

### Eval 2 — same flow after a real fix

Build variant: **fixed**. API returns 200, checkout renders.

Expected:
- `run.result = VERIFIED_FIXED`
- `caseclosed-verified` label and comment exist
- no automatic Linear closure
- **the verification run recorded zero model calls**

That last assertion is worth making explicit in the test. It is the mechanical proof of the replay guarantee.

### Eval 3 — superficial UI fix, backend still broken

Build variant: **superficially fixed**. Spinner clears, API still returns 500, checkout does not render.

Expected:
- `run.result = STILL_BROKEN`
- never `VERIFIED_FIXED`
- case returns to `WAITING_FOR_FIX`

The most important adversarial scenario, and the one eval that may never fail. Note that the spinner failure signal (`f2`) no longer matches here — the classification is carried by the network signal (`f1`) and the failed `Checkout` assertion. That is the point: a single cosmetic signal disappearing does not flip the verdict.

### Eval 4 — ambiguous / insufficient report

Input: a report too vague to support a reliable executable test, e.g. "billing is broken for me."

Expected:
- model returns `sufficient: false`
- `case.status = SPEC_FAILED`
- Slack reply lists the `missing` items
- no Linear issue

This is the eval permitted to fail against the ≥7/8 target, because it turns on a model judgment rather than deterministic machinery. If it proves unstable, tighten the sufficiency rubric in the prompt before weakening the eval.

### Eval 5 — staging unavailable

Environment: staging process stopped before the run.

Expected:
- `run.result = INCONCLUSIVE` with `infra_error_reason` set
- `case.status = REPRO_INCONCLUSIVE`
- not `NOT_REPRODUCED`, not `REPRODUCED`
- no Linear issue

### Eval 6 — duplicate Slack event

Deliver the same slash command payload twice, same `trigger_id`.

Expected:
- one case
- one Slack thread
- one `slack:case-created:<trigger_id>` side-effect row

### Eval 7 — Linear create succeeds but the response is interrupted

Fake transport: create the issue, then drop the response so the client sees a timeout. Worker retries.

Expected:
- one Linear issue
- the `linear:create:<case_id>` side-effect row resolves to the existing external ID
- the retry returns the stored result rather than issuing a second create

### Eval 8 — duplicate GitHub merge webhook

Deliver the same merge event twice, same `(case_id, pr_number, commit_sha)`.

Expected:
- one transition into the fix lifecycle
- one verification job
- no duplicate GitHub or Linear verification comments

**Companion assertion, and the one that catches the original spec bug:** deliver a merge event with a *different* SHA after a `STILL_BROKEN` verdict and confirm it **is** accepted. Status-based dedupe would silently drop it, and that is the exact path the demo walks.

---

## Metrics

```text
reproduction classification accuracy
verification accuracy
false VERIFIED_FIXED count
duplicate external side effects
correct INCONCLUSIVE classification
ReproSpec validation success
model calls during verification   (must be 0)
golden-path E2E success
```

## Initial targets

| Metric | Target | Trials |
|---|---:|---|
| Golden-path E2E success | 3/3 | 3 full runs, clean database each time |
| False `VERIFIED_FIXED` | 0 | across all runs |
| Duplicate Linear issues | 0 | across all runs |
| Duplicate verification runs | 0 | across all runs |
| Seeded eval accuracy | ≥ 7/8 | one run per eval |
| Correct `INCONCLUSIVE` calls | 2/2 | Evals 4 and 5 |
| Valid ReproSpec generation | ≥ 9/10 | 10 labeled reports in `evals/reports.json` |
| Model calls during verification | 0 | every verification run |

The ReproSpec target needs a corpus. Write `evals/reports.json` with 10 labeled reports — 7 sufficient, 3 insufficient — early, while it is cheap. It doubles as the Eval 4 input and as prompt-tuning material.

## Result table

**This table is the deliverable.** Reliability and evaluation is 25% of judging, and this is the artifact that earns it — not the idempotency layer, not the truth table, not this plan. An eval that exists in code but was never run scores nothing.

Run every row at H+20–22 and write down what actually happened. Record failures honestly with a named cause: 7/8 with an explanation reads as a team that measured its system, an empty column reads as a team that didn't.

| Eval | Expected | Actual | Pass |
|---|---|---|---|
| 1. Real billing bug | `REPRODUCED` | TBD | TBD |
| 2. Fixed build | `VERIFIED_FIXED` | TBD | TBD |
| 3. Superficial fix | `STILL_BROKEN` | TBD | TBD |
| 4. Ambiguous report | `SPEC_FAILED` | TBD | TBD |
| 5. Staging unavailable | `INCONCLUSIVE` | TBD | TBD |
| 6. Duplicate Slack event | one case | TBD | TBD |
| 7. Interrupted Linear response | one issue | TBD | TBD |
| 8. Duplicate merge webhook | one verification | TBD | TBD |
| 8b. New SHA after STILL_BROKEN | accepted | TBD | TBD |

## What not to count as success

Do not count:
- model confidence,
- a 200 from Linear, GitHub, or Slack,
- a PR merge,
- issue status alone,
- a screenshot that merely looks correct.

The verdict comes from the classification truth table, executed against evidence collected from the deployed build.

## Stretch evals

If time remains:
- a renamed UI element is recovered through single-step re-resolution, `plan_recovered` is surfaced, and the verdict still holds
- an unrelated PR merge does not trigger verification
- an old deployment-ready event carrying a stale SHA is rejected and logged to `rejected_events`
- a deployment-ready event arriving in the wrong case status is rejected
- retry budget exhaustion produces `INCONCLUSIVE`
- an invalid transition attempt is rejected and persisted
