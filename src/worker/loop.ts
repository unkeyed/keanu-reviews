import type { Db } from "../db/client.ts";
import { claimNextJob, completeJob, failJob } from "../db/repositories/jobs.ts";
import type { Logger } from "../logger.ts";
import type { Router } from "./router.ts";

export interface WorkerDeps {
  db: Db;
  logger: Logger;
  router: Router;
}

/**
 * Async job worker (KTD3). Claims one leased job at a time (KTD10) and routes it;
 * on success the raw payload is purged (KTD13), on failure the job is marked
 * failed. Returns true if a job was processed, false when the queue is empty.
 */
export function createWorker(deps: WorkerDeps) {
  const tick = async (): Promise<boolean> => {
    const job = await claimNextJob(deps.db);
    if (!job) return false;
    try {
      await deps.router(job);
      await completeJob(deps.db, job.id);
    } catch (err) {
      deps.logger.error("job failed", {
        jobId: job.id,
        event: job.event,
        err: err instanceof Error ? err.message : String(err),
      });
      await failJob(deps.db, job.id);
    }
    return true;
  };

  /** Drain the queue until empty (used by tests and the smoke path). */
  const drain = async (): Promise<number> => {
    let n = 0;
    while (await tick()) n += 1;
    return n;
  };

  return { tick, drain };
}
