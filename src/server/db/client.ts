import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Db = BetterSQLite3Database<Schema>;
export type Tx = SQLiteTransaction<"sync", Database.RunResult, Schema, ExtractTablesWithRelations<Schema>>;
/** Anything that can run queries: the root handle or an open transaction. */
export type Executor = Db | Tx;

export type DatabaseHandle = {
  db: Db;
  sqlite: Database.Database;
  close: () => void;
};

/** Kept below Slack's three-second acknowledgment budget. */
export const BUSY_TIMEOUT_MS = 1000;

export function openDatabase(databasePath: string): DatabaseHandle {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const sqlite = new Database(databasePath);
  sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
}

/**
 * Runs `work` in a short IMMEDIATE transaction so the write lock is taken up
 * front. Never perform network, browser, or model I/O inside `work`.
 */
export function inTransaction<T>(db: Db, work: (tx: Tx) => T): T {
  return db.transaction(work, { behavior: "immediate" });
}
