import type { InfraErrorReason } from "../../contracts/lifecycle";
import type { AppContext, Assertion, BrowserAction, FailureSignal, ReproSpec, ResolvedPlan } from "../../contracts/repro";
import {
  PROBE_PROTOCOL,
  REPRODUCTION_BUDGETS,
  START_STEP_ID,
  type ActionRecord,
  type ActionResolution,
  type ProbeObservation,
  type RunObservations,
} from "../../contracts/run";
import { validateProposedAction } from "../../domain/action-policy";
import { ModelCallError } from "../model/client";
import type { StepResolver } from "../model/resolve-step";
import type { StagingEnvironment } from "./environment";
import type { BrowserLauncher, BrowserSession, ProbeTarget, RunClock } from "./session";

// Semantic browser execution loop for reproduction. The model proposes one
// constrained action per step from the current accessibility snapshot; this
// code validates, executes, budgets, and records facts. It never decides a
// verdict — classification happens afterwards over the recorded observations.

export type ActionJournal = {
  started(record: ActionRecord): void | Promise<void>;
  finished(record: ActionRecord): void | Promise<void>;
};

export type ReproductionInput = {
  spec: ReproSpec;
  specHash: string;
  appContext: AppContext;
  environment: StagingEnvironment;
  launcher: BrowserLauncher;
  resolver: StepResolver;
  knownSecrets: readonly (string | null | undefined)[];
  /** Persists the run's model-call count before each dispatch. */
  onModelCall: (callsIncludingThis: number) => void | Promise<void>;
  journal?: ActionJournal;
  budgets?: Partial<{ [K in keyof typeof REPRODUCTION_BUDGETS]: number }>;
  clock?: RunClock;
  signal?: AbortSignal;
};

export type ReproductionRunOutput = {
  observations: RunObservations;
  screenshots: { before: Buffer | null; after: Buffer | null };
  /** One successful action per completed spec step, in order. */
  planActions: ResolvedPlan["actions"];
  commitSha: string | null;
};

export type VerificationInput = Omit<
  ReproductionInput,
  "resolver" | "onModelCall"
> & {
  plan: ResolvedPlan;
  planHash: string;
  expectedCommitSha: string;
};

export type VerificationRunOutput = Omit<ReproductionRunOutput, "planActions"> & {
  planActions: ResolvedPlan["actions"];
};

class RunAborted extends Error {
  constructor(
    public readonly reason: InfraErrorReason,
    public readonly detail: string,
  ) {
    super(detail);
  }
}

export function systemClock(): RunClock {
  const start = performance.now();
  return {
    now: () => Math.round(performance.now() - start),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
  };
}

type DomCheck = { id: string; kind: "assertion" | "signal"; target: ProbeTarget; deadlineMs: number };

export async function runReproduction(input: ReproductionInput): Promise<ReproductionRunOutput> {
  return runBrowserExperiment(input, null);
}

/**
 * Replays the persisted plan literally. This function deliberately has no
 * resolver/model dependency: a missing target is an inconclusive experiment,
 * never permission to generate a different action.
 */
export async function runVerification(input: VerificationInput): Promise<VerificationRunOutput> {
  return runBrowserExperiment(input, {
    plan: input.plan,
    planHash: input.planHash,
    expectedCommitSha: input.expectedCommitSha,
  });
}

