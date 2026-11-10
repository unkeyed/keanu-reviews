import type { Db, JobRow } from "#db";
import { type JobInput, enqueueDeliveryJob } from "#queue";

/** Enqueue through the webhook's entry point; the delivery id must be fresh. */
export async function enqueueTestJob(db: Db, input: JobInput): Promise<JobRow> {
  const result = await enqueueDeliveryJob(db, input);
  if (!result.isNew) throw new Error(`delivery ${input.deliveryId} was already enqueued`);
  return result.job;
}
