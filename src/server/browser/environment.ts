import type { InfraErrorReason } from "../../contracts/lifecycle";

// Staging environment driver: health, fixture reset, and the internal test
// session. It owns no case transitions or verdict logic. Secrets are sent only
// in headers to the configured staging origin and never returned or logged.

export type EnvironmentFailure = { ok: false; reason: InfraErrorReason; detail: string };
export type SessionCookie = { name: string; value: string; url: string };

export interface StagingEnvironment {
  readonly baseUrl: string;
  checkHealth(signal?: AbortSignal): Promise<{ ok: true; commitSha: string | null } | EnvironmentFailure>;
  resetFixture(fixture: string, signal?: AbortSignal): Promise<{ ok: true } | EnvironmentFailure>;
  /** Mints a test session and proves it authenticates before any browser work. */
  createSession(fixture: string, signal?: AbortSignal): Promise<{ ok: true; cookies: SessionCookie[] } | EnvironmentFailure>;
}

export type HttpStagingEnvironmentOptions = {
  baseUrl: string;
  testSecret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const SECRET_HEADER = "x-caseclosed-secret";

export class HttpStagingEnvironment implements StagingEnvironment {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpStagingEnvironmentOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async checkHealth(signal?: AbortSignal) {
    const response = await this.request("GET", "/api/health", { signal });
    if (!response.ok) return failure("staging_unreachable", `health check failed: ${response.detail}`);
    if (response.status !== 200) return failure("staging_unreachable", `health check returned HTTP ${response.status}`);
    const body = response.json as { commit_sha?: unknown } | null;
    if (typeof body?.commit_sha !== "string" || !body.commit_sha.trim()) {
      return failure("staging_unreachable", "health check returned no commit_sha");
    }
    return { ok: true as const, commitSha: body.commit_sha };
  }

  async resetFixture(fixture: string, signal?: AbortSignal) {
    const response = await this.request("POST", "/api/test/reset", { body: { fixture }, secret: true, signal });
    if (!response.ok) return failure("fixture_reset_failed", `reset request failed: ${response.detail}`);
    const body = response.json as { fixture?: unknown; reset?: unknown } | null;
    if (response.status !== 200 || body?.reset !== true || body.fixture !== fixture) {
      return failure("fixture_reset_failed", `reset returned HTTP ${response.status}${body ? ` ${JSON.stringify(body).slice(0, 200)}` : ""}`);
    }
    return { ok: true as const };
  }

  async createSession(fixture: string, signal?: AbortSignal) {
    const minted = await this.request("POST", "/api/test/session", { body: { fixture }, secret: true, signal });
    if (!minted.ok) return failure("auth_failed", `session request failed: ${minted.detail}`);
    if (minted.status !== 200) return failure("auth_failed", `session endpoint returned HTTP ${minted.status}`);
    const cookies = minted.setCookies
      .map((header) => header.split(";")[0]!)
      .map((pair) => {
        const separator = pair.indexOf("=");
        return { name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim(), url: this.baseUrl };
      })
      .filter((cookie) => cookie.name && cookie.value);
    if (cookies.length === 0) return failure("auth_failed", "session endpoint set no cookie");

    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const verified = await this.request("GET", "/api/account", { headers: { cookie: cookieHeader }, signal });
    if (!verified.ok) return failure("auth_failed", `session verification failed: ${verified.detail}`);
    if (verified.status !== 200) return failure("auth_failed", `session verification returned HTTP ${verified.status}`);
    return { ok: true as const, cookies };
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; secret?: boolean; headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<
    | { ok: true; status: number; json: unknown; setCookies: string[] }
    | { ok: false; detail: string }
  > {
    const signals = [AbortSignal.timeout(this.timeoutMs), ...(options.signal ? [options.signal] : [])];
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(options.secret ? { [SECRET_HEADER]: this.options.testSecret } : {}),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.any(signals),
        redirect: "manual",
        cache: "no-store",
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: true, status: response.status, json, setCookies: response.headers.getSetCookie() };
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      const name = (error as Error).name;
      return { ok: false, detail: cause ?? (name === "TimeoutError" ? `timed out after ${this.timeoutMs}ms` : name || "network error") };
    }
  }
}

function failure(reason: InfraErrorReason, detail: string): EnvironmentFailure {
  return { ok: false, reason, detail };
}
