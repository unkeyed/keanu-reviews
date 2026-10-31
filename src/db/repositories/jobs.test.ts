import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client.ts";
import { jobs, processedDeliveries } from "../schema.ts";
import { createTestDb } from "../testDb.ts";
import { enqueueDeliveryJob, pruneJobHistory } from "./jobs.ts";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
});
afterEach(() => close());

const DAY_MS = 24 * 60 * 60_000;
const now = new Date("2026-10-29T08:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);

async function delivery(
  deliveryId: string,
  status: "pending" | "done" | "failed",
  ageDays: number,
): Promise<void> {
  await enqueueDeliveryJob(db, { deliveryId, event: "pull_request", action: "opened", raw: {} });
  await db
    .update(jobs)
    .set({ status, availableAt: daysAgo(ageDays), createdAt: daysAgo(ageDays) })
    .where(eq(jobs.id, deliveryId));
  await db
    .update(processedDeliveries)
    .set({ seenAt: daysAgo(ageDays) })
    .where(eq(processedDeliveries.deliveryId, deliveryId));
}

describe("pruneJobHistory", () => {
  it("drops done jobs and their markers past retention, keeping failed, pending, and recent ones", async () => {
    await delivery("old-done", "done", 20);
    await delivery("recent-done", "done", 3);
    await delivery("old-failed", "failed", 20);
    await delivery("old-pending", "pending", 20);
    await db.insert(processedDeliveries).values({ deliveryId: "old-orphan", seenAt: daysAgo(20) });

    expect(await pruneJobHistory(db, daysAgo(14))).toEqual({ jobs: 1, deliveries: 2 });

    const jobIds = (await db.select({ id: jobs.id }).from(jobs)).map((r) => r.id).sort();
    expect(jobIds).toEqual(["old-failed", "old-pending", "recent-done"]);
    const markers = (await db.select().from(processedDeliveries)).map((r) => r.deliveryId).sort();
    expect(markers).toEqual(["old-failed", "old-pending", "recent-done"]);
  });

  it("still rejects a redelivery of a failed job kept past retention", async () => {
    await delivery("old-failed", "failed", 20);

    await pruneJobHistory(db, daysAgo(14));

    expect(
      await enqueueDeliveryJob(db, {
        deliveryId: "old-failed",
        event: "pull_request",
        action: "opened",
        raw: {},
      }),
    ).toEqual({ isNew: false });
  });
});
