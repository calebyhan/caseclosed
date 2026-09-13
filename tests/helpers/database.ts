import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseHandle } from "../../src/server/db/client";
import { openMigratedDatabase } from "../../src/server/db/migrate";

export type TestDatabase = {
  dir: string;
  path: string;
  readonly handle: DatabaseHandle;
  /** Closes and reopens the same file, simulating a process restart. */
  reopen: () => DatabaseHandle;
  cleanup: () => void;
};

/** A real, migrated, file-backed SQLite database in a temporary directory. */
export function createTestDatabase(): TestDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caseclosed-test-"));
  const dbPath = path.join(dir, "caseclosed.sqlite");
  let handle = openMigratedDatabase(dbPath);
  return {
    dir,
    path: dbPath,
    get handle() {
      return handle;
    },
    reopen() {
      handle.close();
      handle = openMigratedDatabase(dbPath);
      return handle;
    },
    cleanup() {
      handle.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
