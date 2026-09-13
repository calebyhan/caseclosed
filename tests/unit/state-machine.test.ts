import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TERMINAL_STATUSES, type CaseStatus } from "../../src/contracts/lifecycle";
import {
  decideTransition,
  isTransitionAllowed,
  TRANSITIONS,
  type CaseEvent,
  type CaseSnapshot,
} from "../../src/domain/state-machine";

const ID = "CC-0001";
const K = { case_id: ID, event_key: "evt-1" };

function snap(status: CaseStatus, overrides: Partial<CaseSnapshot> = {}): CaseSnapshot {
  return {
    id: ID,
    status,
    specId: null,
    plan: null,
    linearIssueId: null,
    currentAttempt: null,
    activeRun: null,
    latestVerification: null,
    ...overrides,
  };
}

const spec = { specId: "spec-1" };
const reproRun = { activeRun: { id: "run-1", runType: "reproduction" as const, attemptId: null } };
const plan = { plan: { id: "plan-1", sourceRunId: "run-1" } };
const attempt = { currentAttempt: { id: "att-1", commitSha: "sha-a" } };
const verifyRun = { activeRun: { id: "run-2", runType: "verification" as const, attemptId: "att-1" } };

type Row = { state: CaseSnapshot; event: CaseEvent; to: CaseStatus };

const VALID: Row[] = [
  { state: snap("RECEIVED", spec), event: { ...K, type: "spec_created", spec_id: "spec-1" }, to: "SPEC_CREATED" },
  { state: snap("RECEIVED"), event: { ...K, type: "spec_failed", kind: "insufficient" }, to: "SPEC_FAILED" },
  { state: snap("SPEC_CREATED", { ...spec, ...reproRun }), event: { ...K, type: "reproduction_claimed", run_id: "run-1" }, to: "REPRODUCING" },
  {
    state: snap("REPRODUCING", { ...spec, ...reproRun, ...plan }),
    event: { ...K, type: "reproduction_completed", run_id: "run-1", result: "REPRODUCED" },
    to: "REPRODUCED",
  },
  {
    state: snap("REPRODUCING", { ...spec, ...reproRun }),
    event: { ...K, type: "reproduction_completed", run_id: "run-1", result: "NOT_REPRODUCED" },
    to: "NOT_REPRODUCED",
  },
  {
    state: snap("REPRODUCING", { ...spec, ...reproRun }),
    event: { ...K, type: "reproduction_completed", run_id: "run-1", result: "INCONCLUSIVE" },
    to: "REPRO_INCONCLUSIVE",
  },
  {
    state: snap("REPRODUCED", { linearIssueId: "lin-1" }),
    event: { ...K, type: "issue_confirmed", linear_issue_id: "lin-1" },
    to: "ISSUE_FILED",
  },
  { state: snap("ISSUE_FILED"), event: { ...K, type: "await_fix" }, to: "WAITING_FOR_FIX" },
  {
    state: snap("WAITING_FOR_FIX", attempt),
    event: { ...K, type: "fix_merged", attempt_id: "att-1", commit_sha: "sha-a" },
    to: "FIX_MERGED",
  },
  { state: snap("FIX_MERGED", attempt), event: { ...K, type: "await_deployment", attempt_id: "att-1" }, to: "WAITING_FOR_DEPLOYMENT" },
  {
    state: snap("WAITING_FOR_DEPLOYMENT", { ...attempt, ...plan }),
    event: { ...K, type: "deployment_ready", attempt_id: "att-1", commit_sha: "sha-a" },
    to: "VERIFYING",
  },
  ...(["VERIFIED_FIXED", "STILL_BROKEN", "INCONCLUSIVE"] as const).map(
    (result): Row => ({
      state: snap("VERIFYING", { ...attempt, ...verifyRun }),
      event: { ...K, type: "verification_completed", run_id: "run-2", attempt_id: "att-1", result },
      to: result === "INCONCLUSIVE" ? "VERIFICATION_INCONCLUSIVE" : result,
    }),
  ),
  { state: snap("STILL_BROKEN"), event: { ...K, type: "await_fix" }, to: "WAITING_FOR_FIX" },
  {
    state: snap("VERIFICATION_INCONCLUSIVE", { latestVerification: { id: "run-2", result: "INCONCLUSIVE", attemptId: "att-1" } }),
    event: { ...K, type: "verification_retry", retry_of_run_id: "run-2" },
    to: "WAITING_FOR_DEPLOYMENT",
  },
];

