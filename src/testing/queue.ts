import type { Db, JobRow } from "#db";
import { type JobInput, type createWorker, enqueueDeliveryJob } from "#queue";

/** Enqueue through the webhook's entry point; the delivery id must be fresh. */
export async function enqueueTestJob(db: Db, input: JobInput): Promise<JobRow> {
  const result = await enqueueDeliveryJob(db, input);
  if (!result.isNew) throw new Error(`delivery ${input.deliveryId} was already enqueued`);
  return result.job;
}

type Worker = ReturnType<typeof createWorker>;

/** Claim one job and wait for it to settle. False when nothing is due. */
export async function tick(worker: Worker): Promise<boolean> {
  const claimed = await worker.claim();
  if (!claimed) return false;
  await claimed.settled;
  return true;
}

/** Settle every job that is due now, one at a time, as the worker loop would. */
export async function drainQueue(worker: Worker): Promise<number> {
  let n = 0;
  while (await tick(worker)) n += 1;
  return n;
}
