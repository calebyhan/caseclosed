import type { EffectAdapter, Reconciliation, SendResult } from "../side-effects/deliver";
import type { FrozenEffect } from "../side-effects/ledger";
import { fetchJson, isTransientStatus, remoteError } from "./http";
import { renderVerificationComment } from "./render-messages";

export type PullRequestMetadata = {
  repository: string;
  number: number;
  title?: string;
  body: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  baseBranch: string;
  htmlUrl: string;
};

export class GitHubAdapter implements EffectAdapter {
  constructor(private readonly config: { token: string; baseUrl: string; publicBaseUrl: string }) {}

  async getPullRequest(repository: string, pr: number): Promise<PullRequestMetadata> {
    const response = await this.api(`/repos/${repository}/pulls/${pr}`);
    if (response.status !== 200) throw new Error(remoteError("GitHub", response.status, response.body));
    const body = response.body as Record<string, unknown>;
    const base = body.base as Record<string, unknown> | undefined;
    return {
      repository,
      number: Number(body.number),
      title: String(body.title ?? ""),
      body: String(body.body ?? ""),
      merged: Boolean(body.merged),
      mergeCommitSha: body.merge_commit_sha ? String(body.merge_commit_sha) : null,
      mergedAt: body.merged_at ? String(body.merged_at) : null,
      baseBranch: String(base?.ref ?? ""),
      htmlUrl: String(body.html_url ?? ""),
    };
  }

  async send(effect: FrozenEffect): Promise<SendResult> {
    const repository = String(effect.destination.repository);
    const pr = Number(effect.destination.pr_number);
    const marker = `<!-- caseclosed:${effect.providerIdentity} -->`;
    const body = `${renderVerificationComment(effect.payload, `${this.config.publicBaseUrl}/case/${effect.caseId}`)}\n\n${marker}`;
    const response = await this.api(`/repos/${repository}/issues/${pr}/comments`, { body }, "POST");
    const value = response.body as Record<string, unknown>;
    if (response.status === 201 && value.id) return { kind: "committed", externalId: String(value.id), result: value };
    return { kind: "rejected", retryable: isTransientStatus(response.status), error: remoteError("GitHub", response.status, value) };
  }

  async reconcile(effect: FrozenEffect): Promise<Reconciliation> {
    const repository = String(effect.destination.repository);
    const pr = Number(effect.destination.pr_number);
    for (let page = 1; page <= 5; page += 1) {
      const response = await this.api(`/repos/${repository}/issues/${pr}/comments?per_page=100&page=${page}`);
      if (response.status !== 200) return { kind: "unknown", reason: remoteError("GitHub", response.status, response.body) };
      const comments = response.body as Array<Record<string, unknown>>;
      const found = comments.find((comment) => String(comment.body ?? "").includes(effect.providerIdentity));
      if (found?.id) return { kind: "found", externalId: String(found.id), result: found };
      if (comments.length < 100) break;
    }
    return { kind: "unknown", reason: "GitHub marker not found; absence cannot prove the send did not commit" };
  }

  private api(path: string, body?: unknown, method: "GET" | "POST" = "GET") {
    return fetchJson(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}
