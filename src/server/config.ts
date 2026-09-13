import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_PATH: z.string().min(1).default("var/caseclosed.sqlite"),
  ARTIFACT_DIR: z.string().min(1).default("var/artifacts"),
  LOCK_DIR: z.string().min(1).default("var/locks"),
  PUBLIC_BASE_URL: z.url().default("http://localhost:3000"),
  STAGING_BASE_URL: z.url().default("http://localhost:3001"),
  STAGING_TEST_SECRET: z.string().min(16, "must be at least 16 characters").optional(),
  ENVIRONMENT_ID: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).default("staging"),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).optional(),
  GEMINI_FALLBACK_MODEL: z.string().min(1).optional(),
});

export type GeminiConfig = { apiKey: string; model: string; fallbackModel: string | null };

export type RuntimeConfig = {
  databasePath: string;
  artifactDir: string;
  lockDir: string;
  publicBaseUrl: string;
  stagingBaseUrl: string;
  stagingTestSecret: string | null;
  environmentId: string;
  /** Null until both GEMINI_API_KEY and GEMINI_MODEL are set; no model ID is ever assumed. */
  gemini: GeminiConfig | null;
};

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid CaseClosed configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/**
 * Validates runtime configuration. Relative paths resolve against `rootDir`
 * so the API and the worker always share one absolute database path.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  rootDir: string = process.cwd(),
): RuntimeConfig {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ""));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  const values = parsed.data;
  if (values.GEMINI_API_KEY && !values.GEMINI_MODEL) {
    throw new ConfigError(["GEMINI_MODEL: required when GEMINI_API_KEY is set (use a model ID verified against your key)"]);
  }
  const resolve = (value: string) => (path.isAbsolute(value) ? value : path.resolve(rootDir, value));
  return {
    databasePath: values.DATABASE_PATH === ":memory:" ? ":memory:" : resolve(values.DATABASE_PATH),
    artifactDir: resolve(values.ARTIFACT_DIR),
    lockDir: resolve(values.LOCK_DIR),
    publicBaseUrl: values.PUBLIC_BASE_URL.replace(/\/+$/, ""),
    stagingBaseUrl: values.STAGING_BASE_URL.replace(/\/+$/, ""),
    stagingTestSecret: values.STAGING_TEST_SECRET ?? null,
    environmentId: values.ENVIRONMENT_ID,
    gemini:
      values.GEMINI_API_KEY && values.GEMINI_MODEL
        ? { apiKey: values.GEMINI_API_KEY, model: values.GEMINI_MODEL, fallbackModel: values.GEMINI_FALLBACK_MODEL ?? null }
        : null,
  };
}

/** Configured secret values that must never reach prompts, evidence, or logs. */
export function knownSecrets(config: RuntimeConfig): string[] {
  return [config.stagingTestSecret, config.gemini?.apiKey].filter((secret): secret is string => Boolean(secret));
}
