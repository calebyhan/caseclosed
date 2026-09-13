import { getDatabase } from "../../../../server/composition";
import { loadConfig } from "../../../../server/config";
import { GitHubAdapter } from "../../../../server/integrations/github";
import { verifyGitHubSignature } from "../../../../server/integrations/signatures";
import { acceptMergedPullRequest } from "../../../../server/services/fix-lifecycle";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const config = loadConfig();
  if (!config.github) return Response.json({ error: "GitHub integration is not configured" }, { status: 503 });
  const raw = await request.text();
  if (!verifyGitHubSignature(raw, request.headers.get("x-hub-signature-256"), config.github.webhookSecret)) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }
  if (request.headers.get("x-github-event") !== "pull_request") return Response.json({ ignored: true }, { status: 202 });
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;
  if (payload.action !== "closed" || pr?.merged !== true) return Response.json({ ignored: true }, { status: 202 });
  const repo = String(repository?.full_name ?? "");
  const number = Number((payload.number ?? pr.number));
  const sha = String(pr.merge_commit_sha ?? "");
  const adapter = new GitHubAdapter({ token: config.github.token, baseUrl: config.github.baseUrl, publicBaseUrl: config.publicBaseUrl });
  const outcome = await acceptMergedPullRequest(
    getDatabase(),
    { repository: repo, pr: number, commitSha: sha, deliveryId: request.headers.get("x-github-delivery") ?? "" },
    () => adapter.getPullRequest(repo, number),
    { expectedRepository: config.github.repository, defaultBranch: config.github.defaultBranch },
  );
  return outcome.ok
    ? Response.json({ accepted: true, duplicate: outcome.duplicate, case_id: outcome.caseId, attempt_id: outcome.attemptId })
    : Response.json({ error: outcome.reason }, { status: 409 });
}
