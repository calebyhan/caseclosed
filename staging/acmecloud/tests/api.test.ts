import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { GET as getAccountRoute } from "../src/app/api/account/route";
import { GET as health } from "../src/app/api/health/route";
import { POST as subscription } from "../src/app/api/subscription/route";
import { POST as reset } from "../src/app/api/test/reset/route";
import { POST as createSession } from "../src/app/api/test/session/route";
import { fixtureSeed, getAccount, resetFixture, saveAccount } from "../src/server/fixture";

const SECRET = "test-secret-0123456789";
const BASE = "http://acmecloud.test";

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function sessionCookie(): Promise<string> {
  const response = await createSession(post("/api/test/session", { fixture: "pro_monthly_customer" }, { "x-caseclosed-secret": SECRET }));
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "session route must set a cookie");
  return setCookie.split(";")[0]!;
}

before(() => {
  process.env.STAGING_TEST_SECRET = SECRET;
});

beforeEach(() => {
  resetFixture("pro_monthly_customer");
});

describe("POST /api/test/reset", () => {
  it("rejects a missing or wrong secret", async () => {
    assert.equal((await reset(post("/api/test/reset", { fixture: "pro_monthly_customer" }))).status, 401);
    const wrong = await reset(post("/api/test/reset", { fixture: "pro_monthly_customer" }, { "x-caseclosed-secret": "nope" }));
    assert.equal(wrong.status, 401);
  });

  it("rejects unknown fixtures and malformed bodies", async () => {
    const unknown = await reset(post("/api/test/reset", { fixture: "enterprise" }, { "x-caseclosed-secret": SECRET }));
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error, "unknown_fixture");
    const malformed = await reset(post("/api/test/reset", { nope: true }, { "x-caseclosed-secret": SECRET }));
    assert.equal(malformed.status, 400);
  });

  it("restores the seeded account deterministically after a mutation", async () => {
    const cookie = await sessionCookie();
    await subscription(post("/api/subscription", { plan: "pro", billing_period: "monthly" }, { cookie }));
    // Simulate a previous experiment leaving different state behind.
    saveAccount({ ...getAccount("pro_monthly_customer")!, billing_period: "annual" });

    for (let round = 0; round < 2; round += 1) {
      const response = await reset(post("/api/test/reset", { fixture: "pro_monthly_customer" }, { "x-caseclosed-secret": SECRET }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { fixture: "pro_monthly_customer", reset: true });
      assert.deepEqual(getAccount("pro_monthly_customer"), fixtureSeed("pro_monthly_customer"));
    }
  });
});

describe("test session", () => {
  it("authenticates API requests without a login flow", async () => {
    const cookie = await sessionCookie();
    const response = await getAccountRoute(new Request(`${BASE}/api/account`, { headers: { cookie } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).email, "test@acmecloud.local");
  });

  it("returns a detectable auth failure for missing or forged sessions", async () => {
    assert.equal((await getAccountRoute(new Request(`${BASE}/api/account`))).status, 401);
    const forged = await getAccountRoute(
      new Request(`${BASE}/api/account`, { headers: { cookie: "acme_test_session=pro_monthly_customer.forged" } }),
    );
    assert.equal(forged.status, 401);
    const noSession = await subscription(post("/api/subscription", { plan: "pro", billing_period: "annual" }));
    assert.equal(noSession.status, 401);
  });

  it("refuses to mint sessions without the test secret", async () => {
    const response = await createSession(post("/api/test/session", { fixture: "pro_monthly_customer" }));
    assert.equal(response.status, 401);
  });
});

describe("POST /api/subscription", () => {
  it("returns checkout for the monthly → annual upgrade", async () => {
    const cookie = await sessionCookie();
    const response = await subscription(post("/api/subscription", { plan: "pro", billing_period: "annual" }, { cookie }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.kind, "checkout");
    assert.equal(body.checkout_path, "/checkout");
    assert.equal(getAccount("pro_monthly_customer")?.pending_change?.billing_period, "annual");
  });

  it("still handles the non-annual path successfully", async () => {
    const cookie = await sessionCookie();
    const response = await subscription(post("/api/subscription", { plan: "pro", billing_period: "monthly" }, { cookie }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).kind, "unchanged");
  });

  it("rejects malformed plan changes with 400", async () => {
    const cookie = await sessionCookie();
    const response = await subscription(post("/api/subscription", { plan: "pro", billing_period: "weekly" }, { cookie }));
    assert.equal(response.status, 400);
  });
});

describe("GET /api/health", () => {
  it("reports build provenance uncached", async () => {
    const response = await health();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(typeof body.commit_sha, "string");
    assert.equal(typeof body.build, "string");
  });
});
