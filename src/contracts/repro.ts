import { z } from "zod";

// Shapes frozen in docs/CONTRACTS.md §1–§4. Semantic validation beyond the
// schema (validateReproSpec) belongs to the verdict-engine milestone.

const HttpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const AppPath = z.string().min(1).max(500).refine(
  (value) =>
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[\\\s@]|:\/\/|\/\.\.?(?:\/|$)|%2e%2e|%2f|%5c/i.test(value),
  "must be a safe same-origin path",
);

const BaseUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    !url.username &&
    !url.password &&
    (url.pathname === "/" || url.pathname === "") &&
    !url.search &&
    !url.hash
  );
}, "must be an HTTP(S) origin without credentials, path, query, or fragment");

export const AppContext = z.strictObject({
  environment_id: z.string().min(1),
  base_url: BaseUrl,
  routes: z
    .array(z.strictObject({ path: AppPath, name: z.string(), description: z.string() }))
    .min(1),
  api_endpoints: z.array(
    z.strictObject({ method: HttpMethod, path: AppPath, description: z.string() }),
  ),
  landmarks: z.array(
    z.strictObject({
      route: AppPath,
      role: z.string(),
      name: z.string(),
      description: z.string(),
    }),
  ),
  fixtures: z.array(z.strictObject({ id: z.string(), description: z.string() })).min(1),
}).superRefine((context, refinement) => {
  const duplicate = (values: string[], path: (string | number)[], label: string) => {
    if (new Set(values).size !== values.length) refinement.addIssue({ code: "custom", path, message: `${label} entries must be unique` });
  };
  duplicate(context.routes.map((route) => route.path), ["routes"], "route path");
  duplicate(context.fixtures.map((fixture) => fixture.id), ["fixtures"], "fixture id");
  duplicate(context.api_endpoints.map((endpoint) => `${endpoint.method}:${endpoint.path}`), ["api_endpoints"], "endpoint");
  duplicate(context.landmarks.map((landmark) => `${landmark.route}:${landmark.role}:${landmark.name}`), ["landmarks"], "landmark");
  const routes = new Set(context.routes.map((route) => route.path));
  for (const [index, landmark] of context.landmarks.entries()) {
    if (!routes.has(landmark.route)) {
      refinement.addIssue({ code: "custom", path: ["landmarks", index, "route"], message: "must reference a declared route" });
    }
  }
});
export type AppContext = z.infer<typeof AppContext>;

const withinMs = z.number().int().min(100).max(10_000).default(5_000);

export const Assertion = z.discriminatedUnion("type", [
  z.strictObject({ id: z.string(), type: z.literal("element_visible"), role: z.string(), name: z.string(), within_ms: withinMs }),
  z.strictObject({ id: z.string(), type: z.literal("element_not_visible"), role: z.string(), name: z.string(), within_ms: withinMs }),
  z.strictObject({ id: z.string(), type: z.literal("url_contains"), value: z.string(), within_ms: withinMs }),
  z.strictObject({
    id: z.string(),
    type: z.literal("network_status"),
    method: HttpMethod,
    url_contains: z.string(),
    min: z.number().int().min(100).max(599),
    max: z.number().int().min(100).max(599),
  }),
  z.strictObject({ id: z.string(), type: z.literal("text_visible"), value: z.string(), within_ms: withinMs }),
]);
export type Assertion = z.infer<typeof Assertion>;

export const FailureSignal = z.discriminatedUnion("type", [
  z.strictObject({
    id: z.string(),
    type: z.literal("network_status"),
    method: HttpMethod,
    url_contains: z.string(),
    min: z.number().int().min(100).max(599),
    max: z.number().int().min(100).max(599),
  }),
  z.strictObject({
    id: z.string(),
    type: z.literal("element_still_visible_after_ms"),
    role: z.string(),
    name: z.string(),
    after_ms: z.number().int().min(500).max(3_000),
  }),
  z.strictObject({ id: z.string(), type: z.literal("text_visible"), value: z.string(), within_ms: withinMs }),
]);
export type FailureSignal = z.infer<typeof FailureSignal>;

export const ReproSpec = z.strictObject({
  version: z.literal("1"),
  case_id: z.string(),
  app_context_hash: z.string(),
  environment: z.strictObject({
    id: z.string(),
    start_path: AppPath,
    fixture: z.string(),
  }),
  goal: z.string().min(1),
  steps: z.array(z.strictObject({ id: z.string(), intent: z.string().min(1) })).min(1),
  assertions: z.array(Assertion).min(1),
  failure_signals: z.array(FailureSignal).min(1),
  evidence: z.strictObject({
    screenshots: z.boolean().default(true),
    network: z.boolean().default(true),
    console: z.boolean().default(true),
    actions: z.boolean().default(true),
  }),
});
export type ReproSpec = z.infer<typeof ReproSpec>;

export const SpecGenerationResult = z
  .strictObject({
    sufficient: z.boolean(),
    missing: z.array(z.string()),
    spec: ReproSpec.nullable(),
  })
  .refine((value) => value.sufficient === (value.spec !== null), {
    message: "sufficient must be true exactly when spec is present",
  });
export type SpecGenerationResult = z.infer<typeof SpecGenerationResult>;

/** ARIA roles an element-targeting action or check may name (Playwright getByRole). */
export const SUPPORTED_ROLES = [
  "alert", "button", "checkbox", "combobox", "dialog", "heading", "img", "link", "listbox",
  "menuitem", "option", "radio", "region", "searchbox", "spinbutton", "status", "switch",
  "tab", "textbox",
] as const;
export const SupportedRole = z.enum(SUPPORTED_ROLES);

const elementTarget = {
  role: z.string().min(1),
  name: z.string().min(1),
};

export const BrowserAction = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("goto"), path: AppPath }),
  z.strictObject({ type: z.literal("click"), ...elementTarget }),
  z.strictObject({ type: z.literal("fill"), ...elementTarget, value: z.string() }),
  z.strictObject({ type: z.literal("select"), ...elementTarget, value: z.string() }),
  z.strictObject({ type: z.literal("wait"), milliseconds: z.number().int().min(100).max(5_000) }),
  // Reserved for compatibility; rejected by step resolution in the MVP.
  z.strictObject({ type: z.literal("finish"), reason: z.string() }),
]);
export type BrowserAction = z.infer<typeof BrowserAction>;

export const ResolvedPlan = z.strictObject({
  case_id: z.string(),
  spec_version: z.literal("1"),
  actions: z.array(z.strictObject({ step_id: z.string(), action: BrowserAction })).min(1),
});
export type ResolvedPlan = z.infer<typeof ResolvedPlan>;
