import type { Db } from "../client.ts";
import { processedDeliveries } from "../schema.ts";

/**
 * Record a webhook delivery id for dedupe (KTD4). Returns true if this delivery
 * was newly recorded, false if it was already seen (a retry or redelivery — the
 * same GUID is reused, so this catches both).
 */
export async function markDeliverySeen(db: Db, deliveryId: string): Promise<boolean> {
  const inserted = await db
    .insert(processedDeliveries)
    .values({ deliveryId })
    .onConflictDoNothing({ target: processedDeliveries.deliveryId })
    .returning();
  return inserted.length > 0;
}
