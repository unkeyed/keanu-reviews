import type { Db, JobRow } from "#db";
import { type JobInput, type createWorker, enqueueDeliveryJob } from "#queue";

export async function enqueueTestJob(db: Db, input: JobInput): Promise<JobRow> {
  const result = await enqueueDeliveryJob(db, input);
  if (!result.isNew) throw new Error(`delivery ${input.deliveryId} was already enqueued`);
  return result.job;
}

type Worker = ReturnType<typeof createWorker>;

export async function tick(worker: Worker): Promise<boolean> {
  const claimed = await worker.claim();
  if (!claimed) return false;
  await claimed.settled;
  return true;
}

export async function drainQueue(worker: Worker): Promise<number> {
  let n = 0;
  while (await tick(worker)) n += 1;
  return n;
}
