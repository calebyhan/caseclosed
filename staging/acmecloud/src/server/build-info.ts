// Provenance embedded by next.config.ts when this revision was built.
export function buildInfo(): { commit_sha: string; build: string } {
  const commitSha = process.env.ACME_COMMIT_SHA ?? "unknown";
  const builtAt = process.env.ACME_BUILD_TIME ?? "unknown";
  const dirty = process.env.ACME_BUILD_DIRTY === "true";
  return { commit_sha: commitSha, build: `${builtAt}${dirty ? "+dirty" : ""}` };
}