describe("valid transitions", () => {
  for (const row of VALID) {
    it(`${row.state.status} → ${row.to} via ${row.event.type}`, () => {
      const decision = decideTransition(row.state, row.event);
      assert.deepEqual(decision.accepted ? decision.next : decision.reason, row.to);
    });
  }

  it("covers every edge in the transition table exactly", () => {
    const tested = new Set(VALID.map((row) => `${row.state.status}->${row.to}`));
    const table = new Set(TRANSITIONS.map((rule) => `${rule.from}->${rule.to}`));
    assert.deepEqual([...tested].sort(), [...table].sort());
    assert.equal(TRANSITIONS.length, 16);
  });
});

describe("invalid transitions (docs/STATE_MACHINE.md examples)", () => {
  const cases: Array<{ name: string; state: CaseSnapshot; event: CaseEvent; from: CaseStatus; to: CaseStatus }> = [
    {
      name: "RECEIVED → VERIFIED_FIXED",
      state: snap("RECEIVED", { ...attempt, ...verifyRun }),
      event: { ...K, type: "verification_completed", run_id: "run-2", attempt_id: "att-1", result: "VERIFIED_FIXED" },
      from: "RECEIVED",
      to: "VERIFIED_FIXED",
    },
    {
      name: "NOT_REPRODUCED → ISSUE_FILED",
      state: snap("NOT_REPRODUCED", { linearIssueId: "lin-1" }),
      event: { ...K, type: "issue_confirmed", linear_issue_id: "lin-1" },
      from: "NOT_REPRODUCED",
      to: "ISSUE_FILED",
    },
    {
      name: "SPEC_FAILED → REPRODUCING",
      state: snap("SPEC_FAILED", { ...spec, ...reproRun }),
      event: { ...K, type: "reproduction_claimed", run_id: "run-1" },
      from: "SPEC_FAILED",
      to: "REPRODUCING",
    },
    {
      name: "WAITING_FOR_FIX → VERIFYING without a deployment",
      state: snap("WAITING_FOR_FIX", { ...attempt, ...plan }),
      event: { ...K, type: "deployment_ready", attempt_id: "att-1", commit_sha: "sha-a" },
      from: "WAITING_FOR_FIX",
      to: "VERIFYING",
    },
    {
      name: "VERIFIED_FIXED → REPRODUCING",
      state: snap("VERIFIED_FIXED", { ...spec, ...reproRun }),
      event: { ...K, type: "reproduction_claimed", run_id: "run-1" },
      from: "VERIFIED_FIXED",
      to: "REPRODUCING",
    },
  ];

  for (const example of cases) {
    it(`rejects ${example.name}`, () => {
      assert.equal(isTransitionAllowed(example.from, example.to), false);
      const decision = decideTransition(example.state, example.event);
      assert.equal(decision.accepted, false);
      assert.match(decision.accepted ? "" : decision.reason, /^invalid_transition: /);
    });
  }

  it("rejects every event from every terminal status", () => {
    const everyEvent = VALID.map((row) => row.event);
    for (const status of TERMINAL_STATUSES) {
      for (const event of everyEvent) {
        const state = snap(status, { ...spec, ...plan, ...attempt, linearIssueId: "lin-1" });
        assert.equal(decideTransition(state, event).accepted, false, `${status} accepted ${event.type}`);
      }
    }
  });

  it("binds each edge to its event type", () => {
    // await_fix targets WAITING_FOR_FIX, which is only reachable from ISSUE_FILED or STILL_BROKEN.
    assert.equal(decideTransition(snap("WAITING_FOR_DEPLOYMENT"), { ...K, type: "await_fix" }).accepted, false);
    assert.equal(decideTransition(snap("VERIFYING"), { ...K, type: "await_fix" }).accepted, false);
  });
});

