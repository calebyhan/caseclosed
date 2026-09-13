import { AppContext, ReproSpec, SUPPORTED_ROLES } from "../contracts/repro";
import { isSafeAppPath } from "./action-policy";
import { containsSecret, stringLeaves } from "./secrets";

// Schema + semantic validation for ReproSpec (docs/REPROSPEC.md "Validation
// rules"). Pure: errors are structured so they can be fed back to the model.

export type ValidationError = { path: string; message: string };

export type SpecIdentity = {
  caseId: string;
  appContextHash: string;
  /** Configured secret values that must never appear in a spec. */
  knownSecrets?: readonly (string | null | undefined)[];
};

export type SpecValidation = { ok: true; spec: ReproSpec } | { ok: false; errors: ValidationError[] };

export const MAX_SPEC_STEPS = 15;

const supportedRoles: ReadonlySet<string> = new Set(SUPPORTED_ROLES);

export function validateReproSpec(input: unknown, ctx: AppContext, identity: SpecIdentity): SpecValidation {
  const parsed = ReproSpec.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  }
  const spec = parsed.data;
  const errors: ValidationError[] = [];
  const fail = (path: string, message: string) => errors.push({ path, message });

  if (spec.case_id !== identity.caseId) fail("case_id", `must be ${identity.caseId}`);
  if (spec.app_context_hash !== identity.appContextHash) fail("app_context_hash", "does not match the current AppContext");
  if (spec.environment.id !== ctx.environment_id) fail("environment.id", `must be "${ctx.environment_id}"`);
  if (!ctx.fixtures.some((fixture) => fixture.id === spec.environment.fixture)) {
    fail("environment.fixture", `unknown fixture; use one of: ${ctx.fixtures.map((f) => f.id).join(", ")}`);
  }
  if (!ctx.routes.some((route) => route.path === spec.environment.start_path)) {
    fail("environment.start_path", `must be a declared route: ${ctx.routes.map((r) => r.path).join(", ")}`);
  }
  if (spec.steps.length > MAX_SPEC_STEPS) fail("steps", `at most ${MAX_SPEC_STEPS} steps are allowed`);

  const seenIds = new Map<string, string>();
  const claimId = (id: string, path: string) => {
    if (!id.trim()) fail(path, "id must not be empty");
    const previous = seenIds.get(id);
    if (previous) fail(path, `duplicate id "${id}" (also used at ${previous})`);
    else seenIds.set(id, path);
  };
  spec.steps.forEach((step, index) => {
    claimId(step.id, `steps.${index}.id`);
    if (!step.intent.trim()) fail(`steps.${index}.intent`, "intent must not be blank");
  });

  const checks = [
    ...spec.assertions.map((check, index) => ({ check, path: `assertions.${index}` })),
    ...spec.failure_signals.map((check, index) => ({ check, path: `failure_signals.${index}` })),
  ];
  for (const { check, path } of checks) {
    claimId(check.id, `${path}.id`);
    switch (check.type) {
      case "network_status": {
        if (check.min > check.max) fail(`${path}.min`, "min must be <= max");
        const declared = ctx.api_endpoints.some(
          (endpoint) =>
            endpoint.method === check.method &&
            (check.url_contains === endpoint.path || check.url_contains.startsWith(`${endpoint.path}?`) || check.url_contains.startsWith(`${endpoint.path}#`)),
        );
        if (!declared) {
          fail(
            `${path}.url_contains`,
            `must start with a declared ${check.method} endpoint: ${
              ctx.api_endpoints.map((e) => `${e.method} ${e.path}`).join(", ") || "(none)"
            }`,
          );
        }
        break;
      }
      case "element_visible":
      case "element_not_visible":
      case "element_still_visible_after_ms": {
        if (!supportedRoles.has(check.role)) fail(`${path}.role`, `unsupported role "${check.role}"`);
        const landmark = ctx.landmarks.some((l) => l.role === check.role && l.name === check.name);
        if (!landmark) {
          fail(`${path}.name`, `role "${check.role}" + name "${check.name}" is not a declared AppContext landmark`);
        }
        break;
      }
      case "url_contains":
        if (!isSafeAppPath(check.value)) fail(`${path}.value`, "must be a same-origin path fragment starting with /");
        break;
      case "text_visible":
        if (!check.value.trim()) fail(`${path}.value`, "text must not be blank");
        break;
    }
  }

  const flags = spec.evidence;
  for (const flag of ["screenshots", "network", "console", "actions"] as const) {
    if (!flags[flag]) fail(`evidence.${flag}`, "must be true in the MVP");
  }

  for (const leaf of stringLeaves(spec)) {
    if (containsSecret(leaf.value, identity.knownSecrets)) fail(leaf.path, "must not contain credentials or secrets");
  }

  return errors.length === 0 ? { ok: true, spec } : { ok: false, errors };
}

export function formatValidationErrors(errors: readonly ValidationError[]): string {
  return errors.map((error) => `- ${error.path || "(root)"}: ${error.message}`).join("\n");
}
