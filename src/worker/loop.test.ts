import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { claimNextJob, enqueueJob } from "../db/repositories/jobs.ts";
import { jobs } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { createLogger } from "../logger.ts";
import { createWorker, startWorkerLoop } from "./loop.ts";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
});

afterEach(async () => {
  vi.useRealTimers();
  await close();
});

describe("worker retries", () => {
  it("backs off a failed job, then retains its payload for admin replay", async () => {
    const job = await enqueueJob(db, {
      deliveryId: "retry-job",
      event: "pull_request",
      action: "opened",
      raw: { private: "payload" },
    });
    let clock = job.availableAt.getTime();
    const startedAt = clock;
    const worker = createWorker({
      db,
      logger: createLogger("error"),
      router: async () => {
        throw new Error("Slack unavailable");
      },
      now: () => clock,
      maxAttempts: 2,
      retryBaseMs: 1_000,
      leaseMs: 5_000,
    });

    expect(await worker.tick()).toBe(true);
    let [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.status).toBe("pending");
    expect(row?.raw).toEqual({ private: "payload" });
    expect(row?.availableAt.getTime()).toBe(startedAt + 1_000);
    expect(await worker.tick()).toBe(false);

    clock = startedAt + 1_000;
    expect(await worker.tick()).toBe(true);
    [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.status).toBe("failed");
    expect(row?.raw).toEqual({ private: "payload" });
  });

  it("does not run a handler beyond the retry budget when reclaiming a crashed attempt", async () => {
    const job = await enqueueJob(db, {
      deliveryId: "crashed-final-attempt",
      event: "pull_request",
      action: "opened",
      raw: { private: "payload" },
    });
    const clock = job.availableAt.getTime();
    await claimNextJob(db, { now: new Date(clock), leaseMs: 1_000 });
    const router = vi.fn(async () => undefined);
    const worker = createWorker({
      db,
      logger: createLogger("error"),
      router,
      now: () => clock + 1_000,
      maxAttempts: 1,
      retryBaseMs: 1_000,
      leaseMs: 1_000,
    });

    expect(await worker.tick()).toBe(true);
    expect(router).not.toHaveBeenCalled();
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.status).toBe("failed");
    expect(row?.raw).toEqual({ private: "payload" });
  });
});

describe("worker loop", () => {
  it("does not overlap drains when one interval takes longer than the timer", async () => {
    vi.useFakeTimers();
    let resolveDrain: (() => void) | undefined;
    const drain = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveDrain = () => resolve(1);
        }),
    );
    const loop = startWorkerLoop({ drain }, 10, createLogger("error"));

    await vi.advanceTimersByTimeAsync(30);
    expect(drain).toHaveBeenCalledTimes(1);

    resolveDrain?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(drain).toHaveBeenCalledTimes(2);
    loop.stop();
  });
});