describe("semantic guards", () => {
  function reason(state: CaseSnapshot, event: CaseEvent): string | null {
    const decision = decideTransition(state, event);
    return decision.accepted ? null : decision.reason;
  }

  it("requires the spec to be persisted before SPEC_CREATED", () => {
    assert.equal(reason(snap("RECEIVED"), { ...K, type: "spec_created", spec_id: "spec-1" }), "spec_not_persisted_for_case");
  });

  it("requires plan promotion from the same run before REPRODUCED", () => {
    const state = snap("REPRODUCING", { ...spec, ...reproRun });
    const event: CaseEvent = { ...K, type: "reproduction_completed", run_id: "run-1", result: "REPRODUCED" };
    assert.equal(reason(state, event), "resolved_plan_not_promoted_from_run");
    assert.equal(reason({ ...state, plan: { id: "plan-1", sourceRunId: "other" } }, event), "resolved_plan_not_promoted_from_run");
  });

  it("refuses results from a stale or unknown run", () => {
    const state = snap("REPRODUCING", { ...spec, ...reproRun });
    assert.equal(
      reason(state, { ...K, type: "reproduction_completed", run_id: "old-run", result: "NOT_REPRODUCED" }),
      "stale_or_unknown_reproduction_run",
    );
  });

  it("requires a persisted Linear issue before ISSUE_FILED", () => {
    assert.equal(reason(snap("REPRODUCED"), { ...K, type: "issue_confirmed", linear_issue_id: "lin-1" }), "linear_issue_not_persisted");
  });

  it("rejects a merge or deployment for the wrong SHA or a non-current attempt", () => {
    assert.equal(
      reason(snap("WAITING_FOR_FIX", attempt), { ...K, type: "fix_merged", attempt_id: "att-1", commit_sha: "sha-b" }),
      "commit_sha_mismatch",
    );
    assert.equal(
      reason(snap("WAITING_FOR_DEPLOYMENT", { ...attempt, ...plan }), {
        ...K,
        type: "deployment_ready",
        attempt_id: "att-0",
        commit_sha: "sha-a",
      }),
      "fix_attempt_not_current",
    );
    assert.equal(
      reason(snap("WAITING_FOR_DEPLOYMENT", attempt), { ...K, type: "deployment_ready", attempt_id: "att-1", commit_sha: "sha-a" }),
      "no_resolved_plan",
    );
  });

  it("prevents a stale worker result from finalizing a newer attempt", () => {
    const state = snap("VERIFYING", { currentAttempt: { id: "att-2", commitSha: "sha-b" }, ...verifyRun });
    assert.equal(
      reason(state, { ...K, type: "verification_completed", run_id: "run-2", attempt_id: "att-1", result: "VERIFIED_FIXED" }),
      "verification_run_for_stale_attempt",
    );
  });

  it("allows a verification retry only for the latest inconclusive run", () => {
    const retry: CaseEvent = { ...K, type: "verification_retry", retry_of_run_id: "run-1" };
    assert.equal(
      reason(snap("VERIFICATION_INCONCLUSIVE", { latestVerification: { id: "run-2", result: "INCONCLUSIVE", attemptId: "att-1" } }), retry),
      "retry_predecessor_not_latest_inconclusive_run",
    );
  });

  it("rejects events addressed to a different case", () => {
    assert.equal(reason(snap("RECEIVED"), { ...K, case_id: "CC-0002", type: "spec_failed", kind: "insufficient" }), "event_case_mismatch");
  });
});
