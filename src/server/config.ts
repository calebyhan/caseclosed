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
  SLACK_BOT_TOKEN: z.string().min(1).optional(),
  SLACK_SIGNING_SECRET: z.string().min(1).optional(),
  SLACK_BASE_URL: z.url().default("https://slack.com/api"),
  LINEAR_API_KEY: z.string().min(1).optional(),
  LINEAR_TEAM_ID: z.string().min(1).optional(),
  LINEAR_BASE_URL: z.url().default("https://api.linear.app/graphql"),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  GITHUB_TOKEN: z.string().min(1).optional(),
  GITHUB_REPOSITORY: z.string().regex(/^[^/\s]+\/[^/\s]+$/).optional(),
  GITHUB_DEFAULT_BRANCH: z.string().min(1).default("main"),
  GITHUB_BASE_URL: z.url().default("https://api.github.com"),
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
  slack: { botToken: string; signingSecret: string; baseUrl: string } | null;
  linear: { apiKey: string; teamId: string; baseUrl: string } | null;
  github: { webhookSecret: string; token: string; repository: string; defaultBranch: string; baseUrl: string } | null;
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
  const paired = (
    name: string,
    entries: Array<[string, string | undefined]>,
  ) => {
    const some = entries.some(([, value]) => value);
    const all = entries.every(([, value]) => value);
    if (some && !all) throw new ConfigError([`${name}: configure ${entries.map(([key]) => key).join(", ")} together`]);
  };
  paired("Slack", [["SLACK_BOT_TOKEN", values.SLACK_BOT_TOKEN], ["SLACK_SIGNING_SECRET", values.SLACK_SIGNING_SECRET]]);
  paired("Linear", [["LINEAR_API_KEY", values.LINEAR_API_KEY], ["LINEAR_TEAM_ID", values.LINEAR_TEAM_ID]]);
  // GitHub Actions always injects GITHUB_REPOSITORY. That value alone must
  // not make an otherwise unconfigured CaseClosed integration invalid.
  if ((values.GITHUB_WEBHOOK_SECRET || values.GITHUB_TOKEN) &&
      !(values.GITHUB_WEBHOOK_SECRET && values.GITHUB_TOKEN && values.GITHUB_REPOSITORY)) {
    throw new ConfigError(["GitHub: configure GITHUB_WEBHOOK_SECRET, GITHUB_TOKEN, GITHUB_REPOSITORY together"]);
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
    slack: values.SLACK_BOT_TOKEN && values.SLACK_SIGNING_SECRET
      ? { botToken: values.SLACK_BOT_TOKEN, signingSecret: values.SLACK_SIGNING_SECRET, baseUrl: values.SLACK_BASE_URL.replace(/\/+$/, "") }
      : null,
    linear: values.LINEAR_API_KEY && values.LINEAR_TEAM_ID
      ? { apiKey: values.LINEAR_API_KEY, teamId: values.LINEAR_TEAM_ID, baseUrl: values.LINEAR_BASE_URL.replace(/\/+$/, "") }
      : null,
    github: values.GITHUB_WEBHOOK_SECRET && values.GITHUB_TOKEN && values.GITHUB_REPOSITORY
      ? {
          webhookSecret: values.GITHUB_WEBHOOK_SECRET,
          token: values.GITHUB_TOKEN,
          repository: values.GITHUB_REPOSITORY,
          defaultBranch: values.GITHUB_DEFAULT_BRANCH,
          baseUrl: values.GITHUB_BASE_URL.replace(/\/+$/, ""),
        }
      : null,
  };
}

/** Configured secret values that must never reach prompts, evidence, or logs. */
export function knownSecrets(config: RuntimeConfig): string[] {
  return [
    config.stagingTestSecret,
    config.gemini?.apiKey,
    config.slack?.botToken,
    config.slack?.signingSecret,
    config.linear?.apiKey,
    config.github?.token,
    config.github?.webhookSecret,
  ].filter((secret): secret is string => Boolean(secret));
}
