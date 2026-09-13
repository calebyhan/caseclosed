import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalJson,
  effectKeys,
  formatCaseId,
  isCaseId,
  isValidEffectKey,
  jobKeys,
  sha256Hash,
} from "../../src/domain/identity";

describe("canonical hashing", () => {
  it("is independent of object key order but not array order", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [2, 1], c: null } }), '{"a":{"c":null,"d":[2,1]},"b":1}');
    assert.equal(sha256Hash({ a: 1, b: 2 }), sha256Hash({ b: 2, a: 1 }));
    assert.notEqual(sha256Hash([1, 2]), sha256Hash([2, 1]));
    assert.match(sha256Hash({}), /^sha256:[0-9a-f]{64}$/);
  });
});

describe("case IDs", () => {
  it("pads to at least four digits", () => {
    assert.equal(formatCaseId(42), "CC-0042");
    assert.equal(formatCaseId(12345), "CC-12345");
    assert.throws(() => formatCaseId(0));
    assert.ok(isCaseId("CC-0042"));
    assert.ok(!isCaseId("CC-42"));
    assert.ok(!isCaseId("../etc"));
  });
});

describe("idempotency keys", () => {
  it("accepts stable event-identity keys", () => {
    for (const key of ["linear:create:CC-0042", "slack:reproduced:CC-0042", "github:verify:CC-0042:pr-84"]) {
      assert.ok(isValidEffectKey(key), key);
    }
    const runId = "4b1d3a8e-7c0f-4f59-9a0e-1f2d3c4b5a69";
    for (const key of Object.values(effectKeys).map((build) => build(runId))) {
      assert.ok(isValidEffectKey(key), key);
    }
  });

  it("rejects malformed keys", () => {
    for (const key of ["", "linear", "linear:create:", "Linear:create:CC-1", "linear:create:has space", "linear::CC-1"]) {
      assert.ok(!isValidEffectKey(key), JSON.stringify(key));
    }
  });

  it("builds job keys from event identity", () => {
    assert.equal(jobKeys.verifyInitial("CC-0042", "abc"), "verify:CC-0042:abc:initial");
    assert.equal(jobKeys.verifyRetry("CC-0042", "abc", "run-1"), "verify:CC-0042:abc:retry:run-1");
    assert.equal(jobKeys.effect("linear:create:CC-0042"), "effect:linear:create:CC-0042");
  });
});
