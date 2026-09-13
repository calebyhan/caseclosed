import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { runs } from "../db/schema";
import type { EffectAdapter, Reconciliation, SendResult } from "../side-effects/deliver";
import type { FrozenEffect } from "../side-effects/ledger";
import { fetchJson, isTransientStatus, remoteError } from "./http";
import { renderLinearIssue, renderVerificationComment } from "./render-messages";

type GraphResult = { status: number; data?: Record<string, unknown>; errors?: Array<{ message?: string }> };

export class LinearAdapter implements EffectAdapter {
  constructor(
    private readonly config: { apiKey: string; teamId: string; baseUrl: string; publicBaseUrl: string },
    private readonly db?: Db,
  ) {}

  async send(effect: FrozenEffect): Promise<SendResult> {
    if (effect.type === "linear.create_issue") return this.createIssue(effect);
    if (effect.type === "linear.verification_comment") return this.createComment(effect);
    if (effect.type === "linear.apply_labels") return this.applyLabels(effect);
    return { kind: "rejected", retryable: false, error: `Unsupported Linear effect ${effect.type}` };
  }

  async reconcile(effect: FrozenEffect): Promise<Reconciliation> {
    if (effect.type === "linear.apply_labels") {
      // Label updates are naturally idempotent and recompute from current remote state.
      return { kind: "safe_to_send" };
    }
    const issue = effect.type === "linear.create_issue";
    const result = await this.graphql(
      issue
        ? `query ReconcileIssue($id: String!) { issue(id: $id) { id identifier url } }`
        : `query ReconcileComment($id: String!) { comment(id: $id) { id } }`,
      { id: effect.providerIdentity },
    );
    if (result.status !== 200 || result.errors?.length) return { kind: "unknown", reason: this.error(result) };
    const object = (issue ? result.data?.issue : result.data?.comment) as Record<string, unknown> | null | undefined;
    return object?.id
      ? { kind: "found", externalId: String(object.id), result: object }
      : { kind: "safe_to_send" }; // client-supplied UUID makes a resend provider-idempotent
  }

  private async createIssue(effect: FrozenEffect): Promise<SendResult> {
    const rendered = renderLinearIssue(effect.payload, `${this.config.publicBaseUrl}/case/${effect.caseId}`);
    const labelIds = await this.labelIds(["caseclosed-reproduced"]);
    if (labelIds.length !== 1) {
      return { kind: "rejected", retryable: false, error: "Linear label caseclosed-reproduced is not configured" };
    }
    const result = await this.graphql(
      `mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`,
      { input: { id: effect.providerIdentity, teamId: this.config.teamId, title: rendered.title, description: rendered.description, labelIds } },
    );
    const created = (result.data?.issueCreate as { success?: boolean; issue?: Record<string, unknown> } | undefined)?.issue;
    if (result.status === 200 && !result.errors?.length && created?.id) {
      return { kind: "committed", externalId: String(created.id), result: created };
    }
    throwIfAmbiguousMutation("issueCreate", result);
    return { kind: "rejected", retryable: isTransientStatus(result.status), error: this.error(result) };
  }

  private async createComment(effect: FrozenEffect): Promise<SendResult> {
    const issueId = String(effect.destination.issue_id ?? "");
    const body = renderVerificationComment(effect.payload, `${this.config.publicBaseUrl}/case/${effect.caseId}`);
    const result = await this.graphql(
      `mutation CreateComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`,
      { input: { id: effect.providerIdentity, issueId, body } },
    );
    const comment = (result.data?.commentCreate as { comment?: Record<string, unknown> } | undefined)?.comment;
    if (result.status === 200 && !result.errors?.length && comment?.id) {
      return { kind: "committed", externalId: String(comment.id), result: comment };
    }
    throwIfAmbiguousMutation("commentCreate", result);
    return { kind: "rejected", retryable: isTransientStatus(result.status), error: this.error(result) };
  }

  private async applyLabels(effect: FrozenEffect): Promise<SendResult> {
    const issueId = String(effect.destination.issue_id ?? "");
    const desiredRunId = effect.runId;
    // A delayed older intent must never undo the newest verification verdict.
    if (desiredRunId && effect.caseId && !(await this.isLatestVerification(effect.caseId, desiredRunId))) {
      return { kind: "committed", externalId: `superseded:${effect.providerIdentity}`, result: { superseded: true } };
    }
    const issue = await this.graphql(`query IssueLabels($id: String!) { issue(id: $id) { id labels { nodes { id name } } } }`, { id: issueId });
    const current = ((issue.data?.issue as { labels?: { nodes?: Array<{ id: string; name: string }> } } | undefined)?.labels?.nodes ?? []);
    const remove = new Set((effect.payload.remove as string[] | undefined) ?? []);
    const keep = current.filter((label) => !remove.has(label.name)).map((label) => label.id);
    const addNames = (effect.payload.add as string[] | undefined) ?? [];
    const add = await this.labelIds(addNames);
    if (add.length !== addNames.length) {
      return { kind: "rejected", retryable: false, error: `Linear managed label is not configured: ${addNames.join(", ")}` };
    }
    const labelIds = [...new Set([...keep, ...add])];
    const result = await this.graphql(
      `mutation UpdateLabels($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }`,
      { id: issueId, input: { labelIds } },
    );
    if (result.status === 200 && !result.errors?.length) {
      return { kind: "committed", externalId: effect.providerIdentity, result: { issue_id: issueId, label_ids: labelIds } };
    }
    throwIfAmbiguousMutation("issueUpdate", result);
    return { kind: "rejected", retryable: isTransientStatus(result.status), error: this.error(result) };
  }

  private async isLatestVerification(caseId: string, runId: string): Promise<boolean> {
    if (!this.db) return true;
    const latest = this.db.select({ id: runs.id }).from(runs)
      .where(and(eq(runs.caseId, caseId), eq(runs.runType, "verification"), eq(runs.status, "completed")))
      .orderBy(desc(runs.finishedAt), desc(runs.createdAt), desc(sql`rowid`)).get();
    return latest?.id === runId;
  }

  private async labelIds(names: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of names) {
      const result = await this.graphql(
        `query Label($name: String!, $team: ID!) { issueLabels(filter: { name: { eq: $name }, team: { id: { eq: $team } } }, first: 1) { nodes { id } } }`,
        { name, team: this.config.teamId },
      );
      const id = ((result.data?.issueLabels as { nodes?: Array<{ id: string }> } | undefined)?.nodes ?? [])[0]?.id;
      if (id) ids.push(id);
    }
    return ids;
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<GraphResult> {
    const response = await fetchJson(this.config.baseUrl, {
      method: "POST",
      headers: { Authorization: this.config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = response.body as { data?: Record<string, unknown>; errors?: Array<{ message?: string }> };
    return { status: response.status, data: body?.data, errors: body?.errors };
  }

  private error(result: GraphResult): string {
    return result.errors?.map((item) => item.message).filter(Boolean).join("; ") || remoteError("Linear", result.status, result);
  }
}

function throwIfAmbiguousMutation(operation: string, result: GraphResult): void {
  if (result.status === 408 || result.status >= 500 || result.status === 200) {
    const detail = result.errors?.map((item) => item.message).filter(Boolean).join("; ") || JSON.stringify(result.data ?? null).slice(0, 300);
    throw new Error(`ambiguous Linear ${operation} write (HTTP ${result.status}): ${detail}`);
  }
}
