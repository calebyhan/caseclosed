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
const commitSha = git("rev-parse HEAD") ?? "unknown";
const dirty = (git("status --porcelain -- .") ?? "") !== "";

const nextConfig: NextConfig = {
  env: {
    ACME_COMMIT_SHA: commitSha,
    ACME_BUILD_DIRTY: dirty ? "true" : "false",
    ACME_BUILD_TIME: new Date().toISOString(),
  },
};

export default nextConfig;
