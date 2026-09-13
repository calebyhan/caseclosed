import { acquireProcessLock, LockHeldError, type ProcessLock } from "../shared/process-lock";
import { loadConfig } from "./config";
import { openMigratedDatabase } from "./db/migrate";
import { recoverInterruptedJobs } from "./jobs/recovery";
import { JobWorker, type JobHandlers } from "./jobs/worker";

// Worker entry point (`npm run worker`). Never imported by Next.js routes.

const log = (message: string) => console.log(`[worker ${new Date().toISOString()}] ${message}`);

const config = loadConfig();
const handle = openMigratedDatabase(config.databasePath);

let lock: ProcessLock;
try {
  lock = acquireProcessLock(config.lockDir, "worker");
} catch (error) {
  handle.close();
  if (error instanceof LockHeldError) {
    console.error(`${error.message}. Only one CaseClosed worker may run; stop the other worker first.`);
    process.exit(1);
  }
  throw error;
}

const recovery = recoverInterruptedJobs(handle.db);
log(
  `recovery: ${recovery.requeued.length} requeued, ${recovery.interruptedRuns.length} interrupted run(s) finalized, ` +
    `${recovery.failed.length} failed, ${recovery.unknownEffects.length} effect(s) marked unknown`,
);

// Handlers for generate_spec, reproduce, verify and deliver_effect are
// registered by later phases. Unhandled job types stay pending, never claimed.
const handlers: JobHandlers = {};
const worker = new JobWorker(handle.db, handlers, { log });
worker.start();
log(`started on ${config.databasePath}; handling: ${worker.handledTypes.join(", ") || "(no handlers registered)"}`);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received; finishing current job`);
  await worker.stop();
  lock.release();
  handle.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
