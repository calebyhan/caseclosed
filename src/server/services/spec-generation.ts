import { eq } from "drizzle-orm";
import type { AppContext } from "../../contracts/repro";
import { sha256Hash } from "../../domain/identity";
import { formatValidationErrors } from "../../domain/validate-repro-spec";
import type { Db } from "../db/client";
import { cases, reproSpecs } from "../db/schema";
import type { ClaimedJob } from "../jobs/queue";
import { SPEC_GENERATION_SCHEMA } from "../model/generation-schema";
import type { SpecGenerationInput, SpecGenerationOutcome } from "../model/generate-spec";
import { recordJobModelCalls } from "./runs";
import { recordSpecCreated, recordSpecFailed } from "./spec-lifecycle";

// generate_spec job: report + AppContext → validated ReproSpec (SPEC_CREATED)
// or SPEC_FAILED with reasons. Provider outages are a visible failed job, never
// an invented insufficiency.

export type SpecGenerationDeps = {
  db: Db;
  generator: { generate(input: SpecGenerationInput): Promise<SpecGenerationOutcome> };
  appContext: AppContext;
  knownSecrets: readonly (string | null | undefined)[];
};

export class SpecGenerationUnavailableError extends Error {
  constructor(detail: string) {
    super(`Spec generation unavailable: ${detail}`);
    this.name = "SpecGenerationUnavailableError";
  }
}

export type SpecGenerationJobResult =
  | { kind: "spec_created"; specId: string; modelCalls: number }
  | { kind: "spec_failed"; failure: "insufficient" | "validation_failed"; reasons: string[]; modelCalls: number }
  | { kind: "already_recorded"; specId: string };

export async function handleGenerateSpecJob(job: ClaimedJob, deps: SpecGenerationDeps, signal?: AbortSignal): Promise<SpecGenerationJobResult> {
  if (job.type !== "generate_spec" || !job.caseId) throw new Error(`Job ${job.id} is not a spec generation job`);
  const caseId = job.caseId;
  const caseRow = deps.db.select({ report: cases.report, environmentId: cases.environmentId }).from(cases).where(eq(cases.id, caseId)).get();
  if (!caseRow) throw new Error(`Case ${caseId} does not exist`);
  if (caseRow.environmentId !== deps.appContext.environment_id) {
    throw new Error(`Case ${caseId} targets environment ${caseRow.environmentId}, but ${deps.appContext.environment_id} is configured`);
  }
  const existing = deps.db.select({ id: reproSpecs.id }).from(reproSpecs).where(eq(reproSpecs.caseId, caseId)).get();
  if (existing) return { kind: "already_recorded", specId: existing.id };

  const outcome = await deps.generator.generate({
    caseId,
    report: caseRow.report,
    appContext: deps.appContext,
    appContextHash: sha256Hash(deps.appContext),
    callsAlreadyUsed: job.modelCalls,
    onBeforeCall: (calls) => recordJobModelCalls(deps.db, job.id, calls),
    knownSecrets: deps.knownSecrets,
    ...(signal ? { signal } : {}),
  });

  switch (outcome.kind) {
    case "sufficient": {
      const recorded = recordSpecCreated(deps.db, {
        caseId,
        spec: outcome.spec,
        appContext: deps.appContext,
        modelId: outcome.modelId,
        generationModelCalls: outcome.modelCalls,
        generationSchema: SPEC_GENERATION_SCHEMA,
        knownSecrets: deps.knownSecrets,
      });
      if (!recorded.ok) throw new Error(`SPEC_CREATED rejected: ${recorded.rejection.reason}`);
      return { kind: "spec_created", specId: recorded.value.specId, modelCalls: outcome.modelCalls };
    }
    case "insufficient":
      return recordFailure(deps.db, caseId, "insufficient", outcome.missing, outcome.modelCalls);
    case "invalid":
      return recordFailure(deps.db, caseId, "validation_failed", formatValidationErrors(outcome.errors).split("\n"), outcome.modelCalls);
    case "unavailable":
      throw new SpecGenerationUnavailableError(`${outcome.error} after ${outcome.modelCalls} call(s)`);
  }
}

function recordFailure(
  db: Db,
  caseId: string,
  failure: "insufficient" | "validation_failed",
  reasons: string[],
  modelCalls: number,
): SpecGenerationJobResult {
  const recorded = recordSpecFailed(db, { caseId, kind: failure, reasons });
  if (!recorded.ok) throw new Error(`SPEC_FAILED rejected: ${recorded.rejection.reason}`);
  return { kind: "spec_failed", failure, reasons, modelCalls };
}
