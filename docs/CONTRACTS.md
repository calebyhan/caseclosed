# Contracts

Freeze this file in hour one, before anyone writes feature code.

Everything here is an interface between two lanes that will be built in parallel. Once these shapes are agreed, four people can work against mocks without blocking each other, and integration on the far side is mechanical. Changing a shape after the freeze means finding whoever depends on it first — treat it as a team-wide decision, not a local edit.

Source of truth for these types at build time: `src/contracts/`. This document and that directory must not drift.

---

## 1. AppContext

Checked in at `config/environments/<id>.json`. Its SHA-256 is stamped onto every ReproSpec.

```ts
import { z } from "zod";

export const AppContext = z.object({
  environment_id: z.string(),
  base_url: z.string().url(),
  routes: z.array(z.object({
    path: z.string().startsWith("/"),
    name: z.string(),
    description: z.string(),
  })).min(1),
  api_endpoints: z.array(z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().startsWith("/"),
    description: z.string(),
  })),
  landmarks: z.array(z.object({
    route: z.string().startsWith("/"),
    role: z.string(),
    name: z.string(),
    description: z.string(),
  })),
  fixtures: z.array(z.object({
    id: z.string(),
    description: z.string(),
  })).min(1),
});

export type AppContext = z.infer<typeof AppContext>;
```

---

## 2. ReproSpec

```ts
export const Assertion = z.discriminatedUnion("type", [
  z.object({
    id: z.string(), type: z.literal("element_visible"),
    role: z.string(), name: z.string(),
    within_ms: z.number().int().min(100).max(10_000).default(5_000),
  }),
  z.object({
    id: z.string(), type: z.literal("element_not_visible"),
    role: z.string(), name: z.string(),
    within_ms: z.number().int().min(100).max(10_000).default(5_000),
  }),
  z.object({
    id: z.string(), type: z.literal("url_contains"),
    value: z.string(),
    within_ms: z.number().int().min(100).max(10_000).default(5_000),
  }),
  z.object({
    id: z.string(), type: z.literal("network_status"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url_contains: z.string(),
    min: z.number().int().min(100).max(599),
    max: z.number().int().min(100).max(599),
  }),
  z.object({
    id: z.string(), type: z.literal("text_visible"),
    value: z.string(),
    within_ms: z.number().int().min(100).max(10_000).default(5_000),
  }),
]);

export const FailureSignal = z.discriminatedUnion("type", [
  z.object({
    id: z.string(), type: z.literal("network_status"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url_contains: z.string(),
    min: z.number().int().min(100).max(599),
    max: z.number().int().min(100).max(599),
  }),
  z.object({
    id: z.string(), type: z.literal("element_still_visible_after_ms"),
    role: z.string(), name: z.string(),
    after_ms: z.number().int().min(500).max(3_000),
  }),
  z.object({
    id: z.string(), type: z.literal("text_visible"),
    value: z.string(),
    within_ms: z.number().int().min(100).max(10_000).default(5_000),
  }),
]);

export const ReproSpec = z.object({
  version: z.literal("1"),
  case_id: z.string(),
  app_context_hash: z.string(),
  environment: z.object({
    id: z.string(),
    start_path: z.string().startsWith("/"),
    fixture: z.string(),
  }),
  goal: z.string().min(1),
  steps: z.array(z.object({
    id: z.string(),
    intent: z.string().min(1),
  })).min(1),
  assertions: z.array(Assertion).min(1),
  failure_signals: z.array(FailureSignal).min(1),
  evidence: z.object({
    screenshots: z.boolean().default(true),
    network: z.boolean().default(true),
    console: z.boolean().default(true),
    actions: z.boolean().default(true),
  }),
});
```

`failure_signals` is `.min(1)` deliberately. Without one, truth-table rule 2 can never fire and no case can ever reproduce.

Semantic validation beyond the schema — fixture exists, start path is a known route, `app_context_hash` current, `min <= max` — lives in `validateReproSpec(spec, ctx)` and returns structured errors suitable for feeding back to the model.

---

## 3. Model I/O

### Spec generation

```ts
export const SpecGenerationResult = z.object({
  sufficient: z.boolean(),
  missing: z.array(z.string()),
  spec: ReproSpec.nullable(),
});
```

Invariant, enforced after parse: `sufficient === (spec !== null)`.

