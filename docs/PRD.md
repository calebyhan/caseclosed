# Product Requirements Document

## Product

**CaseClosed**

## One-line pitch

CaseClosed converts customer-reported bugs into executable reproduction checks and independently reruns them after a fix to prove whether the original problem is actually resolved.

## Problem

Customer bug reports arrive as natural language. Engineering teams must manually:

1. interpret the report,
2. reproduce the problem,
3. gather evidence,
4. create an engineering issue,
5. track the fix,
6. retest the original failure after deployment.

The final step is often weak: teams infer that a bug is fixed because a PR merged or an issue was closed.

CaseClosed replaces that inference with a controlled replay of the original reproduction.

## Target user

Primary:
- engineering teams receiving customer-reported UI workflow bugs

Secondary:
- support engineers
- QA engineers
- developer productivity / reliability teams

## MVP problem class

CaseClosed supports **web UI workflow regressions** in a controlled staging environment.

Examples:
- button action fails,
- form submission fails,
- checkout fails,
- navigation breaks,
- modal does not appear,
- backend request behind a UI action errors.

Out of scope:
- mobile apps,
- production browsing,
- arbitrary customer environments,
- performance debugging,
- cross-browser compatibility,
- flaky distributed-system debugging.

## Golden-path scenario

Customer report:

> When I switch my Pro plan from monthly to annual and click Upgrade, it spins forever.

Expected:
- `POST /api/subscription` returns 2xx,
- checkout becomes visible.

Buggy behavior:
- request returns 500,
- loading state never resolves.

Superficially fixed behavior (the adversarial case):
- spinner clears,
- request still returns 500,
- checkout still does not render.

Fixed behavior:
- request returns 200,
- checkout renders.

## User journey

1. User submits `/caseclosed <bug report>` in Slack.
2. CaseClosed acknowledges within 3 seconds and creates case `CC-XXXX`.
3. Gemini receives the report plus the environment's **AppContext** and returns `{ sufficient, missing, spec }`.
4. If `sufficient: false`, the case ends at `SPEC_FAILED` with a Slack reply naming what was missing. No Linear issue.
5. Otherwise the ReproSpec is schema-validated (up to two model retries).
6. CaseClosed resets the staging fixture.
7. Playwright resolves each semantic step to one constrained action and executes it.
8. CaseClosed captures screenshots, network activity, console output, and the resolved action log.
9. The classification truth table produces `REPRODUCED`, `NOT_REPRODUCED`, or `INCONCLUSIVE`.
10. If reproduced: the resolved action sequence is promoted to the case as its **resolved plan**, exactly one Linear issue is created with evidence attached, and CaseClosed replies in the originating Slack thread.
11. A developer writes the fix and references the Linear or CaseClosed ID in a GitHub PR.
12. PR merge moves the case to `FIX_MERGED` and persists the merge commit SHA.
13. CI deploys the merge commit to staging, confirms it via the health endpoint, and posts a deployment-ready event carrying that SHA.
14. CaseClosed resets the same fixture.
15. CaseClosed replays the **resolved plan** literally, with no model calls, and evaluates the same assertions.
16. The truth table produces `VERIFIED_FIXED`, `STILL_BROKEN`, or `INCONCLUSIVE`.
17. CaseClosed comments in GitHub, updates Linear, and replies in Slack.
18. If `STILL_BROKEN`, the case returns to `WAITING_FOR_FIX` and a second fix attempt runs the same loop.
19. CaseClosed never auto-closes the Linear issue.

## Product principles

### 1. The LLM interprets intent; code establishes truth

The LLM may:
- interpret the bug report,
- judge whether a report is sufficient to test,
- produce semantic reproduction steps,
- resolve a step into a constrained browser action,
- summarize evidence.

The LLM may not:
- decide that a fix is verified from prose,
- override the classification truth table.

The verification execution path contains zero model calls.

### 2. Replay, do not regenerate

Verification reuses the same ReproSpec, fixture, assertions, and resolved plan. Nothing about the experiment is regenerated after the fix.

### 3. Inconclusive is acceptable

CaseClosed must not force certainty. `INCONCLUSIVE` is correct whenever the experiment itself cannot be completed reliably, and also whenever the evidence is mixed.

### 4. External systems are projections

CaseClosed's own database is the canonical source of truth. Slack, Linear, and GitHub may trigger or display state; they do not define the state machine.

## MVP integrations

### Slack
- slash command intake, acknowledged within 3 seconds,
- one thread per case,
- progress and final-result updates.

### Linear
- create issue only after confirmed reproduction,
- attach evidence,
- add verification comments and labels.

The issue body is a scored artifact, not plumbing. A judge who opens it should see a bug report an engineer would actually want to receive: the customer's own words, expected vs. actual stated plainly, the failing assertion with its observed value, and the screenshot. Cheap to get right, and it is the most direct evidence of usefulness outside the demo itself.

### GitHub
- associate fix PR,
- receive merge event,
- receive deployment-ready event from CI,
- comment with verification result.

### Browser / staging app
- run controlled reproduction,
- reset fixture,
- collect evidence.

## Human intervention boundary

Humans may:
- submit the bug,
- write the code fix,
- merge the PR.

CaseClosed must autonomously:
- interpret the report,
- create the ReproSpec,
- reproduce the issue,
- capture evidence,
- classify the reproduction,
- create the Linear issue,
- track the associated fix,
- trigger verification,
- replay the original reproduction,
- classify verification,
- update connected systems.

