import type { AppContext } from "../../contracts/repro";
import { REPRODUCTION_BUDGETS } from "../../contracts/run";
import { redactSecrets } from "../../domain/secrets";
import { callWithTimeout, ModelCallError, type ModelClient, type ModelSelection } from "./client";
import { BROWSER_ACTION_SCHEMA } from "./generation-schema";
import { STEP_RESOLUTION_SYSTEM, stepResolutionUserPrompt } from "./prompts";

// Current browser semantics → one proposed action. Exactly one model call per
// resolve(); the runner counts and persists calls and validates the proposal
// with validateProposedAction before anything executes.

export type StepResolutionRequest = {
  goal: string;
  step: { id: string; intent: string };
  stepIndex: number;
  totalSteps: number;
  currentPath: string;
  accessibilitySnapshot: string;
  appContext: AppContext;
  previousFailures: string[];
  signal?: AbortSignal;
};

export interface StepResolver {
  /** Returns the raw proposal (unvalidated). Throws ModelCallError on provider failure. */
  resolve(request: StepResolutionRequest): Promise<unknown>;
}

const MAX_SNAPSHOT_CHARS = 12_000;

export class GeminiStepResolver implements StepResolver {
  private activeModel: string;

  constructor(
    private readonly client: ModelClient,
    private readonly models: ModelSelection,
    private readonly knownSecrets: readonly (string | null | undefined)[],
  ) {
    this.activeModel = models.primary;
  }

  async resolve(request: StepResolutionRequest): Promise<unknown> {
    const route = request.currentPath.split(/[?#]/)[0];
    const text = stepResolutionUserPrompt({
      goal: redactSecrets(request.goal, this.knownSecrets),
      stepIntent: redactSecrets(request.step.intent, this.knownSecrets),
      stepIndex: request.stepIndex,
      totalSteps: request.totalSteps,
      currentPath: redactSecrets(request.currentPath, this.knownSecrets),
      routes: redactedJson(request.appContext.routes, this.knownSecrets),
      routeLandmarks: redactedJson(request.appContext.landmarks.filter((landmark) => landmark.route === route), this.knownSecrets),
      accessibilitySnapshot: redactSecrets(request.accessibilitySnapshot.slice(0, MAX_SNAPSHOT_CHARS), this.knownSecrets),
      previousFailures: request.previousFailures.map((failure) => redactSecrets(failure, this.knownSecrets)),
    });

    let response: string;
    try {
      ({ text: response } = await callWithTimeout(
        this.client,
        { model: this.activeModel, system: STEP_RESOLUTION_SYSTEM, turns: [{ role: "user", parts: [{ text }] }], responseJsonSchema: BROWSER_ACTION_SCHEMA },
        REPRODUCTION_BUDGETS.modelCallTimeoutMs,
        request.signal,
      ));
    } catch (error) {
      // The runner persists each resolution attempt before it reaches here.
      // Switch only for the next attempt so fallback use remains visible in
      // the model-call budget and never becomes an untracked retry.
      if (error instanceof ModelCallError && error.kind === "provider" && this.models.fallback && this.activeModel === this.models.primary) {
        this.activeModel = this.models.fallback;
      }
      throw error;
    }
    try {
      return dropNullFields(JSON.parse(response));
    } catch {
      throw new ModelCallError("empty_response", "step resolution response was not valid JSON");
    }
  }
}

function redactedJson<T>(value: T, knownSecrets: readonly (string | null | undefined)[]): T {
  return JSON.parse(redactSecrets(JSON.stringify(value), knownSecrets)) as T;
}

/** The flattened schema lets models emit null for unused fields; absent and null are equivalent. */
function dropNullFields(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null && field !== undefined));
}
