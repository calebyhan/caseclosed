import { z } from "zod";
import { SPEC_GENERATION_CALL_BUDGET } from "../../contracts/lifecycle";
import type { AppContext, ReproSpec } from "../../contracts/repro";
import { redactSecrets } from "../../domain/secrets";
import { formatValidationErrors, validateReproSpec, type ValidationError } from "../../domain/validate-repro-spec";
import { REPRODUCTION_BUDGETS } from "../../contracts/run";
import { ModelBudget, ModelCallError, type ModelClient, type ModelSelection, type ModelTurn } from "./client";
import { ASSERTION_FIELDS, SIGNAL_FIELDS, SPEC_GENERATION_SCHEMA } from "./generation-schema";
import { SPEC_GENERATION_SYSTEM, specGenerationUserPrompt, specValidationFeedback } from "./prompts";

// Report → ReproSpec. The model interprets; the application supplies identity
// and validateReproSpec decides validity. Invalid output is returned to the
// model with its validation errors, within a total budget of three calls.

export type SpecGenerationInput = {
  caseId: string;
  report: string;
  appContext: AppContext;
  appContextHash: string;
  /** Calls already spent by this generation job (restart resumes the remaining budget). */
  callsAlreadyUsed: number;
  /** Persists the call count before each dispatch. */
  onBeforeCall: (callsIncludingThis: number) => void | Promise<void>;
  knownSecrets: readonly (string | null | undefined)[];
  signal?: AbortSignal;
};

export type SpecGenerationOutcome =
  | { kind: "sufficient"; spec: ReproSpec; modelCalls: number; modelId: string }
  | { kind: "insufficient"; missing: string[]; modelCalls: number; modelId: string }
  /** Responses were received but none validated within the budget. */
  | { kind: "invalid"; errors: ValidationError[]; modelCalls: number }
  /** No usable response: provider failures only. Never converted into insufficiency. */
  | { kind: "unavailable"; error: string; modelCalls: number };

const FlatCheck = z.looseObject({ id: z.string(), type: z.string() });
const FlatSpec = z.strictObject({
  start_path: z.string(),
  fixture: z.string(),
  goal: z.string(),
  steps: z.array(z.strictObject({ id: z.string(), intent: z.string() })),
  assertions: z.array(FlatCheck),
  failure_signals: z.array(FlatCheck),
});
const GenerationOutput = z.strictObject({
  sufficient: z.boolean(),
  missing: z.array(z.string()),
  spec: FlatSpec.nullish(),
});

export class SpecGenerator {
  constructor(
    private readonly client: ModelClient,
    private readonly models: ModelSelection,
  ) {}

  async generate(input: SpecGenerationInput): Promise<SpecGenerationOutcome> {
    const budget = new ModelBudget(SPEC_GENERATION_CALL_BUDGET, input.callsAlreadyUsed, input.onBeforeCall, REPRODUCTION_BUDGETS.modelCallTimeoutMs);
    const report = redactSecrets(input.report, input.knownSecrets);
    const promptContext = redactSecrets(JSON.stringify(input.appContext, null, 2), input.knownSecrets);
    const turns: ModelTurn[] = [{ role: "user", parts: [{ text: specGenerationUserPrompt(report, promptContext) }] }];

    let model = this.models.primary;
    let lastErrors: ValidationError[] | null = null;
    let lastProviderError = "model call budget exhausted before any response";

    while (budget.remaining > 0) {
      let text: string;
      let modelId: string;
      try {
        ({ text, modelId } = await budget.call(
          this.client,
          { model, system: SPEC_GENERATION_SYSTEM, turns, responseJsonSchema: SPEC_GENERATION_SCHEMA },
          input.signal,
        ));
      } catch (error) {
        if (!(error instanceof ModelCallError) || error.kind === "aborted") throw error;
        lastProviderError = error.message;
        // A provider failure moves remaining attempts to the configured fallback.
        if (this.models.fallback) model = this.models.fallback;
        continue;
      }

      const interpreted = interpret(text, input);
      if (interpreted.kind === "sufficient" || interpreted.kind === "insufficient") {
        return { ...interpreted, modelCalls: budget.calls, modelId };
      }
      lastErrors = interpreted.errors;
      turns.push(
        { role: "model", parts: [{ text: text.slice(0, 20_000) }] },
        { role: "user", parts: [{ text: specValidationFeedback(formatValidationErrors(interpreted.errors)) }] },
      );
    }

    return lastErrors
      ? { kind: "invalid", errors: lastErrors, modelCalls: budget.calls }
      : { kind: "unavailable", error: lastProviderError, modelCalls: budget.calls };
  }
}