Inputs to the prompt: the raw report, the full AppContext, and the JSON schema derived from `ReproSpec`.

### Step resolution

```ts
export const BrowserAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"),   path: z.string().startsWith("/") }),
  z.object({ type: z.literal("click"),  role: z.string(), name: z.string() }),
  z.object({ type: z.literal("fill"),   role: z.string(), name: z.string(), value: z.string() }),
  z.object({ type: z.literal("select"), role: z.string(), name: z.string(), value: z.string() }),
  z.object({ type: z.literal("wait"),   milliseconds: z.number().int().min(100).max(5_000) }),
  z.object({ type: z.literal("finish"), reason: z.string() }),
]);
```

Inputs to the prompt: the step intent, the current accessibility tree snapshot, the AppContext landmarks for the current route.

Every model call goes through one wrapper that enforces the 20s timeout, the `responseSchema`, Zod parsing, and the retry budget — and that **counts calls per run**. The counter is what Eval 2 asserts is zero during verification.

### Known gotcha: discriminated unions in `responseSchema`

`z.discriminatedUnion` converts to JSON Schema `anyOf`, and Gemini's `responseSchema` support for `anyOf` is limited. Expect the assertion and action schemas to be the place this bites, around H+3.

Mitigation, decided in advance so nobody improvises it under time pressure: send the model a **flattened** schema — one object per list item with a `type` enum and the superset of fields, all optional except `type` — then parse the response through the strict `discriminatedUnion` on the way in. Generation is loosely constrained, validation stays exact, and the retry loop feeds Zod's errors back to the model. Keep the strict schemas as the only types the rest of the codebase sees.

---

## 4. Resolved plan

Promoted to the case on a successful reproduction. Replayed literally during verification.

```ts
export const ResolvedPlan = z.object({
  case_id: z.string(),
  spec_version: z.literal("1"),
  actions: z.array(z.object({
    step_id: z.string(),
    action: BrowserAction,
  })).min(1),
});
```

---

## 5. Run observations and result

`RunObservations` is what the browser worker emits. `RunResult` is what the assertion engine returns. The engine is a pure function of the two inputs:

```ts
classify(observations: RunObservations, spec: ReproSpec, runType: RunType): RunResult
```

No I/O, no model, fully unit-testable.

```ts
export type RunObservations = {
  network: Array<{
    method: string; url: string; status: number; timestamp_ms: number;
  }>;
  console: Array<{ level: string; text: string; timestamp_ms: number }>;
  actions: Array<{ step_id: string; action: BrowserAction; ok: boolean; error?: string }>;
  final_url: string;
  element_probes: Array<{
    role: string; name: string; visible_at_ms: number | null; still_visible_at_ms: number[];
  }>;
  text_probes: Array<{ value: string; visible_at_ms: number | null }>;
  infra_error: boolean;
  infra_error_reason?: InfraErrorReason;
  plan_recovered: boolean;
  duration_ms: number;
  model_calls: number;
};

export type InfraErrorReason =
  | "fixture_reset_failed" | "staging_unreachable" | "browser_crashed"
  | "auth_failed" | "action_budget_exhausted" | "duration_budget_exhausted"
  | "step_unresolvable" | "plan_recovery_failed";

export type AssertionOutcome = {
  id: string; type: string; passed: boolean;
  expected: string; observed: string;
};

export type RunResult = {
  result:
    | "REPRODUCED" | "NOT_REPRODUCED"
    | "VERIFIED_FIXED" | "STILL_BROKEN"
    | "INCONCLUSIVE";
  assertions: AssertionOutcome[];
  signals: AssertionOutcome[];
  assertions_passed: number;
  assertions_total: number;
  signals_matched: number;
  infra_error: boolean;
  infra_error_reason?: InfraErrorReason;
  plan_recovered: boolean;
  model_calls: number;
};
```

