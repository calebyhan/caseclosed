import { loadConfig } from "../src/server/config";
import { openMigratedDatabase } from "../src/server/db/migrate";
import { appMeta } from "../src/server/db/schema";

const config = loadConfig();
const handle = openMigratedDatabase(config.databasePath);
const meta = handle.db.select().from(appMeta).get();
console.log(`Migrated ${config.databasePath} (instance ${meta?.instanceId})`);
handle.close();
