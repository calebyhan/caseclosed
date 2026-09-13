import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { AppContext } from "../../src/contracts/repro";
import { isSafeAppPath, validateProposedAction } from "../../src/domain/action-policy";
import { sha256Hash } from "../../src/domain/identity";
import { validateReproSpec, type ValidationError } from "../../src/domain/validate-repro-spec";

const ctx = AppContext.parse(JSON.parse(fs.readFileSync("config/environments/staging.json", "utf8")));
const identity = { caseId: "CC-0042", appContextHash: sha256Hash(ctx), knownSecrets: ["super-secret-staging-value"] };
type MutableSpec = Record<string, unknown> & {
  environment: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  assertions: Array<Record<string, unknown>>;
  failure_signals: Array<Record<string, unknown>>;
  evidence: Record<string, unknown>;
};
const golden = () => JSON.parse(fs.readFileSync("fixtures/repro-spec.valid.json", "utf8")) as MutableSpec;

function errorsFor(spec: unknown): ValidationError[] {
  const result = validateReproSpec(spec, ctx, identity);
  assert.equal(result.ok, false, "expected validation to fail");
  return result.ok ? [] : result.errors;
}

const hasError = (errors: ValidationError[], path: string, pattern?: RegExp) =>
  errors.some((error) => error.path === path && (!pattern || pattern.test(error.message)));

describe("validateReproSpec", () => {
  it("accepts the golden billing spec against the staging AppContext", () => {
    const result = validateReproSpec(golden(), ctx, identity);
    assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.errors));
    assert.equal(result.spec.assertions[1]!.type, "element_visible");
  });

  it("rejects unsafe or ambiguous AppContext origins, paths, and landmarks", () => {
    assert.equal(AppContext.safeParse({ ...ctx, base_url: "https://user:password@example.test/private" }).success, false);
    assert.equal(AppContext.safeParse({ ...ctx, routes: [...ctx.routes, { ...ctx.routes[0], path: "//evil.example" }] }).success, false);
    assert.equal(AppContext.safeParse({ ...ctx, landmarks: [...ctx.landmarks, ctx.landmarks[0]] }).success, false);
  });

  it("reports schema errors with paths", () => {
    const spec = golden();
    delete (spec as { failure_signals?: unknown }).failure_signals;
    spec.assertions[0]!.method = "FETCH";
    const errors = errorsFor(spec);
    assert.ok(hasError(errors, "failure_signals"));
    assert.ok(hasError(errors, "assertions.0.method"));
  });

  it("rejects unknown fields instead of silently stripping unsupported semantics", () => {
    const spec = golden();
    spec.assertions[0]!.confidence = 0.99;
    assert.ok(hasError(errorsFor(spec), "assertions.0", /unrecognized/i));
  });

  it("requires application-owned identity to match", () => {
    const spec = { ...golden(), case_id: "CC-0001", app_context_hash: "sha256:stale", environment: { ...golden().environment, id: "prod" } };
    const errors = errorsFor(spec);
    assert.ok(hasError(errors, "case_id"));
    assert.ok(hasError(errors, "app_context_hash"));
    assert.ok(hasError(errors, "environment.id"));
  });

  it("rejects unknown fixtures and undeclared start paths", () => {
    const spec = { ...golden(), environment: { id: "staging", start_path: "/admin", fixture: "enterprise_admin" } };
    const errors = errorsFor(spec);
    assert.ok(hasError(errors, "environment.fixture"));
    assert.ok(hasError(errors, "environment.start_path", /\/settings\/billing/));
  });

  it("rejects duplicate IDs across assertions and signals", () => {
    const spec = golden();
    spec.failure_signals[0]!.id = "a1";
    assert.ok(hasError(errorsFor(spec), "failure_signals.0.id", /duplicate/));
  });

  it("rejects inverted status ranges and undeclared endpoints or methods", () => {
    const spec = golden();
    spec.assertions[0]!.min = 500;
    spec.assertions[0]!.max = 200;
    spec.failure_signals[0]!.method = "GET";
    const errors = errorsFor(spec);
    assert.ok(hasError(errors, "assertions.0.min"));
    assert.ok(hasError(errors, "failure_signals.0.url_contains", /declared GET endpoint/));
  });

  it("does not accept an endpoint merely because its name shares a prefix", () => {
    const spec = golden();
    spec.assertions[0]!.url_contains = "/api/subscription-telemetry";
    assert.ok(hasError(errorsFor(spec), "assertions.0.url_contains", /declared POST endpoint/));
  });

  it("rejects elements that are not declared landmarks or use unsupported roles", () => {
    const spec = golden();
    spec.assertions[1]!.name = "Order summary";
    spec.failure_signals[1]!.role = "marquee";
    const errors = errorsFor(spec);
    assert.ok(hasError(errors, "assertions.1.name", /landmark/));
    assert.ok(hasError(errors, "failure_signals.1.role"));
  });

  it("rejects unsafe URL fragments, disabled evidence, too many steps, and timeouts over the maximum", () => {
    const spec = golden();
    spec.assertions.push({ id: "a3", type: "url_contains", value: "//evil.example/checkout", within_ms: 5000 });
    spec.evidence.console = false;
    spec.steps = Array.from({ length: 16 }, (_, i) => ({ id: `s${i}`, intent: "Click Upgrade" }));
    let errors = errorsFor(spec);
    assert.ok(hasError(errors, "assertions.2.value"));
    assert.ok(hasError(errors, "evidence.console"));
    assert.ok(hasError(errors, "steps"));

    const slow = golden();
    slow.failure_signals[1]!.after_ms = 10_000;
    errors = errorsFor(slow);
    assert.ok(hasError(errors, "failure_signals.1.after_ms"));
  });

  it("rejects embedded credentials and configured secrets", () => {
    const spec = golden();
    spec.steps[0]!.intent = "Log in with password=hunter2hunter2";
    spec.goal = "Use super-secret-staging-value to reset";
    const errors = errorsFor(spec);
    assert.ok(hasError(errors, "steps[0].intent", /secret/));
    assert.ok(hasError(errors, "goal", /secret/));
  });
});

