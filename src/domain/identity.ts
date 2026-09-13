import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted recursively, array order preserved.
 * Used for every persisted hash so equal content always hashes equally.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) sorted[key] = sortKeys(source[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

const CASE_ID_PATTERN = /^CC-(\d{4,})$/;

export function formatCaseId(caseNumber: number): string {
  if (!Number.isSafeInteger(caseNumber) || caseNumber < 1) {
    throw new Error(`Invalid case number: ${caseNumber}`);
  }
  return `CC-${String(caseNumber).padStart(4, "0")}`;
}

export function isCaseId(value: string): boolean {
  return CASE_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Stable operation keys. Side-effect keys are keyed on event identity (case,
// run, attempt, trigger) — never on current case status.
// ---------------------------------------------------------------------------

/**
 * `<provider>:<operation>:<identity...>`, e.g. `linear:create:CC-0042` or
 * `github:verify:CC-0042:pr-84`. Identity segments may contain `:`.
 */
const EFFECT_KEY_PATTERN = /^[a-z][a-z0-9]*:[a-z][a-z0-9-]*:[A-Za-z0-9._\-:]+$/;

export function isValidEffectKey(key: string): boolean {
  return key.length <= 300 && EFFECT_KEY_PATTERN.test(key);
}

export function assertValidEffectKey(key: string): void {
  if (!isValidEffectKey(key)) {
    throw new Error(`Invalid side-effect idempotency key: ${JSON.stringify(key)}`);
  }
}

export const effectKeys = {
  slackCaseCreated: (triggerId: string) => `slack:case-created:${triggerId}`,
  slackSpecFailed: (caseId: string) => `slack:spec-failed:${caseId}`,
  slackReproResult: (runId: string) => `slack:repro-result:${runId}`,
  slackLinearLink: (caseId: string) => `slack:linear-link:${caseId}`,
  slackFixMerged: (attemptId: string) => `slack:fix-merged:${attemptId}`,
  slackVerifyResult: (runId: string) => `slack:verify-result:${runId}`,
  linearCreate: (caseId: string) => `linear:create:${caseId}`,
  linearVerifyComment: (runId: string) => `linear:verify-comment:${runId}`,
  linearLabels: (runId: string) => `linear:labels:${runId}`,
  githubVerifyComment: (runId: string) => `github:verify-comment:${runId}`,
} as const;

export const jobKeys = {
  spec: (caseId: string) => `spec:${caseId}`,
  reproduce: (caseId: string) => `reproduce:${caseId}`,
  verifyInitial: (caseId: string, sha: string) => `verify:${caseId}:${sha}:initial`,
  verifyRetry: (caseId: string, sha: string, predecessorRunId: string) =>
    `verify:${caseId}:${sha}:retry:${predecessorRunId}`,
  effect: (effectKey: string) => `effect:${effectKey}`,
} as const;
