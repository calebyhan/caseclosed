# ReproSpec

## Purpose

`ReproSpec` is the contract between:
- natural-language bug interpretation,
- browser execution,
- deterministic evaluation,
- post-fix verification.

A ReproSpec is generated once for a case and replayed unchanged during verification.

## Core guarantee

> Reproduction and verification must use the same semantic steps, fixture, assertions, and failure signals.

The ReproSpec is never regenerated after the fix. See [Resolve once, replay literally](#resolve-once-replay-literally) for how low-level selector drift is handled without violating this.

---

## Inputs to spec generation

The model receives three inputs. All three are recorded on the case.

1. **The customer report** — raw text from Slack.
2. **The AppContext** — a static description of the target environment.
3. **The ReproSpec JSON schema** — derived from the Zod schema in `docs/CONTRACTS.md`.

### AppContext

A bug report says "it spins forever." It does not say that the endpoint is `POST /api/subscription`, or that a "Checkout" heading should appear on success. The model cannot invent those facts, and hardcoding them into the spec generator is explicitly an MVP failure.

Instead, each environment ships a checked-in **AppContext** describing what the app contains. This is legitimate: it is our own staging app, and a real deployment would supply the same information from an OpenAPI spec plus a route manifest.

```jsonc
{
  "environment_id": "staging",
  "base_url": "https://staging.acmecloud.local",
  "routes": [
    { "path": "/dashboard",        "name": "Dashboard",  "description": "Post-login landing page" },
    { "path": "/settings/billing", "name": "Billing",    "description": "Plan and billing period management" },
    { "path": "/checkout",         "name": "Checkout",   "description": "Payment confirmation for a plan change" }
  ],
  "api_endpoints": [
    { "method": "POST", "path": "/api/subscription", "description": "Applies a plan or billing-period change" },
    { "method": "GET",  "path": "/api/account",      "description": "Returns current plan and billing period" }
  ],
  "landmarks": [
    { "route": "/settings/billing", "role": "radio",   "name": "Annual",           "description": "Selects annual billing" },
    { "route": "/settings/billing", "role": "button",  "name": "Upgrade",          "description": "Submits the plan change" },
    { "route": "/settings/billing", "role": "status",  "name": "Loading",          "description": "Spinner shown while the change is in flight" },
    { "route": "/checkout",         "role": "heading", "name": "Checkout",         "description": "Rendered when the change succeeds" },
    { "route": "/checkout",         "role": "heading", "name": "Upgrade complete", "description": "Rendered after payment confirmation" }
  ],
  "fixtures": [
    { "id": "pro_monthly_customer", "description": "Authenticated Pro customer on monthly billing" }
  ]
}
```

Stored at `config/environments/<environment_id>.json`. Its SHA-256 is persisted on the ReproSpec as `app_context_hash`, so verification can confirm it is reasoning about the same application surface.

**Requirement on the staging app:** every `landmark` must have a stable, deliberate accessible role and name. The entire locator strategy depends on this. Adding `aria-label` / semantic elements to the golden-path components is part of building the staging app, not an afterthought.

---

## Sufficiency gate

Structural validation cannot catch a vague report. Gemini will happily emit a schema-valid ReproSpec for "the app is broken," and that spec will produce a meaningless experiment.

The model therefore returns a wrapper, not a bare spec:

```jsonc
{
  "sufficient": true,
  "missing": [],
  "spec": { /* ReproSpec */ }
}
```

When the report does not support a reliable executable test:

```jsonc
{
  "sufficient": false,
  "missing": [
    "which page or workflow the failure occurs on",
    "what the user expected to happen instead"
  ],
  "spec": null
}
```

`sufficient: false` moves the case to `SPEC_FAILED` (an `INCONCLUSIVE`-class terminal state). CaseClosed replies in the Slack thread listing `missing`, and **no Linear issue is created**.

The model is instructed that a report is sufficient only if it can identify, from the report plus AppContext:
- a starting route,
- at least one concrete user action,
- at least one observable success condition,
- at least one observable failure condition.

---

## Example

```json
{
  "version": "1",
  "case_id": "CC-0042",
  "app_context_hash": "sha256:9f2c…",
  "environment": {
    "id": "staging",
    "start_path": "/settings/billing",
    "fixture": "pro_monthly_customer"
  },
  "goal": "Reproduce failure when changing billing from monthly to annual",
  "steps": [
    { "id": "step_1", "intent": "Select annual billing" },
    { "id": "step_2", "intent": "Click Upgrade" }
  ],
  "assertions": [
    {
      "id": "a1",
      "type": "network_status",
      "method": "POST",
      "url_contains": "/api/subscription",
      "min": 200,
      "max": 299
    },
    {
      "id": "a2",
      "type": "element_visible",
      "role": "heading",
      "name": "Checkout",
      "within_ms": 5000
    }
  ],
  "failure_signals": [
    {
      "id": "f1",
      "type": "network_status",
      "method": "POST",
      "url_contains": "/api/subscription",
      "min": 500,
      "max": 599
    },
    {
      "id": "f2",
      "type": "element_still_visible_after_ms",
      "role": "status",
      "name": "Loading",
      "after_ms": 3000
    }
  ],
  "evidence": {
    "screenshots": true,
    "network": true,
    "console": true,
    "actions": true
  }
}
```

The authoritative TypeScript / Zod definition lives in [`docs/CONTRACTS.md`](CONTRACTS.md). It is frozen before implementation starts.

---

## Supported assertions

Keep the MVP assertion language intentionally small. **Every entry in `assertions` is required.** There is no optional assertion in v1 — if it is in the list, it must pass.

### `element_visible`

```json
{ "id": "a2", "type": "element_visible", "role": "heading", "name": "Checkout", "within_ms": 5000 }
```

`role` is **required**. `{"name": "Checkout"}` alone is ambiguous — heading, button, or link — and ambiguity here surfaces as demo flake. Resolution uses Playwright `getByRole(role, { name })`.

Passes when the element becomes visible before `within_ms`.

### `element_not_visible`

```json
{ "id": "a3", "type": "element_not_visible", "role": "status", "name": "Loading", "within_ms": 5000 }
```

Passes when the element is absent or becomes hidden before `within_ms`.

### `url_contains`

```json
{ "id": "a4", "type": "url_contains", "value": "/checkout", "within_ms": 5000 }
```

### `network_status`

```json
{ "id": "a1", "type": "network_status", "method": "POST", "url_contains": "/api/subscription", "min": 200, "max": 299 }
```

`method` is **required**. Matching rules, all of which matter in practice:

- A response matches when `request.method === method` **and** the URL contains `url_contains`.
- `OPTIONS` requests are always ignored, regardless of `method`.
- If several responses match, the **last** one wins. A buggy build that retries produces two 500s; a fixed build that polls produces a 200 followed by GETs. Last-match keeps both readable.
- If no response matches, the assertion **fails** and the run records `no_matching_request` — this is a failure, not an error, but see the truth table for how a run with zero matched requests is classified.

### `text_visible`

```json
{ "id": "a5", "type": "text_visible", "value": "Upgrade complete", "within_ms": 5000 }
```

Use when the element has no reliable role — otherwise prefer `element_visible`.

---

## Failure signals

Failure signals describe concrete observations consistent with the customer complaint. They are not free-form model judgments, and they use the same matching rules as the assertions above.

Three types in v1:

### `network_status`

Identical shape to the assertion. Typically a 5xx range on the endpoint behind the failing action.

### `element_still_visible_after_ms`

```json
{ "id": "f2", "type": "element_still_visible_after_ms", "role": "status", "name": "Loading", "after_ms": 3000 }
```

Distinct from `element_visible` on purpose: this asserts **persistence**, not appearance. A spinner that is still on screen after the threshold is the signal.

`after_ms` is capped at **3000**. A 10-second confirmation wait consumes a fifth of the run budget and stalls the demo for no additional evidentiary value — a spinner still turning at 3s in a controlled fixture is already conclusive.

### `text_visible`

An error string appearing on screen.

---

## Classification truth table

This is the core product claim, and it is roughly twenty lines of code. It must not be prose.

A run produces:
- `infra_error: boolean` — fixture reset failed, staging unreachable, browser crashed, auth failed, action budget exhausted, run duration exceeded, or a step could not be resolved within its recovery budget.
- `assertions_passed: number` / `assertions_total: number`
- `signals_matched: number`

### Reproduction

Evaluated **in order**. The first matching rule wins.

| # | Condition | Result |
|---|---|---|
| 1 | `infra_error` | `INCONCLUSIVE` |
| 2 | `signals_matched >= 1` **and** `assertions_passed < assertions_total` | `REPRODUCED` |
| 3 | `signals_matched == 0` **and** `assertions_passed == assertions_total` | `NOT_REPRODUCED` |
| 4 | anything else | `INCONCLUSIVE` |

Rule 1 dominates: infrastructure failure is never mapped to `NOT_REPRODUCED`.

Rule 4 is the important one. It catches the two mixed states the original spec left undefined:
- assertions failed but **no** failure signal matched — something is wrong, but not the thing the customer described, so we do not claim reproduction;
- a failure signal matched but **all** assertions passed — contradictory evidence, so the experiment is not trustworthy.

### Verification

Same run shape, same ordering, using the same ReproSpec.

| # | Condition | Result |
|---|---|---|
| 1 | `infra_error` | `INCONCLUSIVE` |
| 2 | `signals_matched == 0` **and** `assertions_passed == assertions_total` | `VERIFIED_FIXED` |
| 3 | `signals_matched >= 1` **or** `assertions_passed < assertions_total` | `STILL_BROKEN` |

`VERIFIED_FIXED` requires a clean sweep: every assertion passing **and** zero failure signals. Every mixed or degraded outcome falls to `STILL_BROKEN` or `INCONCLUSIVE`.

This ordering is what protects the headline metric — **false `VERIFIED_FIXED` = 0**. There is no path to `VERIFIED_FIXED` that tolerates a partial result.

The truth table is implemented once, in the assertion engine, and covered by unit tests that enumerate every row. It does not call the LLM.

---

## Resolve once, replay literally

The original design left two incompatible readings on the table: a per-step deterministic resolution, or an agentic observe→plan→act loop with a replan budget. They have opposite risk profiles. This is the decision.

**Reproduction** resolves each semantic `step.intent` into exactly one concrete `BrowserAction`, using the LLM plus the AppContext and the current accessibility tree. Each resolved action is persisted on the run in order.

On a successful reproduction (`REPRODUCED`), the winning sequence is promoted to the case as its **resolved plan**:

```jsonc
{
  "case_id": "CC-0042",
  "spec_version": "1",
  "actions": [
    { "step_id": "step_1", "type": "click", "role": "radio",  "name": "Annual" },
    { "step_id": "step_2", "type": "click", "role": "button", "name": "Upgrade" }
  ]
}
```

**Verification** loads the resolved plan and executes it literally. It does not consult the model.

> The verification path contains zero model calls.

That is worth stating plainly to judges. It makes "we replay the same experiment" a structural property rather than an aspiration, it removes the largest source of demo nondeterminism, and it makes a verification run fast enough (target: under 15s) to run twice inside a two-minute demo.

### Recovery

If a persisted action fails to resolve during verification — the UI genuinely changed — the runner may re-resolve **that step only** via the LLM, at most **once per run**. The run is then flagged `plan_recovered: true` and the flag is surfaced in Slack, on the case page, and in the verification comment.

A recovered run can still be `VERIFIED_FIXED`; the flag exists so a human can see that a selector moved. If recovery itself fails, the run is `infra_error` and therefore `INCONCLUSIVE`.

### What recovery may never do

Recovery changes how a step is located. It never changes what is being tested. Verification must not:
- regenerate assertions or failure signals,
- weaken thresholds or timeouts,
- skip or remove a step,
- substitute a different fixture,
- change the expected behavior.

---

## Constrained browser actions

```ts
type BrowserAction =
  | { type: "goto";   path: string }
  | { type: "click";  role: string; name: string }
  | { type: "fill";   role: string; name: string; value: string }
  | { type: "select"; role: string; name: string; value: string }
  | { type: "wait";   milliseconds: number }
  | { type: "finish"; reason: string };
```

`role` and `name` are required on every element-targeting action — same reasoning as the assertions. No coordinate clicking, and no raw CSS selectors, in the MVP.

Every proposed action is validated against this union before execution. `goto` paths must resolve within the environment's allowed base URL.

### Locator resolution order

1. accessible role + name,
2. label,
3. visible text,
4. test ID.

---

## Budgets

Tuned to the demo, not to a hypothetical worst case. A reproduction has to fit the ~25s window in `DEMO.md`, and two verification runs have to fit alongside it.

```text
max browser actions per run:      15
max run duration:                 45s
per-action timeout:                5s
default assertion within_ms:    5000ms
max failure-signal after_ms:    3000ms
step re-resolutions per run:        1
spec generation retries:            2
fresh browser context:            yes
fixture reset before every run:   yes
allowed domains:          staging only
```

Exceeding any budget sets `infra_error` and therefore classifies the run `INCONCLUSIVE`.

---

## Validation rules

A ReproSpec is valid only if:
- `version` is supported,
- `environment.id` is a known environment,
- `environment.fixture` exists in that environment's AppContext,
- `environment.start_path` is a route in that AppContext,
- `app_context_hash` matches the current AppContext,
- at least one step exists,
- at least one assertion exists,
- at least one failure signal exists,
- every assertion and failure-signal type is supported,
- `network_status` entries specify `method`,
- `element_visible` / `element_not_visible` / `element_still_visible_after_ms` entries specify `role`,
- all timeouts are within the configured maximums,
- no credentials or secrets are embedded.

Note that "at least one failure signal" is required. Without one, rule 2 of the truth table can never fire and the case can never reproduce.

### On validation failure

1. return the structured validation errors to the model,
2. retry up to two times,
3. if no valid spec is produced, move the case to `SPEC_FAILED`.

Validation failure and `sufficient: false` land in the same terminal state, with different Slack copy: one says the report was too vague, the other says CaseClosed could not build a valid experiment.

---

## Evidence contract

Each run stores:
- the resolved action log,
- assertion results, one row per assertion, with observed value,
- failure-signal results, one row per signal,
- network evidence,
- console evidence,
- screenshots when enabled,
- `infra_error` and its reason, when set,
- `plan_recovered`, when set.

The final classification must be reconstructible from these rows alone, without re-running anything and without consulting the model.
