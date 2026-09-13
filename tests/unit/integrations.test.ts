import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { verifyGitHubSignature, verifySharedSecret, verifySlackSignature } from "../../src/server/integrations/signatures";
import { parsePrAssociations } from "../../src/server/services/fix-lifecycle";

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