async function runBrowserExperiment(
  input: ReproductionInput | VerificationInput,
  replay: { plan: ResolvedPlan; planHash: string; expectedCommitSha: string } | null,
): Promise<ReproductionRunOutput> {
  const budgets = { ...REPRODUCTION_BUDGETS, ...input.budgets };
  const clock = input.clock ?? systemClock();
  const { spec, appContext } = input;

  const observations: RunObservations = {
    run_type: replay ? "verification" : "reproduction",
    spec_hash: input.specHash,
    app_context_hash: spec.app_context_hash,
    plan_hash: replay?.planHash ?? null,
    health_before: null,
    health_after: null,
    duration_ms: 0,
    actions: [],
    steps_completed: [],
    network: [],
    request_failures: [],
    console: [],
    probe_epoch_ms: null,
    probes: [],
    network_window: null,
    final_url: null,
    infra_error: false,
    plan_recovered: false,
    model_calls: 0,
    budgets_used: { actions: 0, replans: 0 },
  };
  const output: ReproductionRunOutput = { observations, screenshots: { before: null, after: null }, planActions: [], commitSha: null };

  let session: BrowserSession | null = null;
  const runController = new AbortController();
  let deadlineHit = false;
  let rejectDeadline: (error: RunAborted) => void = () => undefined;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  deadline.catch(() => undefined);
  const timer = setTimeout(() => {
    deadlineHit = true;
    rejectDeadline(new RunAborted("duration_budget_exhausted", `run exceeded ${budgets.maxRunDurationMs}ms`));
    runController.abort();
  }, budgets.maxRunDurationMs);
  const onAbort = () => {
    rejectDeadline(new RunAborted("worker_interrupted", "run aborted by worker shutdown"));
    runController.abort();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();

  const bounded = <T>(promise: Promise<T>): Promise<T> => {
    promise.catch(() => undefined);
    return Promise.race([promise, deadline]);
  };
  const checkFatal = () => {
    const fatal = session?.fatalError();
    if (fatal) throw new RunAborted(/blocked|origin/.test(fatal) ? "navigation_blocked" : "browser_crashed", fatal);
  };

  let seq = 0;
  const recordAction = async (stepId: string, action: BrowserAction, resolution: ActionResolution, run: () => Promise<import("./session").ActionExecution>) => {
    if (observations.budgets_used.actions >= budgets.maxBrowserActions) {
      throw new RunAborted("action_budget_exhausted", `all ${budgets.maxBrowserActions} browser actions used before step ${stepId} completed`);
    }
    observations.budgets_used.actions += 1;
    const record: ActionRecord = { seq: ++seq, step_id: stepId, action, resolution, ok: false, started_at_ms: clock.now(), finished_at_ms: clock.now() };
    observations.actions.push(record);
    await input.journal?.started({ ...record });
    let execution;
    try {
      execution = await bounded(run());
    } catch (error) {
      record.finished_at_ms = clock.now();
      record.failure = "uncertain";
      record.error = error instanceof RunAborted ? error.detail : `browser error: ${(error as Error).message}`;
      await input.journal?.finished({ ...record });
      if (error instanceof RunAborted) throw error;
      throw new RunAborted("browser_crashed", record.error);
    }
    record.finished_at_ms = clock.now();
    record.ok = execution.ok;
    if (execution.ok) {
      if (execution.locatorUsed) record.locator_used = execution.locatorUsed;
    } else {
      record.failure = execution.failure;
      record.error = execution.error;
    }
    await input.journal?.finished({ ...record });
    return execution;
  };

  try {
    const health = await bounded(input.environment.checkHealth(runController.signal));
    if (!health.ok) throw new RunAborted(health.reason, health.detail);
    output.commitSha = health.commitSha;
    if (!health.commitSha) throw new RunAborted("staging_unreachable", "health check returned no commit SHA");
    if (replay && health.commitSha !== replay.expectedCommitSha) {
      throw new RunAborted(
        "deployment_changed",
        `staging reports ${health.commitSha}, expected deployed merge ${replay.expectedCommitSha}`,
      );
    }
    observations.health_before = { commit_sha: health.commitSha };

    const reset = await bounded(input.environment.resetFixture(spec.environment.fixture, runController.signal));
    if (!reset.ok) throw new RunAborted(reset.reason, reset.detail);

    const auth = await bounded(input.environment.createSession(spec.environment.fixture, runController.signal));
    if (!auth.ok) throw new RunAborted(auth.reason, auth.detail);

    try {
      session = await bounded(
        input.launcher.open({
          baseUrl: appContext.base_url,
          cookies: auth.cookies,
          clock,
          knownSecrets: input.knownSecrets,
          actionTimeoutMs: budgets.actionTimeoutMs,
        }),
      );
    } catch (error) {
      if (error instanceof RunAborted) throw error;
      throw new RunAborted("browser_crashed", `browser failed to start: ${(error as Error).message}`);
    }
    const browser = session;

    const start = await recordAction(START_STEP_ID, { type: "goto", path: spec.environment.start_path }, "runner", () => browser.goto(spec.environment.start_path));
    checkFatal();
    if (!start.ok) throw new RunAborted(start.navigationBlocked ? "navigation_blocked" : "staging_unreachable", `start navigation failed: ${start.error}`);
    output.screenshots.before = await bounded(browser.screenshot()).catch(rethrowAbort);
    let experimentStarted = false;

    for (const [stepIndex, step] of spec.steps.entries()) {
      if (replay) {
        const planned = replay.plan.actions[stepIndex];
        if (!planned || planned.step_id !== step.id) {
          throw new RunAborted("environment_changed", `saved plan does not contain the original step ${step.id} at index ${stepIndex}`);
        }
        const currentPath = pathOf(browser.currentUrl());
        const policy = validateProposedAction(planned.action, appContext, input.knownSecrets, currentPath);
        if (!policy.ok) throw new RunAborted("environment_changed", `saved action for ${step.id} is invalid: ${policy.error}`);
        if (!experimentStarted) {
          browser.markExperimentStart();
          experimentStarted = true;
        }
        const action = policy.action;
        const execution = await recordAction(step.id, action, "runner", () =>
          action.type === "goto" ? browser.goto(action.path) : browser.execute(action),
        );
        checkFatal();
        if (!execution.ok) {
          throw new RunAborted(
            execution.navigationBlocked ? "navigation_blocked" : execution.failure === "not_executed" ? "step_unresolvable" : "action_failed",
            `saved action for ${step.id} failed: ${execution.error}`,
          );
        }
        output.planActions.push(planned);
        observations.steps_completed.push(step.id);
        continue;
      }

      const failures: string[] = [];
      for (;;) {
        let resolution: ActionResolution = "model";
        if (failures.length > 0) {
          if (observations.budgets_used.replans < budgets.maxReplans) {
            resolution = "replan";
            observations.budgets_used.replans += 1;
          } else {
            throw new RunAborted("step_unresolvable", `step ${step.id} could not be resolved: ${failures.join(" | ")}`);
          }
        }

        const snapshot = await bounded(browser.accessibilitySnapshot()).catch(rethrowAbort);
        checkFatal();

        observations.model_calls += 1;
        await (input as ReproductionInput).onModelCall(observations.model_calls);
        let proposal: unknown;
        try {
          proposal = await bounded(
            (input as ReproductionInput).resolver.resolve({
              goal: spec.goal,
              step,
              stepIndex,
              totalSteps: spec.steps.length,
              currentPath: pathOf(browser.currentUrl()),
              accessibilitySnapshot: snapshot,
              appContext,
              previousFailures: [...failures],
              signal: runController.signal,
            }),
          );
        } catch (error) {
          if (error instanceof RunAborted) throw error;
          if (error instanceof ModelCallError && error.kind === "aborted") throw new RunAborted("worker_interrupted", error.message);
          failures.push(`model call failed: ${(error as Error).message}`);
          continue;
        }

        const currentPath = pathOf(browser.currentUrl());
        const policy = validateProposedAction(proposal, appContext, input.knownSecrets, currentPath);
        if (!policy.ok) {
          failures.push(`proposed action rejected: ${policy.error}`);
          continue;
        }
        const action = policy.action;
        if (!experimentStarted) {
          browser.markExperimentStart();
          experimentStarted = true;
        }
        const execution = await recordAction(step.id, action, resolution, () => (action.type === "goto" ? browser.goto(action.path) : browser.execute(action)));
        checkFatal();
        if (execution.ok) {
          output.planActions.push({ step_id: step.id, action });
          observations.steps_completed.push(step.id);
          break;
        }
        if (execution.failure === "uncertain") {
          // An interaction may have had effects; repeating it could corrupt the experiment.
          throw new RunAborted(execution.navigationBlocked ? "navigation_blocked" : "action_failed", `step ${step.id}: ${execution.error}`);
        }
        failures.push(`${describeAction(action)} was not executed: ${execution.error}`);
      }
    }

    await collectProbes(browser, spec, observations, clock, bounded, () => deadlineHit);
    checkFatal();
    output.screenshots.after = await bounded(browser.screenshot()).catch(rethrowAbort);
    const healthAfter = await bounded(input.environment.checkHealth(runController.signal));
    if (!healthAfter.ok) throw new RunAborted(healthAfter.reason, `post-run ${healthAfter.detail}`);
    if (!healthAfter.commitSha) throw new RunAborted("staging_unreachable", "post-run health check returned no commit SHA");
    observations.health_after = { commit_sha: healthAfter.commitSha };
    if (healthAfter.commitSha !== output.commitSha || (replay && healthAfter.commitSha !== replay.expectedCommitSha)) {
      throw new RunAborted("deployment_changed", `staging changed from ${output.commitSha} to ${healthAfter.commitSha} during the run`);
    }
  } catch (error) {
    const aborted =
      error instanceof RunAborted ? error : new RunAborted("browser_crashed", `unexpected runner error: ${(error as Error).message}`);
    observations.infra_error = true;
    observations.infra_error_reason = aborted.reason;
    observations.infra_error_detail = aborted.detail;
    if (observations.network_window && !observations.network_window.complete) observations.network_window.complete = false;
  } finally {
    clearTimeout(timer);
    runController.abort();
    input.signal?.removeEventListener("abort", onAbort);
    if (session) {
      observations.network = session.network();
      observations.request_failures = session.requestFailures();
      observations.console = session.console();
      try {
        observations.final_url = session.currentUrl();
      } catch {
        observations.final_url = null;
      }
      await session.close().catch(() => undefined);
    }
    observations.duration_ms = clock.now();
  }
  return output;
}

function rethrowAbort(error: unknown): never {
  if (error instanceof RunAborted) throw error;
  throw new RunAborted("browser_crashed", `browser error: ${(error as Error).message}`);
}

/**
 * Samples every DOM check on a shared epoch at a 50ms cadence plus explicit
 * deadline samples, and keeps the network window open for the full collection
 * window even when DOM checks settle early.
 */
async function collectProbes(
  session: BrowserSession,
  spec: ReproSpec,
  observations: RunObservations,
  clock: RunClock,
  bounded: <T>(promise: Promise<T>) => Promise<T>,
  deadlineHit: () => boolean,
): Promise<void> {
  const checks: DomCheck[] = [
    ...spec.assertions.flatMap((check) => domCheck(check, "assertion")),
    ...spec.failure_signals.flatMap((check) => domCheck(check, "signal")),
  ];
  const windowMs = Math.max(PROBE_PROTOCOL.minCollectionWindowMs, ...checks.map((check) => check.deadlineMs));
  const epoch = clock.now();
  observations.probe_epoch_ms = epoch;
  observations.network_window = { ended_at_ms: windowMs, complete: false };
  const probes = new Map<string, ProbeObservation>();
  for (const check of checks) {
    const probe: ProbeObservation = { check_id: check.id, check_kind: check.kind, samples: [] };
    probes.set(`${check.kind}:${check.id}`, probe);
    observations.probes.push(probe);
  }

  const times = new Set<number>();
  for (let at = 0; at <= windowMs; at += PROBE_PROTOCOL.cadenceMs) times.add(at);
  for (const check of checks) times.add(check.deadlineMs);
  times.add(windowMs);

  for (const target of [...times].sort((a, b) => a - b)) {
    const wait = epoch + target - clock.now();
    if (wait > 0) await bounded(clock.sleep(wait));
    if (deadlineHit()) return;
    await bounded(
      Promise.all(
        checks.map(async (check) => {
          const probe = probes.get(`${check.kind}:${check.id}`)!;
          try {
            const reading = await session.read(check.target);
            probe.samples.push({ ...reading, at_ms: clock.now() - epoch });
          } catch (error) {
            probe.error ??= (error as Error).message.split("\n")[0]!.slice(0, 200);
          }
        }),
      ),
    );
  }
  observations.network_window.complete = clock.now() - epoch >= windowMs;
}

function domCheck(check: Assertion | FailureSignal, kind: "assertion" | "signal"): DomCheck[] {
  switch (check.type) {
    case "network_status":
      return [];
    case "element_visible":
    case "element_not_visible":
      return [{ id: check.id, kind, target: { kind: "element", role: check.role, name: check.name }, deadlineMs: check.within_ms }];
    case "element_still_visible_after_ms":
      return [{ id: check.id, kind, target: { kind: "element", role: check.role, name: check.name }, deadlineMs: check.after_ms }];
    case "text_visible":
      return [{ id: check.id, kind, target: { kind: "text", value: check.value }, deadlineMs: check.within_ms }];
    case "url_contains":
      return [{ id: check.id, kind, target: { kind: "url" }, deadlineMs: check.within_ms }];
  }
}

function describeAction(action: BrowserAction): string {
  switch (action.type) {
    case "goto":
      return `goto ${action.path}`;
    case "wait":
      return `wait ${action.milliseconds}ms`;
    case "finish":
      return "finish";
    default:
      return `${action.type} ${action.role} "${action.name}"`;
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
