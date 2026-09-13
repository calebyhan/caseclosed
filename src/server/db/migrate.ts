import { randomUUID } from "node:crypto";
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDatabase, type DatabaseHandle, type Db } from "./client";
import { appMeta } from "./schema";

export const MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle");

export function migrateDatabase(handle: DatabaseHandle, migrationsFolder: string = MIGRATIONS_DIR): void {
  migrate(handle.db, { migrationsFolder });
  ensureAppMeta(handle.db);
}

/** Creates the singleton instance row once; never rotates an existing instance ID. */
function ensureAppMeta(db: Db): void {
  db.insert(appMeta)
    .values({ id: 1, instanceId: randomUUID(), nextCaseNumber: 1, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
}

export function openMigratedDatabase(databasePath: string, migrationsFolder?: string): DatabaseHandle {
  const handle = openDatabase(databasePath);
  try {
    migrateDatabase(handle, migrationsFolder);
  } catch (error) {
    handle.close();
    throw error;
  }
  return handle;
}
