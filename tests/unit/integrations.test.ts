import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import type { Db } from "../../src/server/db/client";
import { GitHubAdapter } from "../../src/server/integrations/github";
import { LinearAdapter } from "../../src/server/integrations/linear";
import { verifyGitHubSignature, verifySharedSecret, verifySlackSignature } from "../../src/server/integrations/signatures";
import { SlackEffectAdapter } from "../../src/server/integrations/slack";
import { parsePrAssociations } from "../../src/server/services/fix-lifecycle";
import type { FrozenEffect } from "../../src/server/side-effects/ledger";

describe("webhook authentication", () => {
  it("verifies Slack over the raw body and rejects stale or changed payloads", () => {
    const secret = "slack-secret";
    const timestamp = "1700000000";
    const body = "command=%2Fcaseclosed&text=upgrade+spins";
    const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    assert.deepEqual(verifySlackSignature(body, timestamp, signature, secret, 1700000100), { ok: true });
    assert.equal(verifySlackSignature(`${body}!`, timestamp, signature, secret, 1700000100).ok, false);
    assert.deepEqual(verifySlackSignature(body, timestamp, signature, secret, 1700001000), { ok: false, reason: "stale_timestamp" });
  });

  it("verifies GitHub and deployment shared secrets with exact comparisons", () => {
    const raw = '{"action":"closed"}';
    const signature = `sha256=${createHmac("sha256", "github-secret").update(raw).digest("hex")}`;
    assert.equal(verifyGitHubSignature(raw, signature, "github-secret"), true);
    assert.equal(verifyGitHubSignature(`${raw} `, signature, "github-secret"), false);
    assert.equal(verifySharedSecret("ready-secret", "ready-secret"), true);
    assert.equal(verifySharedSecret("wrong", "ready-secret"), false);
  });
});

describe("PR association", () => {
  it("accepts CaseClosed and configured Linear references without fuzzy matching", () => {
    assert.deepEqual(parsePrAssociations("CaseClosed: cc-0042\nFixes ENG-142", "ENG"), {
      caseIds: ["CC-0042"],
      linearIds: ["ENG-142"],
    });
    assert.deepEqual(parsePrAssociations("mentions CC-0042 and ENG-142 but has no directives", "ENG"), { caseIds: [], linearIds: [] });
  });
});

describe("ambiguous outbound writes", () => {
  const effect = (type: string): FrozenEffect => ({
    key: "provider:test:run-1",
    type,
    caseId: "CC-0001",
    runId: "run-1",
    attemptId: "attempt-1",
    destination: { channel_id: "C1", issue_id: "issue-1", repository: "acme/acmecloud", pr_number: 84 },
    payload: { result: "VERIFIED_FIXED" },
    payloadHash: "sha256:test",
    providerIdentity: "11111111-1111-4111-8111-111111111111",
  });

  it("forces reconciliation after provider 5xx responses instead of authorizing a duplicate retry", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "upstream failed after commit" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    try {
      const slack = new SlackEffectAdapter({} as Db, { botToken: "x", baseUrl: "https://slack.invalid", publicBaseUrl: "https://caseclosed.invalid" });
      const github = new GitHubAdapter({ token: "x", baseUrl: "https://github.invalid", publicBaseUrl: "https://caseclosed.invalid" });
      const linear = new LinearAdapter({ apiKey: "x", teamId: "team", baseUrl: "https://linear.invalid", publicBaseUrl: "https://caseclosed.invalid" });

      await assert.rejects(slack.send(effect("slack.post_case_root")), /ambiguous Slack write/);
      await assert.rejects(github.send(effect("github.verification_comment")), /ambiguous GitHub write/);
      await assert.rejects(linear.send(effect("linear.verification_comment")), /ambiguous Linear commentCreate write/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("treats a 2xx response without a durable external identity as ambiguous", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    try {
      const slack = new SlackEffectAdapter({} as Db, { botToken: "x", baseUrl: "https://slack.invalid", publicBaseUrl: "https://caseclosed.invalid" });
      await assert.rejects(slack.send(effect("slack.post_case_root")), /ambiguous Slack write/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