---

## MVP build scope

### `/MVP` — must ship

- staging app `AcmeCloud` with three routes, deliberate accessible names, fixture reset, and health endpoint
- three build variants: buggy, superficially fixed, fixed
- AppContext file per environment
- Slack `/caseclosed` with 3-second ack
- Gemini → `{ sufficient, missing, spec }` with Zod-validated structured output
- ReproSpec schema validation
- Playwright execution with per-step action resolution
- resolved plan persisted and replayed literally during verification
- assertion engine and classification truth table
- screenshots, network, and console evidence
- `REPRODUCED / NOT_REPRODUCED / INCONCLUSIVE`
- Linear issue creation
- GitHub PR-merge webhook
- CI deploy + deployment-ready event with SHA guard
- `VERIFIED_FIXED / STILL_BROKEN / INCONCLUSIVE`
- `STILL_BROKEN → WAITING_FOR_FIX` re-verification loop
- Slack thread updates
- persistent state, guarded transitions
- idempotent external writes
- case page with timeline and assertion table
- eval suite (8 scenarios)

### Explicitly cut from `/MVP`

These were in the original MVP list. They are cut to protect the critical path; each has a cheaper substitute.

| Cut | Substitute |
|---|---|
| Deterministic Slack / Linear / GitHub twins | Integration tests against the `side_effects` table with a fake HTTP transport. Same evidence for idempotency, a fraction of the cost. |
| Durable job queue with `attempt_count` / `run_after` scheduling | Keep the `jobs` table for restart-safety and state; skip the retry scheduler. Retry inline with a bounded loop. |
| Playwright trace and video | Screenshots plus the structured network, console, and action logs. |
| 5–8 seeded reliability scenarios | Three build variants plus a stopped process. That covers every eval. |
| Agentic observe→plan→act browser loop with a replan budget | Per-step resolution during reproduction, literal replay during verification. |
| Real login | Playwright storage state. |

---

## Stretch scope

Ordered by priority. Numbering is the build order — take them top to bottom.

### `/CUT1` — reliability polish
- richer retry handling
- action and replan limit tuning
- reliability scorecard on the case page

### `/CUT2` — permanent regression test
Generate a durable Playwright spec from a successful reproduction and attach or commit it for long-term CI coverage.

The highest-value stretch and the cheapest: the resolved plan and the assertions are already persisted in exactly the shape a `.spec.ts` needs. This is a template fill, roughly 30 minutes, and it turns a one-off verification into permanent coverage — a strong closing beat for the demo.

### `/CUT3` — smarter reproduction
- screenshot / vision fallback
- semantic locator recovery beyond the single-step budget
- multi-page workflows
- failure-step localization

### `/CUT4` — code context
- inspect recent GitHub changes
- identify the likely regression PR
- identify likely owner / CODEOWNERS
- attach probable code context to the Linear issue

### `/CUT5` — duplicate bug detection
- search existing Linear and GitHub issues
- reuse an existing issue when a reproduced failure is likely the same bug

### `/CUT6` — support platform integration
Add exactly one of Intercom or Zendesk. Never both.

Ranked below code context because a second intake channel demonstrates the same capability the Slack path already demonstrates.

### `/CUT7` — broader environment support
- arbitrary staging sites
- multiple projects
- configurable fixtures
- multiple teams and environments

### `/CUT8` — post-hackathon ambitions
- automatic code fixes and PR generation
- root-cause analysis
- multi-agent investigation
- production reproduction
- mobile and cross-browser testing
- generalized QA platform

---

## Non-goals

The MVP will not:
- fix code,
- auto-close engineering tickets,
- browse production customer accounts,
- require customer credentials,
- support arbitrary websites,
- support mobile,
- support Safari or Firefox,
- act as a general QA agent,
- provide team administration,
- build a large analytics dashboard.

---

## Success criteria

### Required

- golden-path case works end to end,
- a superficial fix is classified `STILL_BROKEN`, never `VERIFIED_FIXED`,
- a real fix is classified `VERIFIED_FIXED`,
- duplicate events do not create duplicate side effects.

### Targets

Every target names its trial count. A percentage without a denominator is unfalsifiable, and in a hackathon the denominator is small — say so.

| Metric | Target | Trials |
|---|---:|---|
| Golden-path E2E success | 3/3 | 3 full runs, clean database each time |
| False `VERIFIED_FIXED` | 0 | across all runs of every eval |
| Duplicate Linear issues | 0 | across all runs |
| Duplicate verification runs | 0 | across all runs |
| Seeded eval accuracy | ≥ 7/8 | one run per eval |
| Correct `INCONCLUSIVE` calls | 2/2 | Evals 4 and 5 |
| Valid ReproSpec generation | ≥ 9/10 | 10 labeled reports in `evals/reports.json` |

**If one eval must fail, it is Eval 4** (ambiguous report). It depends on a model judgment call rather than on deterministic machinery, so it is the only acceptable loss. Eval 3 (superficial fix → `STILL_BROKEN`) may never fail — it is the entire product thesis.

### Definition of MVP failure

The MVP is not complete if:
- the demo bug is hard-coded into a one-off browser script,
- app-specific knowledge is hard-coded into the spec generator rather than supplied as AppContext,
- the LLM decides pass/fail from narrative text,
- verification uses different steps than reproduction,
- verification calls the model,
- merge and deploy do not actually trigger verification,
- external app updates are fake,
- duplicate events create repeated side effects,
- manual database edits are required during the demo.