The classification logic is specified in [`REPROSPEC.md`](REPROSPEC.md#classification-truth-table). Implement it once. Unit-test every row of both tables, including the mixed-evidence rows — those are the ones that protect the headline metric.

### `network_status` matching

Shared by assertions and signals, and easy to get subtly wrong:

1. drop every `OPTIONS` request,
2. keep responses where `method` matches **and** the URL contains `url_contains`,
3. take the **last** by `timestamp_ms`,
4. pass if `min <= status <= max`,
5. no match → fail, `observed = "no_matching_request"`.

---

## 6. Case status

```ts
export const CaseStatus = z.enum([
  "RECEIVED", "SPEC_CREATED", "SPEC_FAILED",
  "REPRODUCING", "REPRODUCED", "NOT_REPRODUCED", "REPRO_INCONCLUSIVE",
  "ISSUE_FILED", "WAITING_FOR_FIX",
  "FIX_MERGED", "WAITING_FOR_DEPLOYMENT",
  "VERIFYING", "VERIFIED_FIXED", "STILL_BROKEN", "VERIFICATION_INCONCLUSIVE",
]);
```

Transitions go through one guarded function checking `(from, to)` against the table in [`STATE_MACHINE.md`](STATE_MACHINE.md#transition-triggers). Rejected attempts persist to `rejected_events`.

---

## 7. Database schema

Drizzle, SQLite, WAL mode.

```ts
cases            id  status  report  source_type  source_channel_id
                 source_thread_ts  source_trigger_id  environment_id
                 created_at  updated_at

repro_specs      id  case_id  version  app_context_hash  spec_json  created_at

resolved_plans   id  case_id  plan_json  created_at

runs             id  case_id  run_type  status  result
                 assertions_passed  assertions_total  signals_matched
                 infra_error  infra_error_reason  plan_recovered
                 model_calls  commit_sha  started_at  finished_at

browser_actions  id  run_id  seq  step_id  action_json  ok  error

assertion_results id run_id  kind(assertion|signal)  assertion_id
                 type  passed  expected  observed

evidence         id  run_id  kind  path  meta_json

external_links   case_id  slack_thread_ts  linear_issue_id
                 github_repo  github_pr_number  github_commit_sha

jobs             id  case_id  type  status  attempt_count  run_after
                 idempotency_key  payload_json  run_id

side_effects     idempotency_key(PK)  type  external_id
                 completed_at  result_json

transitions      id  case_id  from_status  to_status  trigger  created_at

rejected_events  id  case_id  event_type  reason  payload_json  created_at
```

`jobs.run_id` is what implements *a retry resumes its existing run*. Set it on first claim; reuse it on every retry.

---

## 8. HTTP endpoints

### CaseClosed

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/slack/command` | Verify signature, dedupe `trigger_id`, **ack within 3s** |
| `POST` | `/api/github/webhook` | Verify `GITHUB_WEBHOOK_SECRET`; handle `pull_request.closed` with `merged: true` |
| `POST` | `/api/caseclosed/deployment-ready` | `X-CaseClosed-Secret`; body `{ pr, commit_sha, retry? }` |
| `GET` | `/api/cases/:id` | Case page data: case, spec, runs, assertions, evidence, links, timeline |
| `GET` | `/case/:id` | Case page |

### Staging app (AcmeCloud)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/test/reset` | `X-CaseClosed-Secret`; body `{ fixture }` |
| `GET` | `/api/health` | `{ commit_sha, build }` — how CI confirms a deploy landed |
| `POST` | `/api/subscription` | The endpoint under test |

---

## 9. Idempotency keys

```text
slack:case-created:<trigger_id>
linear:create:<case_id>
slack:repro-result:<run_id>
slack:verify-result:<run_id>
github:verify-comment:<run_id>
linear:verify-comment:<run_id>
```

Run-scoped, not PR-scoped: a PR-scoped verification key would suppress the second comment in a `STILL_BROKEN → VERIFIED_FIXED` sequence, which is the sequence the demo walks.

---

## 10. Mock fixtures for parallel work

Commit these on day one so no lane waits on another:

```text
fixtures/app-context.staging.json     valid AppContext
fixtures/repro-spec.valid.json        the golden-path spec
fixtures/repro-spec.invalid.json      fails semantic validation
fixtures/spec-result.insufficient.json  sufficient: false with missing[]
fixtures/observations.reproduced.json   → REPRODUCED
fixtures/observations.fixed.json        → VERIFIED_FIXED
fixtures/observations.superficial.json  → STILL_BROKEN
fixtures/observations.infra-error.json  → INCONCLUSIVE
fixtures/observations.mixed.json        → INCONCLUSIVE via rule 4
evals/reports.json                      10 labeled reports (7 sufficient, 3 not)
```

The four `observations.*` fixtures let the assertion engine be built and fully tested before Playwright runs even once. That is the single biggest parallelism unlock in the build.
