import { AppContext, BrowserAction, SUPPORTED_ROLES } from "../contracts/repro";
import { containsSecret } from "./secrets";

// Every proposed browser action is validated here before execution. The
// runner, not the model, decides whether an action is permitted.

const supportedRoles: ReadonlySet<string> = new Set(SUPPORTED_ROLES);

/** A path within the staging origin: no scheme, authority, backslash, or traversal. */
export function isSafeAppPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.length > 500) return false;
  return !/[\\\s@]|:\/\/|\/\.\.?(?:\/|$)|%2e%2e|%2f|%5c/i.test(value);
}

export type ActionPolicyResult = { ok: true; action: BrowserAction } | { ok: false; error: string };

export function validateProposedAction(
  raw: unknown,
  ctx: AppContext,
  knownSecrets: readonly (string | null | undefined)[] = [],
  currentPath?: string,
): ActionPolicyResult {
  const parsed = BrowserAction.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }
  const action = parsed.data;
  // The contract schema strips unknown keys; a proposal carrying e.g. x/y
  // coordinates or a selector field is rejected rather than silently cleaned.
  const unknownKeys = Object.keys(raw as object).filter((key) => !Object.hasOwn(action, key));
  if (unknownKeys.length > 0) return { ok: false, error: `unsupported action fields: ${unknownKeys.join(", ")}` };

  switch (action.type) {
    case "finish":
      return { ok: false, error: "finish is not permitted; every step must resolve to a concrete interaction" };
    case "wait":
      return { ok: true, action };
    case "goto":
      if (!isSafeAppPath(action.path)) return { ok: false, error: `goto path ${JSON.stringify(action.path)} is not a safe same-origin path` };
      if (!ctx.routes.some((route) => action.path.split(/[?#]/)[0] === route.path)) {
        return { ok: false, error: `goto path must be a declared route: ${ctx.routes.map((r) => r.path).join(", ")}` };
      }
      return { ok: true, action };
    case "click":
    case "fill":
    case "select": {
      if (!supportedRoles.has(action.role)) return { ok: false, error: `unsupported role "${action.role}"` };
      const route = currentPath?.split(/[?#]/)[0];
      const declared = ctx.landmarks.some(
        (landmark) => landmark.role === action.role && landmark.name === action.name && (!route || landmark.route === route),
      );
      if (!declared) {
        return { ok: false, error: `role "${action.role}" + name "${action.name}" is not a declared landmark${route ? ` on ${route}` : ""}` };
      }
      const values = [action.name, "value" in action ? action.value : ""];
      if (values.some((value) => containsSecret(value, knownSecrets))) {
        return { ok: false, error: "action must not contain credentials or secrets" };
      }
      return { ok: true, action };
    }
  }
}
