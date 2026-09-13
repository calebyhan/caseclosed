import { setTimeout as sleep } from "node:timers/promises";
import type { JobType } from "../../contracts/lifecycle";
import type { Db } from "../db/client";
import { claimNext, completeJob, failJob, type ClaimedJob } from "./queue";

export type JobContext = { db: Db; signal: AbortSignal };
export type JobHandler = (job: ClaimedJob, context: JobContext) => Promise<void>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;

export type WorkerOptions = {
  pollIntervalMs?: number;
  log?: (message: string) => void;
};

/**
 * Single-process worker. Jobs are processed strictly one at a time; only job
 * types with a registered handler are ever claimed.
 */
export class JobWorker {
  private readonly controller = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private loop: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly db: Db,
    private readonly handlers: JobHandlers,
    private readonly options: WorkerOptions = {},
  ) {}

  get handledTypes(): JobType[] {
    return (Object.keys(this.handlers) as JobType[]).filter((type) => this.handlers[type] !== undefined);
  }

  /** Claims and processes at most one job. Concurrent calls are serialized. */
  runOnce(): Promise<boolean> {
    const next = this.tail.then(() => this.processOne());
    this.tail = next.catch(() => undefined);
    return next;
  }

  start(): void {
    if (this.loop) return;
    const pollIntervalMs = this.options.pollIntervalMs ?? 500;
    this.loop = (async () => {
      while (!this.stopping) {
        const worked = await this.runOnce();
        if (!worked && !this.stopping) {
          await sleep(pollIntervalMs, undefined, { signal: this.controller.signal }).catch(() => undefined);
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.controller.abort();
    await this.loop;
    await this.tail;
  }

  private async processOne(): Promise<boolean> {
    if (this.stopping) return false;
    const job = claimNext(this.db, this.handledTypes);
    if (!job) return false;
    const handler = this.handlers[job.type]!;
    try {
      await handler(job, { db: this.db, signal: this.controller.signal });
      // No-op if the handler already settled the job inside its own atomic unit.
      completeJob(this.db, job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failJob(this.db, job.id, message);
      this.options.log?.(`job ${job.id} (${job.type}, key ${job.key}) failed: ${message}`);
    }
    return true;
  }
}
