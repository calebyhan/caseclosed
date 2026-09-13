import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ReproductionRunResult, VerificationRunResult } from "../../contracts/run";
import type { ReproductionRunOutput, VerificationRunOutput } from "../browser/runner";

// Writes per-run artifacts under ARTIFACT_DIR/<run_id>/. Each file is written
// to a temporary name and renamed, so a finalized evidence row never points at
// a partial file. Only relative paths are returned for persistence.

export type EvidenceArtifact = {
  kind: string;
  fileName: string;
  mimeType: string;
  content: Buffer | string;
  meta?: Record<string, unknown>;
};

export type WrittenEvidence = {
  id: string;
  kind: string;
  relativePath: string;
  mimeType: string;
  sha256: string;
  meta: Record<string, unknown>;
};

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function writeRunEvidence(artifactDir: string, runId: string, artifacts: EvidenceArtifact[]): Promise<WrittenEvidence[]> {
  if (!SAFE_SEGMENT.test(runId)) throw new Error(`Unsafe run id for evidence path: ${JSON.stringify(runId)}`);
  const runDir = path.join(artifactDir, runId);
  await fs.mkdir(runDir, { recursive: true });

  const written: WrittenEvidence[] = [];
  for (const artifact of artifacts) {
    if (!SAFE_SEGMENT.test(artifact.fileName)) throw new Error(`Unsafe evidence file name: ${JSON.stringify(artifact.fileName)}`);
    const bytes = typeof artifact.content === "string" ? Buffer.from(artifact.content, "utf8") : artifact.content;
    const finalPath = path.join(runDir, artifact.fileName);
    const tempPath = `${finalPath}.tmp-${randomUUID()}`;
    await fs.writeFile(tempPath, bytes);
    await fs.rename(tempPath, finalPath);
    written.push({
      id: randomUUID(),
      kind: artifact.kind,
      relativePath: `${runId}/${artifact.fileName}`,
      mimeType: artifact.mimeType,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      meta: { bytes: bytes.length, ...artifact.meta },
    });
  }
  return written;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The standard reproduction evidence bundle. Missing screenshots are recorded as absent, never fabricated. */
export function reproductionArtifacts(
  output: ReproductionRunOutput | VerificationRunOutput,
  result: ReproductionRunResult | VerificationRunResult,
): EvidenceArtifact[] {
  const { observations, screenshots } = output;
  const artifacts: EvidenceArtifact[] = [
    { kind: "network", fileName: "network.json", mimeType: "application/json", content: json({ responses: observations.network, request_failures: observations.request_failures }) },
    { kind: "console", fileName: "console.json", mimeType: "application/json", content: json(observations.console) },
    { kind: "actions", fileName: "actions.json", mimeType: "application/json", content: json(observations.actions) },
    { kind: "assertions", fileName: "assertions.json", mimeType: "application/json", content: json({ assertions: result.assertions, signals: result.signals }) },
    { kind: "observations", fileName: "observations.json", mimeType: "application/json", content: json(observations) },
    { kind: "result", fileName: "result.json", mimeType: "application/json", content: json(resultSummary(result)) },
  ];
  if (screenshots.before) {
    artifacts.push({ kind: "screenshot", fileName: "before.png", mimeType: "image/png", content: screenshots.before, meta: { moment: "after start navigation, before the first step" } });
  }
  if (screenshots.after) {
    artifacts.push({ kind: "screenshot", fileName: "after.png", mimeType: "image/png", content: screenshots.after, meta: { moment: "end of the observation window" } });
    const failureObserved = result.assertions.some((a) => !a.passed) || result.signals.some((s) => s.passed);
    if (failureObserved && !result.infra_error) {
      artifacts.push({
        kind: "screenshot",
        fileName: "failure.png",
        mimeType: "image/png",
        content: screenshots.after,
        meta: { moment: "end of the observation window", source: "after.png", reason: "failed assertion or matched failure signal" },
      });
    }
  }
  return artifacts;
}

export function resultSummary(result: ReproductionRunResult | VerificationRunResult) {
  return {
    result: result.result,
    assertions_passed: result.assertions_passed,
    assertions_total: result.assertions_total,
    signals_matched: result.signals_matched,
    infra_error: result.infra_error,
    ...(result.infra_error_reason ? { infra_error_reason: result.infra_error_reason } : {}),
    ...(result.infra_error_detail ? { infra_error_detail: result.infra_error_detail } : {}),
    plan_recovered: result.plan_recovered,
    model_calls: result.model_calls,
  };
}