type Interpreted =
  | { kind: "sufficient"; spec: ReproSpec }
  | { kind: "insufficient"; missing: string[] }
  | { kind: "invalid"; errors: ValidationError[] };

function interpret(text: string, input: SpecGenerationInput): Interpreted {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "invalid", errors: [{ path: "", message: "response was not valid JSON" }] };
  }
  const parsed = GenerationOutput.safeParse(json);
  if (!parsed.success) {
    return { kind: "invalid", errors: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) };
  }
  const output = parsed.data;

  if (!output.sufficient) {
    const missing = output.missing.map((item) => item.trim()).filter(Boolean);
    const errors: ValidationError[] = [];
    if (missing.length === 0) errors.push({ path: "missing", message: "must list what is missing when sufficient is false" });
    if (output.spec) errors.push({ path: "spec", message: "must be omitted when sufficient is false" });
    return errors.length ? { kind: "invalid", errors } : { kind: "insufficient", missing };
  }

  if (!output.spec) return { kind: "invalid", errors: [{ path: "spec", message: "is required when sufficient is true" }] };
  const errors: ValidationError[] = [];
  if (output.missing.length > 0) errors.push({ path: "missing", message: "must be empty when sufficient is true" });

  const candidate = {
    version: "1",
    case_id: input.caseId,
    app_context_hash: input.appContextHash,
    environment: { id: input.appContext.environment_id, start_path: output.spec.start_path, fixture: output.spec.fixture },
    goal: output.spec.goal,
    steps: output.spec.steps,
    assertions: output.spec.assertions.map((check, index) => strictCheck(check, ASSERTION_FIELDS, `spec.assertions.${index}`, errors)),
    failure_signals: output.spec.failure_signals.map((check, index) => strictCheck(check, SIGNAL_FIELDS, `spec.failure_signals.${index}`, errors)),
    evidence: { screenshots: true, network: true, console: true, actions: true },
  };
  const validation = validateReproSpec(candidate, input.appContext, {
    caseId: input.caseId,
    appContextHash: input.appContextHash,
    knownSecrets: input.knownSecrets,
  });
  if (!validation.ok) errors.push(...validation.errors.map((error) => ({ ...error, path: toGenerationPath(error.path) })));
  return errors.length > 0 || !validation.ok ? { kind: "invalid", errors } : { kind: "sufficient", spec: validation.spec };
}

/** Keeps only the fields that belong to the check's type; reports stray non-null fields. */
function strictCheck(
  check: z.infer<typeof FlatCheck>,
  fieldsByType: Record<string, readonly string[]>,
  path: string,
  errors: ValidationError[],
): Record<string, unknown> {
  const allowed = fieldsByType[check.type];
  if (!allowed) return { id: check.id, type: check.type };
  const result: Record<string, unknown> = { id: check.id, type: check.type };
  for (const [key, value] of Object.entries(check)) {
    if (key === "id" || key === "type" || value === null || value === undefined) continue;
    if (allowed.includes(key)) result[key] = value;
    else errors.push({ path: `${path}.${key}`, message: `not allowed for type ${check.type}` });
  }
  return result;
}

function toGenerationPath(specPath: string): string {
  if (specPath === "environment.start_path") return "spec.start_path";
  if (specPath === "environment.fixture") return "spec.fixture";
  return specPath ? `spec.${specPath}` : "spec";
}
