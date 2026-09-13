# State Machine

## Case status vs. run result

These are two different things and conflating them loses information.

- **`case.status`** — where the case sits in its lifecycle. One value per case, advanced only by valid transitions.
- **`run.result`** — the outcome of one execution of the ReproSpec. Many runs per case.

A verification run that comes back `INCONCLUSIVE` must not erase the fact that the bug was reproduced, an issue was filed, and a fix was merged. So the case moves to `VERIFICATION_INCONCLUSIVE` — a retryable state that remembers all of that — while the run itself records `INCONCLUSIVE`.

```text
run.result (reproduction)  : REPRODUCED | NOT_REPRODUCED | INCONCLUSIVE
run.result (verification)  : VERIFIED_FIXED | STILL_BROKEN | INCONCLUSIVE
```

Both are produced by the truth table in [`docs/REPROSPEC.md`](REPROSPEC.md#classification-truth-table). Neither is produced by the model.

---

## Canonical lifecycle

```text
RECEIVED
  ├────────────────────────────────► SPEC_FAILED            (terminal)
  ▼
SPEC_CREATED
  ▼
REPRODUCING
  ├────────────────────────────────► NOT_REPRODUCED         (terminal)
  ├────────────────────────────────► REPRO_INCONCLUSIVE     (terminal)
  ▼
REPRODUCED
  ▼
ISSUE_FILED
  ▼
WAITING_FOR_FIX ◄──────────────────────────┐
  ▼                                        │
FIX_MERGED                                 │
  ▼                                        │
WAITING_FOR_DEPLOYMENT ◄───────┐           │
  ▼                            │           │
VERIFYING                      │           │
  ├───► VERIFICATION_INCONCLUSIVE          │
  ├───► STILL_BROKEN ──────────────────────┘
  ▼
VERIFIED_FIXED
```

Two loops, both deliberate:

- `STILL_BROKEN → WAITING_FOR_FIX` when another fix attempt is associated. This is the path the demo exercises.
- `VERIFICATION_INCONCLUSIVE → WAITING_FOR_DEPLOYMENT` when the verification experiment itself was invalid and can be retried. The fix is still merged; only the experiment failed.

---

## State definitions

### `RECEIVED`

A Slack `/caseclosed` command has been accepted, deduplicated, and persisted.

Persisted: case ID, original report, Slack source metadata (`channel_id`, `thread_ts`, `trigger_id`), environment ID.

Side effects: reply in Slack that the case was created.

Next: generate ReproSpec.

### `SPEC_CREATED`

A valid ReproSpec has been generated and persisted.

Entry requirements: the model returned `sufficient: true`, schema validation passed, the fixture and start path exist in the AppContext, `app_context_hash` matches, and all assertion types are supported.

Next: enqueue reproduction job.

### `SPEC_FAILED`

No reliable executable test could be constructed from the report. Reached two ways:

- the model returned `sufficient: false`, or
- schema validation failed on all three attempts.

Side effects: Slack reply explaining which of the two occurred; for `sufficient: false`, list the `missing` items so the reporter can refile.

**No Linear issue is created.** Terminal for MVP. `INCONCLUSIVE`-class for eval accounting.

### `REPRODUCING`

A worker has claimed the reproduction job.

1. reset fixture,
2. open fresh browser context, load storage state,
3. resolve each step intent to a `BrowserAction` and execute it,
4. capture evidence,
5. evaluate assertions and failure signals,
6. apply the reproduction truth table.

Run outcomes: `REPRODUCED`, `NOT_REPRODUCED`, `INCONCLUSIVE`.

### `REPRODUCED`

The customer-reported failure was observed with deterministic evidence.

Side effects: promote the run's resolved action sequence to the case as its **resolved plan**, enqueue Linear issue creation, update Slack thread.

Next: `ISSUE_FILED`.

### `NOT_REPRODUCED`

The experiment ran validly and the claimed failure did not occur.

Side effects: Slack update with the result and evidence summary.

Terminal for MVP unless manually retried.

### `REPRO_INCONCLUSIVE`

A reliable reproduction experiment could not be completed: fixture reset failed, staging unavailable, browser failure, action or duration budget exhausted, a step could not be resolved, or the evidence was mixed (truth-table rule 4).

Side effects: Slack update naming the blocking reason.

Terminal for MVP unless manually retried. No Linear issue.

### `ISSUE_FILED`

Exactly one Linear issue exists for the case.

Side effects: persist the Linear issue ID, apply `caseclosed-reproduced`, update Slack.

Next: `WAITING_FOR_FIX`.

### `WAITING_FOR_FIX`

Waiting for an associated GitHub fix PR. Association is accepted when PR metadata contains `Fixes ENG-###` or `CaseClosed: CC-####`.

No verification occurs while a PR is merely open.

### `FIX_MERGED`

An associated PR has been merged.

Side effects: persist `github_pr_number` and `github_commit_sha` (the merge commit). This SHA becomes the expected commit for the next verification.

Next: `WAITING_FOR_DEPLOYMENT`.

### `WAITING_FOR_DEPLOYMENT`

Waiting for explicit confirmation that the merge commit is live on staging. Never a fixed sleep. See the deployment-ready contract in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md#deployment-ready-contract).

### `VERIFYING`

1. reset the original fixture,
2. fresh browser context,
3. execute the case's **resolved plan** literally — no model calls,
4. evaluate the same assertions and failure signals,
5. apply the verification truth table.

Run outcomes: `VERIFIED_FIXED`, `STILL_BROKEN`, `INCONCLUSIVE`.

### `VERIFIED_FIXED`

Every assertion passed and no failure signal matched.

Side effects: comment on the GitHub PR, comment on the Linear issue, apply `caseclosed-verified`, update Slack. If `plan_recovered` was set, say so in all three.

CaseClosed does **not** close the Linear issue.

### `STILL_BROKEN`

The original failure remains observable, or a required assertion failed.

Side effects: comment on the GitHub PR with the failing assertions and matched signals, comment on the Linear issue, apply `caseclosed-still-broken`, update Slack.

Returns to `WAITING_FOR_FIX` when another fix attempt is associated.

### `VERIFICATION_INCONCLUSIVE`

The verification experiment could not be trusted — same conditions as `REPRO_INCONCLUSIVE`, plus a failed plan recovery.

The fix is still merged and the issue is still filed; only the experiment failed. Side effects: Slack update naming the blocking reason, Linear comment noting that verification could not complete.

Returns to `WAITING_FOR_DEPLOYMENT`, so a re-sent deployment-ready event retries verification.

Never reported as `VERIFIED_FIXED` or `STILL_BROKEN`.

---

## Transition triggers

| From | To | Trigger |
|---|---|---|
| `RECEIVED` | `SPEC_CREATED` | valid ReproSpec persisted |
| `RECEIVED` | `SPEC_FAILED` | `sufficient: false`, or validation failed 3× |
| `SPEC_CREATED` | `REPRODUCING` | worker claims reproduction job |
| `REPRODUCING` | `REPRODUCED` | truth table rule 2 |
| `REPRODUCING` | `NOT_REPRODUCED` | truth table rule 3 |
| `REPRODUCING` | `REPRO_INCONCLUSIVE` | truth table rule 1 or 4 |
| `REPRODUCED` | `ISSUE_FILED` | Linear issue created idempotently |
| `ISSUE_FILED` | `WAITING_FOR_FIX` | issue ID persisted |
| `WAITING_FOR_FIX` | `FIX_MERGED` | associated PR merged |
| `FIX_MERGED` | `WAITING_FOR_DEPLOYMENT` | merge commit SHA persisted |
| `WAITING_FOR_DEPLOYMENT` | `VERIFYING` | deployment-ready accepted for the expected SHA |
| `VERIFYING` | `VERIFIED_FIXED` | verification truth table rule 2 |
| `VERIFYING` | `STILL_BROKEN` | verification truth table rule 3 |
| `VERIFYING` | `VERIFICATION_INCONCLUSIVE` | verification truth table rule 1 |
| `STILL_BROKEN` | `WAITING_FOR_FIX` | new fix attempt associated |
| `VERIFICATION_INCONCLUSIVE` | `WAITING_FOR_DEPLOYMENT` | operator or CI retries |

---

## Duplicate event behavior

Every transition is idempotent. The rule that matters: **deduplicate on the identity of the event, never on the current case status.** Status-based dedupe breaks the legitimate retry loops above.

### Duplicate Slack slash command

Slash commands do not carry an Events API `event_id`. Slack retries the same invocation with the same `trigger_id`, so that is the dedupe key:

```text
slack:case-created:<trigger_id>
```

Result: one case, one thread. A retry returns the existing case.

Slack also sets `X-Slack-Retry-Num` on retries; log it, but do not rely on it as the key.

Verify this early with a deliberately slow handler: confirm that a Slack retry arrives carrying the same `trigger_id`. If it does not, fall back to a composite key of `(channel_id, user_id, sha256(text), 60s time bucket)`. Eval 6 depends on whichever key you land on, so settle it before that eval is written.

### Duplicate GitHub merge webhook

Dedupe on `(case_id, pr_number, commit_sha)`.

The original design ignored a merge event whenever the case was already `FIX_MERGED` or beyond. That is wrong: after `STILL_BROKEN → WAITING_FOR_FIX`, the case *is* "beyond," and a second, legitimate fix merge would be silently dropped — which is exactly the path the demo exercises.

- Same `(case, pr, sha)` seen again → no-op, return the existing transition.
- New `sha` for the case → a genuine new fix attempt; accept it.

### Duplicate deployment-ready event

Dedupe on `(case_id, commit_sha)`. At most one verification run per pair.

Reject outright, without transitioning, when:
- `commit_sha` does not match the case's persisted `github_commit_sha`, or
- the case is not in `WAITING_FOR_DEPLOYMENT` or `VERIFICATION_INCONCLUSIVE`.

A rejected event is persisted with its reason. This is what makes "an old deployment-ready event is ignored" and "verification against the wrong commit is rejected" real rather than aspirational.

A retry after `VERIFICATION_INCONCLUSIVE` is the one case where the same `(case, sha)` may legitimately start a second run. That retry is operator-initiated and passes an explicit `retry: true`; without it, the pair is a no-op.

### Job retries and run identity

> A job retry resumes its existing run. A new run row is created only by a new trigger.

This is what keeps `<run_id>`-scoped idempotency keys stable. If a retried job created a fresh run, `linear:verify-comment:<run_id>` would produce a second comment on every retry.

---

## Invalid transitions

Reject anything that violates lifecycle order. Examples:

- `RECEIVED → VERIFIED_FIXED`
- `NOT_REPRODUCED → ISSUE_FILED`
- `SPEC_FAILED → REPRODUCING`
- `WAITING_FOR_FIX → VERIFYING` without a deployment-ready event
- `VERIFIED_FIXED → REPRODUCING`

Transitions are applied through a single guarded function that checks the `(from, to)` pair against the table above. Rejected attempts are persisted with their reason — it is the first thing you will want during the demo when a case appears stuck.
