import { createHash, timingSafeEqual } from "node:crypto";

export const TEST_SECRET_HEADER = "x-caseclosed-secret";

export function getTestSecret(): string | null {
  const secret = process.env.STAGING_TEST_SECRET;
  return secret && secret.length > 0 ? secret : null;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison that does not leak length. */
export function secretsMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

/** Returns an error response when the test secret is missing or wrong, otherwise null. */
export function rejectUnlessTestSecret(request: Request): Response | null {
  const expected = getTestSecret();
  if (!expected) {
    return Response.json(
      { error: "test_secret_not_configured", message: "Set STAGING_TEST_SECRET for the staging app." },
      { status: 503 },
    );
  }
  const provided = request.headers.get(TEST_SECRET_HEADER);
  if (!provided || !secretsMatch(provided, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
