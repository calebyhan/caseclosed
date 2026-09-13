import { loadAppContext } from "../app-context";
import { HttpStagingEnvironment } from "../browser/environment";
import { PlaywrightLauncher } from "../browser/playwright-session";
import { knownSecrets, type RuntimeConfig } from "../config";
import { GeminiModelClient } from "../model/client";
import { SpecGenerator } from "../model/generate-spec";
import { GeminiStepResolver } from "../model/resolve-step";
import { handleReproduceJob } from "../services/reproduction";
import { handleGenerateSpecJob } from "../services/spec-generation";
import type { JobHandlers } from "./worker";

// Concrete worker handlers. A handler is registered only when its
// dependencies are configured; unhandled job types stay pending, never claimed.

export type HandlerRegistration = { handlers: JobHandlers; disabled: string[] };

export function buildJobHandlers(config: RuntimeConfig, rootDir: string = process.cwd()): HandlerRegistration {
  const handlers: JobHandlers = {};
  const disabled: string[] = [];
  const appContext = loadAppContext(config.environmentId, rootDir);
  const secrets = knownSecrets(config);

  if (!config.gemini) {
    disabled.push("generate_spec, reproduce: GEMINI_API_KEY and GEMINI_MODEL are not configured");
    return { handlers, disabled };
  }
  const client = new GeminiModelClient(config.gemini.apiKey);
  const models = { primary: config.gemini.model, fallback: config.gemini.fallbackModel };

  const generator = new SpecGenerator(client, models);
  handlers.generate_spec = async (job, { db, signal }) => {
    await handleGenerateSpecJob(job, { db, generator, appContext, knownSecrets: secrets }, signal);
  };

  if (!config.stagingTestSecret) {
    disabled.push("reproduce: STAGING_TEST_SECRET is not configured");
  } else if (appContext.base_url.replace(/\/+$/, "") !== config.stagingBaseUrl.replace(/\/+$/, "")) {
    disabled.push(`reproduce: STAGING_BASE_URL ${config.stagingBaseUrl} does not match AppContext base_url ${appContext.base_url}`);
  } else {
    const environment = new HttpStagingEnvironment({ baseUrl: config.stagingBaseUrl, testSecret: config.stagingTestSecret });
    const launcher = new PlaywrightLauncher();
    const resolver = new GeminiStepResolver(client, models, secrets);
    handlers.reproduce = async (job, { db, signal }) => {
      await handleReproduceJob(job, { db, appContext, environment, launcher, resolver, artifactDir: config.artifactDir, knownSecrets: secrets }, signal);
    };
  }
  return { handlers, disabled };
}
