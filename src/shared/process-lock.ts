import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same-host exclusive lock via atomic directory creation. Used to refuse a
// second worker; the staging lock will reuse it. Not a distributed lease.

export type LockOwner = { pid: number; hostname: string; token: string; acquired_at: string };

export class LockHeldError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly owner: LockOwner | null,
  ) {
    super(
      owner
        ? `Lock ${lockPath} is held by pid ${owner.pid} on ${owner.hostname} since ${owner.acquired_at}`
        : `Lock ${lockPath} is held by an unidentified owner`,
    );
    this.name = "LockHeldError";
  }
}

export type ProcessLock = { lockPath: string; owner: LockOwner; release: () => void };

export type LockOptions = {
  isProcessAlive?: (pid: number) => boolean;
  /** An owner file still being written is treated as held for this long. */
  ownerlessGraceMs?: number;
  /** Test seam invoked after a stale owner is observed, before atomic reclamation. */
  onStaleObserved?: () => void;
};

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as LockOwner;
  } catch {
    return null;
  }
}

export function acquireProcessLock(lockDir: string, name: string, options: LockOptions = {}): ProcessLock {
  const alive = options.isProcessAlive ?? isProcessAlive;
  const graceMs = options.ownerlessGraceMs ?? 5_000;
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${name}.lock`);
  const owner: LockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    token: randomUUID(),
    acquired_at: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const inspected = fs.statSync(lockPath);
      const current = readOwner(lockPath);
      if (current === null) {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (ageMs < graceMs) throw new LockHeldError(lockPath, null);
      } else if (current.hostname !== owner.hostname || alive(current.pid)) {
        // Liveness can only be checked on this host; a foreign owner is always respected.
        throw new LockHeldError(lockPath, current);
      }
      options.onStaleObserved?.();
      // Never remove the path we inspected in place. Another contender could
      // replace it between the liveness check and rmSync, causing us to delete
      // that contender's live lock and admit two workers. Atomic rename makes
      // exactly one contender the owner of the stale directory.
      const stalePath = `${lockPath}.stale-${owner.token}`;
      try {
        fs.renameSync(lockPath, stalePath);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw renameError;
      }
      const moved = fs.statSync(stalePath);
      if (moved.dev !== inspected.dev || moved.ino !== inspected.ino) {
        // We moved a replacement created after our stale-owner check. Put it
        // back when possible and fail closed; it is a live contender's lock.
        try {
          fs.renameSync(stalePath, lockPath);
        } catch {
          // Another contender already owns the canonical path. Preserve the
          // moved lock for diagnosis rather than deleting a possibly live one.
        }
        throw new LockHeldError(lockPath, readOwner(lockPath) ?? readOwner(stalePath));
      }
      fs.rmSync(stalePath, { recursive: true, force: true });
      continue;
    }
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner));
    return {
      lockPath,
      owner,
      release: () => {
        if (readOwner(lockPath)?.token === owner.token) {
          fs.rmSync(lockPath, { recursive: true, force: true });
        }
      },
    };
  }
  throw new LockHeldError(lockPath, readOwner(lockPath));
}
