// Flattened JSON Schemas sent to the model (docs/CONTRACTS.md §3 mitigation):
// one object per list item with a `type` enum and the superset of fields.
// Generation is loosely constrained; strict Zod validation stays authoritative.
// The model never supplies identity (case ID, hashes, environment ID, version).

export const ASSERTION_FIELDS = {
  element_visible: ["role", "name", "within_ms"],
  element_not_visible: ["role", "name", "within_ms"],
  url_contains: ["value", "within_ms"],
  network_status: ["method", "url_contains", "min", "max"],
  text_visible: ["value", "within_ms"],
} as const satisfies Record<string, readonly string[]>;

export const SIGNAL_FIELDS = {
  network_status: ["method", "url_contains", "min", "max"],
  element_still_visible_after_ms: ["role", "name", "after_ms"],
  text_visible: ["value", "within_ms"],
} as const satisfies Record<string, readonly string[]>;

function flatCheck(types: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: { type: "string" },
      type: { type: "string", enum: [...types] },
      role: { type: "string" },
      name: { type: "string" },
      value: { type: "string" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      url_contains: { type: "string" },
      min: { type: "integer" },
      max: { type: "integer" },
      within_ms: { type: "integer" },
      after_ms: { type: "integer" },
    },
    required: ["id", "type"],
  };
}

export const SPEC_GENERATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    sufficient: { type: "boolean" },
    missing: { type: "array", items: { type: "string" } },
    spec: {
      type: "object",
      description: "Omit when sufficient is false.",
      properties: {
        start_path: { type: "string" },
        fixture: { type: "string" },
        goal: { type: "string" },
        steps: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" }, intent: { type: "string" } }, required: ["id", "intent"] },
        },
        assertions: { type: "array", items: flatCheck(Object.keys(ASSERTION_FIELDS)) },
        failure_signals: { type: "array", items: flatCheck(Object.keys(SIGNAL_FIELDS)) },
      },
      required: ["start_path", "fixture", "goal", "steps", "assertions", "failure_signals"],
    },
  },
  required: ["sufficient", "missing"],
};

export const BROWSER_ACTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["goto", "click", "fill", "select", "wait"] },
    path: { type: "string" },
    role: { type: "string" },
    name: { type: "string" },
    value: { type: "string" },
    milliseconds: { type: "integer" },
  },
  required: ["type"],
};
