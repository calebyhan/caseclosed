# Two-Minute Demo

## Objective

Demonstrate the complete CaseClosed product promise:

> A vague customer-reported bug becomes a reproducible, evidence-backed engineering issue — and when a plausible-looking fix is merged, CaseClosed catches that it did not actually work.

## The demo must contain a `STILL_BROKEN`

The original script ran the happy path only: report → reproduce → merge → verified. That demo looks like a well-built CI pipeline, and a judge has seen a well-built CI pipeline.

The argument for CaseClosed's existence is the case where a fix *looks* right and isn't. `EVALS.md` already names that the most important scenario. So the demo merges a **bad fix first**, watches CaseClosed reject it, then merges the real one.

That costs about twenty seconds and it is the whole pitch, dramatized. Everything else in this script is arranged around protecting those twenty seconds.

---

## Golden-path bug

Customer report:

> When I switch my Pro plan from monthly to annual and click Upgrade, it just spins forever.

| Build | `POST /api/subscription` | Spinner | Checkout | Verdict |
|---|---|---|---|---|
| buggy | 500 | never clears | absent | `REPRODUCED` |
| superficially fixed | 500 | clears | absent | `STILL_BROKEN` |
| fixed | 200 | clears | renders | `VERIFIED_FIXED` |

---

## Pre-demo setup

- staging fixture resets cleanly to `pro_monthly_customer`
- **buggy** build deployed and confirmed via `GET /api/health`
- **two** PRs open and ready to merge, in order:
  - PR A — the spinner-only fix (`Fixes ENG-142`, `CaseClosed: CC-0042`)
  - PR B — the real fix (same references)
- both fixed builds **pre-built**; the deploy step swaps and restarts, it does not compile
- Slack slash command installed, tunnel URL current
- Linear token works, GitHub webhook delivers, deployment-ready hook works
- database clean, or demo case IDs known
- browser worker running, case page open in a second tab

Verify the whole loop end to end at least once within the hour before presenting. Do not depend on live code generation during the demo.

### Timing budget

Two verification runs have to fit. Confirm beforehand:

- verification replay ≤ **15s** (no model calls, so this is achievable — see `REPROSPEC.md`)
- deploy + health-check + deployment-ready ≤ **8s** (pre-built artifacts, restart only)

If either overruns, use the pre-run fallback below rather than cutting the `STILL_BROKEN` beat.

---

## Sequence

### 0:00–0:10 — submit the customer report

```text
/caseclosed When I switch my Pro plan from monthly to annual and click Upgrade, it spins forever.
```

CaseClosed creates `CC-0042` and replies `Attempting reproduction…`

> Natural language in. No test supplied by the user.

### 0:10–0:35 — autonomous reproduction

Show the browser worker or the compact run view:

```text
Settings → Billing
Annual
Upgrade
```

Then the evidence:

```text
POST /api/subscription → 500      failure signal f1  ✓ matched
Loading still visible at 3000ms   failure signal f2  ✓ matched
Checkout heading visible → false  assertion a2       ✗ failed

REPRODUCED
```

> Gemini planned the semantic steps. Playwright executed them. A truth table made the call — not the model.

### 0:35–0:48 — engineering handoff

Linear issue, created automatically: original report, expected vs. actual, network evidence, screenshot, CaseClosed ID.

Slack:

```text
Reproduced. Linear: ENG-142. Evidence captured.
```

> Support-to-engineering handoff is now evidence-backed.

### 0:48–1:00 — merge the first fix

Open **PR A**. Show the diff — it clears the spinner on error.

```text
Fixes ENG-142
CaseClosed: CC-0042
```

Merge. CaseClosed receives the merge event, persists the SHA, waits for deployment-ready. CI deploys and signals.

> Merge is not proof. CaseClosed waits for the commit to actually be live.

### 1:00–1:15 — verification #1

```text
Same fixture. Same ReproSpec. Same resolved plan. Fresh browser. Zero model calls.
```

```text
POST /api/subscription → 500      failure signal f1  ✓ matched
Loading still visible at 3000ms   failure signal f2  ✗ not matched
Checkout heading visible → false  assertion a2       ✗ failed

STILL_BROKEN
```

**Pause here.** This is the moment the demo exists for.

> The spinner is gone, so the bug looks fixed. The customer's actual problem — the upgrade doesn't go through — is still there. A human reviewing this PR would have shipped it.

### 1:15–1:30 — the loop reopens

Show the GitHub comment on PR A naming the failing assertion and the matched signal. Show the Linear `caseclosed-still-broken` label. Show Slack.

Case returns to `WAITING_FOR_FIX`.

> No human had to notice. The case would not close.

### 1:30–1:42 — merge the real fix

Open **PR B**, show the diff fixing the API. Merge. Deploy.

Note that the second merge is accepted on a new commit SHA — the dedupe is per-event, not per-status, so a genuine second attempt is never dropped.

### 1:42–1:55 — verification #2

```text
POST /api/subscription → 200      assertion a1  ✓ passed
Checkout heading visible → true   assertion a2  ✓ passed
Failure signals matched: 0

VERIFIED_FIXED
```

> Same experiment, third time. Nothing was regenerated, weakened, or skipped.

### 1:55–2:00 — close the loop

End on the case page timeline: one report, one ReproSpec, three runs, two fix attempts, one verdict. Show that the Linear issue is **still open** — CaseClosed does not close it.

---

## Reliability points to mention

Keep these to a sentence each, and only if the clock allows:

- CaseClosed's database is canonical state; Slack, Linear, and GitHub are projections.
- The verification path contains zero model calls.
- External writes are idempotent; duplicate webhooks do not duplicate work.
- `INCONCLUSIVE` is explicit when a reliable experiment cannot run.
- False `VERIFIED_FIXED` is the metric the eval suite is built around.

---

## Optional reliability micro-demo

Only if the main flow is rock solid and time remains. Deliver a duplicate merge event:

```text
Duplicate event detected. No second verification started.
```

---

## Do not demo

- authentication setup
- environment configuration
- dashboard navigation
- model selection
- implementation code
- automatic code fixing

The demo is five beats: complaint, reproduction, evidence, **rejected fix**, verified fix.

---

## Fallbacks

**If the timing budget will not hold two live verification runs:** run the `STILL_BROKEN` case before the demo and open it in a second tab. Present verification #1 from the persisted case page — the assertion table and evidence are identical to the live view, and it is genuine recorded state, not a mock. Run only verification #2 live. Never cut the `STILL_BROKEN` beat.

**If an external UI is slow:** stay on the CaseClosed case page. It renders the same timeline, assertion table, and external IDs from the database. Never fake a side effect.

**If a deploy is delayed:** `scripts/deploy-staging.sh` performs the same sequence as CI and calls the same endpoint. Use it. Do not edit the database by hand.

**If the browser becomes flaky:** restart from a fixture reset with the same ReproSpec. Runs are cheap and the resolved plan is already persisted.

**If reproduction fails live:** you have the eval suite results. Show the recorded run for Eval 1, then continue the script from the Linear handoff.
