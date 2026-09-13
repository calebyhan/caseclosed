import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/server/config";
import { openMigratedDatabase } from "../src/server/db/migrate";
import { HttpStagingEnvironment } from "../src/server/browser/environment";

const ROOT = process.cwd();
const FIXTURE = "pro_monthly_customer";

function loadLocalEnvironment(): void {
  for (const file of [".env.local", ".env"]) {
    const absolute = path.join(ROOT, file);
    if (fs.existsSync(absolute)) process.loadEnvFile(absolute);
  }
}

function assertSafeLocalPath(target: string, label: string): void {
  const relative = path.relative(ROOT, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must resolve inside the repository for demo reset: ${target}`);
  }
}

async function assertBuggyStaging(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/health`, {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await response.json().catch(() => null)) as
    | { commit_sha?: unknown; variant?: unknown }
    | null;
  if (!response.ok) throw new Error(`staging health returned HTTP ${response.status}`);
  if (body?.variant !== "buggy") {
    throw new Error(`staging must report the buggy variant before reset (received ${JSON.stringify(body?.variant)})`);
  }
  if (typeof body.commit_sha !== "string" || !body.commit_sha.trim() || body.commit_sha === "unknown") {
    throw new Error("staging health did not report a concrete commit SHA");
  }
  console.log(`Staging ready: buggy @ ${body.commit_sha}`);
}

function resetDatabase(databasePath: string): void {
  const handle = openMigratedDatabase(databasePath);
  try {
    handle.sqlite.exec(`
      BEGIN IMMEDIATE;
      DELETE FROM rejected_events;
      DELETE FROM transitions;
      DELETE FROM jobs;
      DELETE FROM side_effects;
      DELETE FROM inbound_events;
      DELETE FROM external_links;
      DELETE FROM assertion_results;
      DELETE FROM browser_actions;
      DELETE FROM evidence;
      DELETE FROM resolved_plans;
      DELETE FROM runs;
      DELETE FROM fix_attempts;
      DELETE FROM repro_specs;
      DELETE FROM cases;
      UPDATE app_meta SET next_case_number = 42 WHERE id = 1;
      DELETE FROM sqlite_sequence WHERE name IN ('jobs', 'transitions', 'rejected_events');
      COMMIT;
    `);
  } catch (error) {
    if (handle.sqlite.inTransaction) handle.sqlite.exec("ROLLBACK");
    throw error;
  } finally {
    handle.close();
  }
}

async function main(): Promise<void> {
  if (process.env.CASECLOSED_DEMO_MODE !== "1") {
    throw new Error("Refusing to reset outside explicit demo mode. Run `npm run demo:reset`.");
  }
  loadLocalEnvironment();
  const config = loadConfig();
  if (!config.stagingTestSecret) {
    throw new Error("STAGING_TEST_SECRET is required; no local state was changed.");
  }
  if (config.databasePath === ":memory:") throw new Error("Demo reset requires a persistent database path.");
  assertSafeLocalPath(config.databasePath, "DATABASE_PATH");
  assertSafeLocalPath(config.artifactDir, "ARTIFACT_DIR");

  // Validate all remote prerequisites before changing canonical local state.
  await assertBuggyStaging(config.stagingBaseUrl);
  const staging = new HttpStagingEnvironment({
    baseUrl: config.stagingBaseUrl,
    testSecret: config.stagingTestSecret,
  });
  const fixture = await staging.resetFixture(FIXTURE);
  if (!fixture.ok) throw new Error(`Fixture reset failed: ${fixture.reason} (${fixture.detail})`);
  const session = await staging.createSession(FIXTURE);
  if (!session.ok) throw new Error(`Browser session readiness failed: ${session.reason} (${session.detail})`);

  resetDatabase(config.databasePath);
  fs.rmSync(config.artifactDir, { recursive: true, force: true });
  fs.mkdirSync(config.artifactDir, { recursive: true });

  console.log(`Fixture ready: ${FIXTURE}`);
  console.log(`Database reset: ${path.relative(ROOT, config.databasePath)} (next intake is CC-0042)`);
  console.log("Browser session ready: authenticated fixture session minted and verified");
  console.log("Demo reset complete. Start CaseClosed + worker, then submit the command in docs/DEMO.md.");
}

await main();
