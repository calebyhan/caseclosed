import fs from "node:fs";
import path from "node:path";
import { ConfigError, loadConfig } from "../src/server/config";

const ROOT = process.cwd();
for (const file of [".env.local", ".env"]) {
  const absolute = path.join(ROOT, file);
  if (fs.existsSync(absolute)) process.loadEnvFile(absolute);
}

let config: ReturnType<typeof loadConfig> | null = null;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.log("FAIL  Configuration is incomplete:");
  for (const issue of error.issues) console.log(`      ${issue}`);
}

const present = (key: string) => Boolean(process.env[key]?.trim());
const checks: Array<[string, string[]]> = [
  ["Gemini", ["GEMINI_API_KEY", "GEMINI_MODEL"]],
  ["Slack", ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"]],
  ["Linear", ["LINEAR_API_KEY", "LINEAR_TEAM_ID"]],
  ["GitHub", ["GITHUB_WEBHOOK_SECRET", "GITHUB_TOKEN", "GITHUB_REPOSITORY"]],
  ["Staging auth", ["STAGING_TEST_SECRET"]],
];

let failed = config === null;
for (const [name, keys] of checks) {
  const missing = keys.filter((key) => !present(key));
  const ready = missing.length === 0;
  console.log(`${ready ? "PASS" : "FAIL"}  ${name}${ready ? "" : ` — configure ${missing.join(" + ")}`}`);
  failed ||= !ready;
}

const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
let publicHttps = false;
try {
  publicHttps = new URL(publicBaseUrl).protocol === "https:";
} catch {
  // loadConfig reports the malformed URL above.
}
console.log(`${publicHttps ? "PASS" : "FAIL"}  Public callback URL${publicHttps ? ` — ${publicBaseUrl}` : " — PUBLIC_BASE_URL must be public HTTPS"}`);
failed ||= !publicHttps;

const stagingBaseUrl = process.env.STAGING_BASE_URL ?? "http://localhost:3001";
try {
  const response = await fetch(`${stagingBaseUrl.replace(/\/+$/, "")}/api/health`, {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const ready = response.ok && body?.variant === "buggy" && typeof body.commit_sha === "string" && body.commit_sha !== "unknown";
  console.log(`${ready ? "PASS" : "FAIL"}  Staging health — ${JSON.stringify(body)}`);
  failed ||= !ready;
} catch (error) {
  console.log(`FAIL  Staging health — ${error instanceof Error ? error.message : String(error)}`);
  failed = true;
}

if (failed) process.exitCode = 1;
