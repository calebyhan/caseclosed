import { createHmac } from "node:crypto";
import { getAccount, type Account } from "./fixture";
import { getTestSecret, secretsMatch } from "./test-secret";

// Internal test session: a cookie carrying an HMAC-signed account ID. There
// is no login flow; CaseClosed obtains the cookie once (Playwright storage state).

export const SESSION_COOKIE = "acme_test_session";

function signature(accountId: string, secret: string): string {
  return createHmac("sha256", secret).update(`acme-session-v1:${accountId}`).digest("base64url");
}

export function mintSessionToken(accountId: string, secret: string): string {
  return `${accountId}.${signature(accountId, secret)}`;
}

export function verifySessionToken(token: string, secret: string): string | null {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const accountId = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  return secretsMatch(provided, signature(accountId, secret)) ? accountId : null;
}

export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`;
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** Resolves the signed-in account from a session token, or null when absent/invalid. */
export function accountFromToken(token: string | null | undefined): Account | null {
  const secret = getTestSecret();
  if (!token || !secret) return null;
  const accountId = verifySessionToken(token, secret);
  return accountId ? getAccount(accountId) : null;
}

export function accountFromRequest(request: Request): Account | null {
  return accountFromToken(readCookie(request.headers.get("cookie"), SESSION_COOKIE));
}

export function unauthenticatedResponse(): Response {
  return Response.json({ error: "unauthenticated", message: "A valid test session cookie is required." }, { status: 401 });
}
