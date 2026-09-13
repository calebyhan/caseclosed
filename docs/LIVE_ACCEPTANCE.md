# Live Acceptance

Last attempted: 2026-09-13 (local development workspace)

This document records only credentialed external-service results. Deterministic evals and fake transports do not qualify as a live PASS.

## Current result

The complete live golden path passed on 2026-09-13 with case `CC-0044`. The run used real Slack, Gemini, Linear, GitHub, the public HTTPS callback, and the controlled staging app. The prepared fix PR was merged and the matching deployed SHA was verified before replay.

| Path | Service | Result | Notes |
|---|---|---|---|
| Case intake | Slack | PASS | Real `/caseclosed` intake created `CC-0044`; Slack root message was committed. |
| ReproSpec generation | Gemini | PASS | `gemini-flash-lite-latest` created and persisted the CC-0044 ReproSpec in two calls. |
| Reproduction | Playwright/Staging | PASS | Buggy staging commit `05cf2297bef6dcdabda3400eb5f28fcaa21750da` reproduced the annual-upgrade failure; result `REPRODUCED`. |
| Issue creation | Linear | PASS | Real issue [ENG-6](https://linear.app/case-closed-engineering/issue/ENG-6/cc-0044-switch-from-monthly-to-annual-billing-and-complete-upgrade) was created with the reproduced label. |
| Slack reproduction update | Slack | PASS | Reproduction update was committed to the CC-0044 Slack thread. |
| Fix association | GitHub | PASS | PR [#2](https://github.com/calebyhan/caseclosed/pull/2) associated with `CC-0044` and merged. |
| Merge webhook | GitHub | PASS | Real merged-PR webhook created the CC-0044 fix attempt for `cb7f28db7c9dc05d03f89bb29b3a40ba1a8384f1`. |
| Deployment-ready | Staging/CaseClosed | PASS | Fixed staging health reported the merge SHA; authenticated deployment-ready callback returned `200 accepted`. |
| Verification replay | Playwright | PASS | Original CC-0044 ReproSpec replayed on the fixed build; result `VERIFIED_FIXED`, 1/1 assertions, zero verification model calls. |
| Verification comment | GitHub | PASS | GitHub verification comment committed to PR #2. |
| Verification update | Linear | PASS | Linear verification comment and managed verified label committed to ENG-6. |
| Final update | Slack | PASS | Final verified Slack thread reply committed. |

## Operational notes for the next run

1. Keep CaseClosed, its worker, and the public HTTPS tunnel running for the duration of the demo.
2. Start the buggy staging revision before intake; start the exact merged revision before sending deployment-ready. Confirm the reported SHA in `/api/health` each time.
3. Keep `GEMINI_FALLBACK_MODEL=gemini-flash-lite-latest` configured; the interactive resolver switches to it on a primary provider failure without adding an untracked model call.
4. Do not run `npm run demo:reset` after a live case has been created; it intentionally clears the local canonical demo state.
6. Configure the deploy job to wait for that SHA, then POST `{ "pr": 2, "commit_sha": "<merge SHA>" }` with `X-CaseClosed-Secret` to `<PUBLIC_BASE_URL>/api/caseclosed/deployment-ready`.
7. Run `npm run demo:preflight`, then `npm run demo:reset`, submit the Slack command, and merge PR #2 only after reproduction and Linear creation finish.

For each PASS, replace the blocking note with durable evidence: Case ID, Slack thread permalink, model ID, staging commit, Linear issue URL, PR URL/merge SHA, verification run ID, and final external comment/message IDs.
