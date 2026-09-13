import { loadAppContext } from "../app-context";
import { HttpStagingEnvironment } from "../browser/environment";
import { PlaywrightLauncher } from "../browser/playwright-session";
import { knownSecrets, type RuntimeConfig } from "../config";
import { GeminiModelClient } from "../model/client";
import { SpecGenerator } from "../model/generate-spec";
import { GeminiStepResolver } from "../model/resolve-step";
import { handleReproduceJob } from "../services/reproduction";
import { handleGenerateSpecJob } from "../services/spec-generation";
import { handleVerifyJob } from "../services/verification";
import { handleDeliverEffectJob } from "../services/external-delivery";
import { SlackEffectAdapter } from "../integrations/slack";
import { LinearAdapter } from "../integrations/linear";
import { GitHubAdapter } from "../integrations/github";
import type { JobHandlers } from "./worker";

// Concrete worker handlers. A handler is registered only when its
// dependencies are configured; unhandled job types stay pending, never claimed.

export type HandlerRegistration = { handlers: JobHandlers; disabled: string[] };

export function buildJobHandlers(config: RuntimeConfig, rootDir: string = process.cwd()): HandlerRegistration {
  const handlers: JobHandlers = {};
  const disabled: string[] = [];
  const appContext = loadAppContext(config.environmentId, rootDir);
  const secrets = knownSecrets(config);

  let client: GeminiModelClient | null = null;
  let models: { primary: string; fallback: string | null } | null = null;
  if (config.gemini) {
    client = new GeminiModelClient(config.gemini.apiKey);
    models = { primary: config.gemini.model, fallback: config.gemini.fallbackModel };
    const generator = new SpecGenerator(client, models);
    handlers.generate_spec = async (job, { db, signal }) => {
      await handleGenerateSpecJob(job, { db, generator, appContext, knownSecrets: secrets }, signal);
    };
  } else {
    disabled.push("generate_spec, reproduce: GEMINI_API_KEY and GEMINI_MODEL are not configured");
  }

  if (!config.stagingTestSecret) {
    disabled.push("reproduce: STAGING_TEST_SECRET is not configured");
  } else if (appContext.base_url.replace(/\/+$/, "") !== config.stagingBaseUrl.replace(/\/+$/, "")) {
    disabled.push(`reproduce: STAGING_BASE_URL ${config.stagingBaseUrl} does not match AppContext base_url ${appContext.base_url}`);
  } else {
    const environment = new HttpStagingEnvironment({ baseUrl: config.stagingBaseUrl, testSecret: config.stagingTestSecret });
    const launcher = new PlaywrightLauncher();
    if (client && models) {
      const resolver = new GeminiStepResolver(client, models, secrets);
      handlers.reproduce = async (job, { db, signal }) => {
        await handleReproduceJob(job, { db, appContext, environment, launcher, resolver, artifactDir: config.artifactDir, knownSecrets: secrets }, signal);
      };
    }
    handlers.verify = async (job, { db, signal }) => {
      await handleVerifyJob(job, { db, appContext, environment, launcher, artifactDir: config.artifactDir, knownSecrets: secrets }, signal);
    };
  }

  if (!config.slack && !config.linear && !config.github) {
    disabled.push("deliver_effect: no Slack, Linear, or GitHub credentials are configured");
  } else {
    handlers.deliver_effect = async (job, { db }) => {
      const slack = config.slack ? new SlackEffectAdapter(db, { ...config.slack, publicBaseUrl: config.publicBaseUrl }) : null;
      const linear = config.linear ? new LinearAdapter({ ...config.linear, publicBaseUrl: config.publicBaseUrl }, db) : null;
      const github = config.github ? new GitHubAdapter({ token: config.github.token, baseUrl: config.github.baseUrl, publicBaseUrl: config.publicBaseUrl }) : null;
      await handleDeliverEffectJob(job, db, {
        forType: (type) => type.startsWith("slack.") ? slack : type.startsWith("linear.") ? linear : type.startsWith("github.") ? github : null,
      });
    };
  }
  return { handlers, disabled };
}
