import { createHmac, timingSafeEqual } from "node:crypto";

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: string } {
  if (!timestamp || !/^\d+$/.test(timestamp) || !signature?.startsWith("v0=")) return { ok: false, reason: "missing_signature" };
  const sentAt = Number(timestamp);
  if (!Number.isSafeInteger(sentAt) || Math.abs(nowSeconds - sentAt) > 300) return { ok: false, reason: "stale_timestamp" };
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`, "utf8").digest("hex")}`;
  return equal(expected, signature) ? { ok: true } : { ok: false, reason: "invalid_signature" };
}

export function verifyGitHubSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  return equal(expected, signature);
}

export function verifySharedSecret(provided: string | null, expected: string): boolean {
  return provided !== null && equal(provided, expected);
}