describe("validateProposedAction", () => {
  const ok = (raw: unknown) => validateProposedAction(raw, ctx, identity.knownSecrets);

  it("accepts exact role + name actions", () => {
    assert.ok(ok({ type: "click", role: "radio", name: "Annual" }).ok);
    assert.ok(ok({ type: "goto", path: "/settings/billing" }).ok);
  });

  it("rejects finish, coordinates, selectors, and locator fallbacks", () => {
    assert.match((ok({ type: "finish", reason: "done" }) as { error: string }).error, /finish/);
    assert.match((ok({ type: "click", role: "button", name: "Upgrade", x: 10, y: 20 }) as { error: string }).error, /[Uu]nrecognized keys.*x.*y/);
    assert.equal(ok({ type: "click", selector: "#upgrade" }).ok, false);
    assert.equal(ok({ type: "click", role: "button", name: "Upgrade", fallbacks: [{ by: "text", value: "Upgrade" }] }).ok, false);
  });

  it("rejects element actions that are not declared landmarks on the current route", () => {
    assert.equal(validateProposedAction({ type: "click", role: "heading", name: "Checkout" }, ctx, [], "/settings/billing").ok, false);
    assert.ok(validateProposedAction({ type: "click", role: "button", name: "Upgrade" }, ctx, [], "/settings/billing").ok);
  });

  it("confines navigation to declared same-origin routes", () => {
    for (const path of ["//evil.example/", "/admin", "/settings/../admin", "/x\\y"]) {
      assert.equal(ok({ type: "goto", path }).ok, false, path);
    }
    assert.equal(isSafeAppPath("/checkout?plan=pro"), true);
    assert.equal(isSafeAppPath("/a@b"), false);
  });

  it("rejects secrets in fill values", () => {
    assert.equal(ok({ type: "fill", role: "textbox", name: "Coupon", value: "super-secret-staging-value" }).ok, false);
  });
});
