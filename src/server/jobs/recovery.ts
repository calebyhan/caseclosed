import { asc, eq } from "drizzle-orm";
import { BROWSER_JOB_TYPES, SPEC_GENERATION_CALL_BUDGET, type JobType } from "../../contracts/lifecycle";
import { inTransaction, type Db } from "../db/client";
import { jobs, runs, sideEffects } from "../db/schema";
import { finalizeRun } from "../services/runs";
import { requeueJobInTx, settleJobInTx } from "./queue";

export type RecoveryReport = {
  requeued: string[];
  interruptedRuns: string[];
  settled: string[];
  failed: string[];
  unknownEffects: string[];
};

/**
 * Startup recovery. Must run before the worker claims anything (the worker
 * lock guarantees no other claimant is alive).
 *
 * - An in-flight send becomes `unknown` and must reconcile before delivery.
 * - An interrupted browser run is finalized under its existing run ID as
 *   INCONCLUSIVE/worker_interrupted; it is never resumed or silently rerun.
 * - Generation resumes only while its model-call budget remains.
 * - Other interrupted jobs return to pending with cumulative counts kept.
 */
export function recoverInterruptedJobs(db: Db, now: number = Date.now()): RecoveryReport {
  const report: RecoveryReport = { requeued: [], interruptedRuns: [], settled: [], failed: [], unknownEffects: [] };

  inTransaction(db, (tx) => {
    const recovered = tx
      .update(sideEffects)
      .set({ status: "unknown", lastError: "worker restarted while send was in flight", updatedAt: now })
      .where(eq(sideEffects.status, "sending"))
      .returning({ key: sideEffects.key })
      .all();
    report.unknownEffects.push(...recovered.map((row) => row.key));
  });

  const running = db.select().from(jobs).where(eq(jobs.status, "running")).orderBy(asc(jobs.seq)).all();
  for (const job of running) {
    const type = job.type as JobType;

    if (BROWSER_JOB_TYPES.has(type) && job.runId) {
      const run = db.select({ status: runs.status, result: runs.result }).from(runs).where(eq(runs.id, job.runId)).get();
      if (run?.status === "completed") {
        inTransaction(db, (tx) => settleJobInTx(tx, job.id, "completed", null, now));
        report.settled.push(job.id);
        continue;
      }
      const outcome = finalizeRun(
        db,
        {
          runId: job.runId,
          result: "INCONCLUSIVE",
          infraErrorReason: "worker_interrupted",
          job: { id: job.id, status: "failed", error: "worker_interrupted" },
        },
        now,
      );
      if (outcome.ok) {
        report.interruptedRuns.push(job.runId);
      } else {
        inTransaction(db, (tx) =>
          settleJobInTx(tx, job.id, "failed", `worker_interrupted; finalization rejected: ${outcome.rejection.reason}`, now),
        );
      }
      report.failed.push(job.id);
      continue;
    }

    if (type === "generate_spec" && job.modelCalls >= SPEC_GENERATION_CALL_BUDGET) {
      inTransaction(db, (tx) => settleJobInTx(tx, job.id, "failed", "spec generation call budget exhausted", now));
      report.failed.push(job.id);
      continue;
    }

    inTransaction(db, (tx) => requeueJobInTx(tx, job.id, now));
    report.requeued.push(job.id);
  }

  return report;
}
