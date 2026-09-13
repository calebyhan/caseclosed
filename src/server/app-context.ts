import fs from "node:fs";
import path from "node:path";
import { AppContext } from "../contracts/repro";

const ENVIRONMENT_ID = /^[a-z0-9][a-z0-9_-]*$/;

/** Loads the checked-in, non-secret AppContext for an environment. */
export function loadAppContext(environmentId: string, rootDir: string = process.cwd()): AppContext {
  if (!ENVIRONMENT_ID.test(environmentId)) throw new Error(`Invalid environment id: ${JSON.stringify(environmentId)}`);
  const file = path.join(rootDir, "config", "environments", `${environmentId}.json`);
  const context = AppContext.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (context.environment_id !== environmentId) {
    throw new Error(`${file} declares environment_id ${context.environment_id}, expected ${environmentId}`);
  }
  return context;
}
