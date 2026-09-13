import { z } from "zod";

// Shapes frozen in docs/CONTRACTS.md §1–§4. Semantic validation beyond the
// schema (validateReproSpec) belongs to the verdict-engine milestone.

const HttpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const AppContext = z.object({
  environment_id: z.string().min(1),
  base_url: z.url(),
  routes: z
    .array(z.object({ path: z.string().startsWith("/"), name: z.string(), description: z.string() }))
    .min(1),
  api_endpoints: z.array(
    z.object({ method: HttpMethod, path: z.string().startsWith("/"), description: z.string() }),
  ),
  landmarks: z.array(
    z.object({
      route: z.string().startsWith("/"),
      role: z.string(),
      name: z.string(),
      description: z.string(),
    }),
  ),
  fixtures: z.array(z.object({ id: z.string(), description: z.string() })).min(1),
});
export type AppContext = z.infer<typeof AppContext>;

const withinMs = z.number().int().min(100).max(10_000).default(5_000);

export const Assertion = z.discriminatedUnion("type", [
  z.object({ id: z.string(), type: z.literal("element_visible"), role: z.string(), name: z.string(), within_ms: withinMs }),
  z.object({ id: z.string(), type: z.literal("element_not_visible"), role: z.string(), name: z.string(), within_ms: withinMs }),
  z.object({ id: z.string(), type: z.literal("url_contains"), value: z.string(), within_ms: withinMs }),
  z.object({
    id: z.string(),
    type: z.literal("network_status"),
    method: HttpMethod,
    url_contains: z.string(),
    min: z.number().int().min(100).max(599),
    max: z.number().int().min(100).max(599),
  }),
  z.object({ id: z.string(), type: z.literal("text_visible"), value: z.string(), within_ms: withinMs }),
]);
export type Assertion = z.infer<typeof Assertion>;

export const FailureSignal = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("network_status"),
    method: HttpMethod,
    url_contains: z.string(),
    min: z.number().int().min(100).max(599),
    max: z.number().int().min(100).max(599),
  }),
  z.object({
    id: z.string(),
    type: z.literal("element_still_visible_after_ms"),
    role: z.string(),
    name: z.string(),
    after_ms: z.number().int().min(500).max(3_000),
  }),
  z.object({ id: z.string(), type: z.literal("text_visible"), value: z.string(), within_ms: withinMs }),
]);
export type FailureSignal = z.infer<typeof FailureSignal>;

export const ReproSpec = z.object({
  version: z.literal("1"),
  case_id: z.string(),
  app_context_hash: z.string(),
  environment: z.object({
    id: z.string(),
    start_path: z.string().startsWith("/"),
    fixture: z.string(),
  }),
  goal: z.string().min(1),
  steps: z.array(z.object({ id: z.string(), intent: z.string().min(1) })).min(1),
  assertions: z.array(Assertion).min(1),
  failure_signals: z.array(FailureSignal).min(1),
  evidence: z.object({
    screenshots: z.boolean().default(true),
    network: z.boolean().default(true),
    console: z.boolean().default(true),
    actions: z.boolean().default(true),
  }),
});
export type ReproSpec = z.infer<typeof ReproSpec>;

export const SpecGenerationResult = z
  .object({
    sufficient: z.boolean(),
    missing: z.array(z.string()),
    spec: ReproSpec.nullable(),
  })
  .refine((value) => value.sufficient === (value.spec !== null), {
    message: "sufficient must be true exactly when spec is present",
  });
export type SpecGenerationResult = z.infer<typeof SpecGenerationResult>;

export const BrowserAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"), path: z.string().startsWith("/") }),
  z.object({ type: z.literal("click"), role: z.string(), name: z.string() }),
  z.object({ type: z.literal("fill"), role: z.string(), name: z.string(), value: z.string() }),
  z.object({ type: z.literal("select"), role: z.string(), name: z.string(), value: z.string() }),
  z.object({ type: z.literal("wait"), milliseconds: z.number().int().min(100).max(5_000) }),
  z.object({ type: z.literal("finish"), reason: z.string() }),
]);
export type BrowserAction = z.infer<typeof BrowserAction>;

export const ResolvedPlan = z.object({
  case_id: z.string(),
  spec_version: z.literal("1"),
  actions: z.array(z.object({ step_id: z.string(), action: BrowserAction })).min(1),
});
export type ResolvedPlan = z.infer<typeof ResolvedPlan>;
