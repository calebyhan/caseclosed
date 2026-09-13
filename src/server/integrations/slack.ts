import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { externalLinks } from "../db/schema";
import type { EffectAdapter, Reconciliation, SendResult } from "../side-effects/deliver";
import type { FrozenEffect } from "../side-effects/ledger";
import { fetchJson, isTransientStatus, remoteError } from "./http";
import { renderSlack } from "./render-messages";

type SlackResponse = { ok?: boolean; error?: string; ts?: string; channel?: string; messages?: Array<{ ts?: string; text?: string }> };

export class SlackEffectAdapter implements EffectAdapter {
  constructor(
    private readonly db: Db,
    private readonly config: { botToken: string; baseUrl: string; publicBaseUrl: string },
  ) {}

  async send(effect: FrozenEffect): Promise<SendResult> {
    const channel = String(effect.destination.channel_id ?? "");
    const threadTs = effect.type === "slack.reply" ? this.threadTs(effect) : null;
    if (!channel || (effect.type === "slack.reply" && !threadTs)) {
      return { kind: "rejected", retryable: true, error: "Slack case thread is not available yet" };
    }
    const caseUrl = `${this.config.publicBaseUrl}/case/${effect.caseId}`;
    const marker = `\n\n_CaseClosed ref: ${effect.providerIdentity}_`;
    const response = await this.api("chat.postMessage", {
      channel,
      text: `${renderSlack(effect.type, effect.payload, caseUrl)}${marker}`,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    const body = response.body as SlackResponse;
    if (response.status >= 200 && response.status < 300 && body.ok && body.ts) {
      return { kind: "committed", externalId: body.ts, result: { ts: body.ts, channel: body.channel ?? channel } };
    }
    return { kind: "rejected", retryable: isTransientStatus(response.status) || body.error === "ratelimited", error: remoteError("Slack", response.status, body) };
  }

  async reconcile(effect: FrozenEffect): Promise<Reconciliation> {
    const channel = String(effect.destination.channel_id ?? "");
    const root = effect.type === "slack.reply" ? this.threadTs(effect) : null;
    if (!channel || (effect.type === "slack.reply" && !root)) return { kind: "unknown", reason: "Slack thread identity unavailable" };
    const method = root ? "conversations.replies" : "conversations.history";
    const query = new URLSearchParams({ channel, limit: "100", ...(root ? { ts: root } : {}) });
    const response = await this.api(`${method}?${query}`, undefined, "GET");
    const body = response.body as SlackResponse;
    const found = body.messages?.find((message) => message.text?.includes(effect.providerIdentity));
    if (found?.ts) return { kind: "found", externalId: found.ts, result: { ts: found.ts, channel } };
    return { kind: "unknown", reason: "Slack marker not found; absence cannot prove the send did not commit" };
  }

  private threadTs(effect: FrozenEffect): string | null {
    if (!effect.caseId) return null;
    return this.db.select({ ts: externalLinks.slackRootTs }).from(externalLinks).where(eq(externalLinks.caseId, effect.caseId)).get()?.ts ?? null;
  }

  private api(method: string, payload?: unknown, verb: "GET" | "POST" = "POST") {
    return fetchJson(`${this.config.baseUrl}/${method}`, {
      method: verb,
      headers: { Authorization: `Bearer ${this.config.botToken}`, ...(verb === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  }
}
