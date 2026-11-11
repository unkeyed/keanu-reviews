import type { Db, JobRow } from "#db";
import { type JobInput, enqueueDeliveryJob } from "#queue";

/** Enqueue through the webhook's entry point; the delivery id must be fresh. */
export async function enqueueTestJob(db: Db, input: JobInput): Promise<JobRow> {
  const result = await enqueueDeliveryJob(db, input);
  if (!result.isNew) throw new Error(`delivery ${input.deliveryId} was already enqueued`);
  return result.job;
}

/** Settle every job that is due now, one at a time, as the worker loop would. */
export async function drainQueue(worker: { tick: () => Promise<boolean> }): Promise<number> {
  let n = 0;
  while (await worker.tick()) n += 1;
  return n;
}
