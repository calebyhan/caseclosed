import type { ReproSpec, ResolvedPlan } from "../../src/contracts/repro";
import type { NetworkEvent, ProbeObservation, ProbeSample, RunObservations } from "../../src/contracts/run";
import { sha256Hash } from "../../src/domain/identity";

// Builders for recorded facts, used to test the pure engine without a browser.

export const BASE = "http://localhost:3001";
export const EPOCH = 1_000;

export function series(fromMs: number, toMs: number, make: (at: number) => ProbeSample, stepMs = 50): ProbeSample[] {
  const samples: ProbeSample[] = [];
  for (let at = fromMs; at <= toMs; at += stepMs) samples.push(make(at));
  return samples;
}

export const element = (at: number, match_count: number, visible: boolean): ProbeSample => ({ at_ms: at, kind: "element", match_count, visible });

export function response(seq: number, status: number, overrides: Partial<NetworkEvent> = {}): NetworkEvent {
  return {
    seq,
    method: "POST",
    url: `${BASE}/api/subscription`,
    status,
    timestamp_ms: EPOCH + 150 + seq,
    same_origin: true,
    phase: "experiment",
    ...overrides,
  };
}

export function probe(checkId: string, kind: "assertion" | "signal", samples: ProbeSample[]): ProbeObservation {
  return { check_id: checkId, check_kind: kind, samples };
}

export function baseObservations(spec: ReproSpec, overrides: Partial<RunObservations> = {}): RunObservations {
  const actions: RunObservations["actions"] = [
    {
      seq: 1,
      step_id: "__start__",
      action: { type: "goto", path: spec.environment.start_path },
      resolution: "runner",
      ok: true,
      started_at_ms: 0,
      finished_at_ms: 1,
    },
    ...spec.steps.map((step, index) => ({
      seq: index + 2,
      step_id: step.id,
      action: index === 0
        ? ({ type: "click", role: "radio", name: "Annual" } as const)
        : ({ type: "click", role: "button", name: "Upgrade" } as const),
      resolution: "model" as const,
      ok: true,
      locator_used: "role" as const,
      started_at_ms: index + 2,
      finished_at_ms: index + 3,
    })),
  ];
  return {
    run_type: "reproduction",
    spec_hash: sha256Hash(spec),
    app_context_hash: spec.app_context_hash,
    plan_hash: null,
    health_before: { commit_sha: "fake-sha" },
    health_after: { commit_sha: "fake-sha" },
    duration_ms: 7_000,
    actions,
    steps_completed: spec.steps.map((step) => step.id),
    network: [],
    request_failures: [],
    console: [],
    probe_epoch_ms: EPOCH,
    probes: [],
    network_window: { ended_at_ms: 5_000, complete: true },
    final_url: `${BASE}/settings/billing`,
    infra_error: false,
    plan_recovered: false,
    model_calls: 2,
    budgets_used: { actions: 3, replans: 0 },
    ...overrides,
  };
}

export function asVerification(
  observations: RunObservations,
  plan: ResolvedPlan,
  commitSha: string,
): RunObservations {
  return {
    ...observations,
    run_type: "verification",
    plan_hash: sha256Hash(plan),
    health_before: { commit_sha: commitSha },
    health_after: { commit_sha: commitSha },
    model_calls: 0,
    budgets_used: { actions: plan.actions.length + 1, replans: 0 },
    actions: [
      {
        seq: 1,
        step_id: "__start__",
        action: { type: "goto", path: "/settings/billing" },
        resolution: "runner",
        ok: true,
        started_at_ms: 0,
        finished_at_ms: 1,
      },
      ...plan.actions.map((item, index) => ({
        seq: index + 2,
        step_id: item.step_id,
        action: item.action,
        resolution: "runner" as const,
        ok: true,
        locator_used: item.action.type === "click" || item.action.type === "fill" || item.action.type === "select" ? ("role" as const) : undefined,
        started_at_ms: index + 2,
        finished_at_ms: index + 3,
      })),
    ],
  };
}

/** Golden buggy build: POST 500, spinner never clears, no Checkout heading. */
export function buggyObservations(spec: ReproSpec, overrides: Partial<RunObservations> = {}): RunObservations {
  return baseObservations(spec, {
    network: [response(1, 500)],
    probes: [
      probe("a2", "assertion", series(0, 5_000, (at) => element(at, 0, false))),
      probe("f2", "signal", series(0, 5_000, (at) => element(at, 1, true))),
    ],
    ...overrides,
  });
}

/** Fixed build: POST 200, navigation to checkout, spinner gone. */
export function fixedObservations(spec: ReproSpec, overrides: Partial<RunObservations> = {}): RunObservations {
  return baseObservations(spec, {
    network: [response(1, 200), response(2, 200, { method: "GET", url: `${BASE}/checkout`, timestamp_ms: EPOCH + 300 })],
    probes: [
      probe("a2", "assertion", series(0, 5_000, (at) => element(at, at >= 400 ? 1 : 0, at >= 400))),
      probe("f2", "signal", series(0, 5_000, (at) => element(at, at < 400 ? 1 : 0, at < 400))),
    ],
    final_url: `${BASE}/checkout`,
    ...overrides,
  });
}

/** Superficial fix: spinner clears, POST still 500, no checkout. */
export function superficialObservations(spec: ReproSpec): RunObservations {
  return baseObservations(spec, {
    network: [response(1, 500)],
    probes: [
      probe("a2", "assertion", series(0, 5_000, (at) => element(at, 0, false))),
      probe("f2", "signal", series(0, 5_000, (at) => element(at, at < 300 ? 1 : 0, at < 300))),
    ],
  });
}
