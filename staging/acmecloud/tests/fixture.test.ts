import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixtureSeed, getAccount, resetFixture, saveAccount } from "../src/server/fixture";

describe("staging fixture store", () => {
  it("seeds the Pro monthly customer", () => {
    assert.deepEqual(resetFixture("pro_monthly_customer"), {
      id: "pro_monthly_customer",
      email: "test@acmecloud.local",
      plan: "pro",
      billing_period: "monthly",
      pending_change: null,
    });
  });

  it("restores identical state after mutation, on every reset", () => {
    const seed = fixtureSeed("pro_monthly_customer");
    const snapshots = [];
    for (let round = 0; round < 3; round += 1) {
      const account = getAccount("pro_monthly_customer")!;
      saveAccount({
        ...account,
        billing_period: "annual",
        pending_change: { plan: "pro", billing_period: "annual", amount_cents: 1, interval: "year" },
      });
      assert.equal(getAccount("pro_monthly_customer")!.billing_period, "annual");
      snapshots.push(resetFixture("pro_monthly_customer"));
    }
    for (const snapshot of snapshots) assert.deepEqual(snapshot, seed);
    assert.deepEqual(getAccount("pro_monthly_customer"), seed);
  });

  it("is idempotent when reset repeatedly without changes", () => {
    const first = resetFixture("pro_monthly_customer");
    const second = resetFixture("pro_monthly_customer");
    assert.deepEqual(first, second);
  });

  it("never exposes its internal objects to callers", () => {
    resetFixture("pro_monthly_customer");
    const copy = getAccount("pro_monthly_customer")!;
    copy.billing_period = "annual";
    const seedCopy = fixtureSeed("pro_monthly_customer");
    seedCopy.email = "mutated@example.com";
    assert.equal(getAccount("pro_monthly_customer")!.billing_period, "monthly");
    assert.equal(resetFixture("pro_monthly_customer").email, "test@acmecloud.local");
  });
});
