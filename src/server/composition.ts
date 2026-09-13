import { loadConfig } from "./config";
import type { DatabaseHandle, Db } from "./db/client";
import { openMigratedDatabase } from "./db/migrate";

// Concrete server dependencies for Next.js route handlers and pages. Cached on
// globalThis so dev-mode module reloads reuse one SQLite connection.

const cache = globalThis as unknown as { __caseclosedDatabase?: DatabaseHandle };

export function getDatabase(): Db {
  if (!cache.__caseclosedDatabase) {
    cache.__caseclosedDatabase = openMigratedDatabase(loadConfig().databasePath);
  }
  return cache.__caseclosedDatabase.db;
}
