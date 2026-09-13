import { execSync } from "node:child_process";
import type { NextConfig } from "next";

function git(command: string): string | null {
  try {
    return execSync(`git ${command}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// Build provenance is captured when this exact revision is built, never taken
// from a deploy request, so /api/health reports what is actually running.
// Evals boot isolated staging revisions without manufacturing git commits.
// The override is deliberately unavailable to production so health provenance
// cannot be detached from the checked-out code by a leaked environment value.
const evalMode = process.env.CASECLOSED_EVAL_MODE === "1";
if (evalMode && process.env.NODE_ENV === "production") {
  throw new Error("CASECLOSED_EVAL_MODE is forbidden in production builds");
}
const commitSha = (evalMode ? process.env.ACME_EVAL_COMMIT_SHA : undefined) ?? git("rev-parse HEAD") ?? "unknown";
const dirty = (git("status --porcelain -- .") ?? "") !== "";

const nextConfig: NextConfig = {
  env: {
    ACME_COMMIT_SHA: commitSha,
    ACME_BUILD_DIRTY: dirty ? "true" : "false",
    ACME_BUILD_TIME: new Date().toISOString(),
  },
};

export default nextConfig;
