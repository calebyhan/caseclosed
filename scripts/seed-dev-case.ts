import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { loadConfig } from "../src/server/config";
import { openMigratedDatabase } from "../src/server/db/migrate";
import { createCaseFromReport } from "../src/server/services/intake";
import { recordSpecCreated } from "../src/server/services/spec-lifecycle";

// Development-only: creates one case through the real intake and spec services
// so the case page has persisted data to render. It never sets statuses directly
// and must not be used against a demo or eval database.

const config = loadConfig();
const handle = openMigratedDatabase(config.databasePath);
try {
  const { caseId } = createCaseFromReport(handle.db, {
    source: { type: "slack", teamId: "T_DEV", channelId: "C_DEV", userId: "U_DEV", triggerId: `dev-${randomUUID()}` },
    report: "When I switch my Pro plan from monthly to annual and click Upgrade, it spins forever.",
    environmentId: "staging",
  });
  const appContext = JSON.parse(fs.readFileSync("config/environments/staging.json", "utf8"));
  const spec = { ...JSON.parse(fs.readFileSync("fixtures/repro-spec.valid.json", "utf8")), case_id: caseId };
  const outcome = recordSpecCreated(handle.db, { caseId, spec, appContext, modelId: null, generationModelCalls: 0 });
  if (!outcome.ok) throw new Error(`Spec transition rejected: ${outcome.rejection.reason}`);
  console.log(`Seeded ${caseId} (SPEC_CREATED): ${config.publicBaseUrl}/case/${caseId}`);
} finally {
  handle.close();
}
