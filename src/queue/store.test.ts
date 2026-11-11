import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, type JobRow, createDb, jobs, processedDeliveries } from "#db";
import { createTestDb } from "../db/testDb.ts";
import { enqueueTestJob } from "../testing/queue.ts";
import {
  LEASE_MS,
  claimNextJob,
  completeJob,
  enqueueDeliveryJob,
  failJob,
  pruneJobHistory,
  resetFailedJob,
} from "./store.ts";

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

const DAY_MS = 24 * 60 * 60_000;
const now = new Date("2026-10-29T08:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
const row = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0];

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

const enqueueInto = (target: Db, deliveryId: string) =>
  enqueueTestJob(target, { deliveryId, event: "pull_request", action: "opened", raw: {} });

const enqueue = (deliveryId: string, raw: unknown = {}) =>
  enqueueTestJob(db, { deliveryId, event: "pull_request", action: "opened", raw });

async function due(id: string, availableAt: Date, createdAt = availableAt): Promise<void> {
  await enqueue(id);
  await db.update(jobs).set({ availableAt, createdAt }).where(eq(jobs.id, id));
}

function claimed(job: JobRow | undefined): JobRow {
  if (!job) throw new Error("expected a job claim");
  return job;
}

describe("enqueueDeliveryJob", () => {
  it("stores a new delivery as a pending job keyed by the delivery id", async () => {
    const result = await enqueueDeliveryJob(db, {
      deliveryId: "d-new",
      event: "issue_comment",
      action: null,
      raw: { nested: { list: [1, "two"] } },
    });

    expect(result).toEqual({ isNew: true, job: await row("d-new") });
    expect(await row("d-new")).toMatchObject({
      id: "d-new",
      deliveryId: "d-new",
      event: "issue_comment",
      action: null,
      raw: { nested: { list: [1, "two"] } },
      status: "pending",
      attempts: 0,
      claimedAt: null,
    });
    const job = claimed(await row("d-new"));
    expect(job.availableAt.getTime()).toBe(job.createdAt.getTime());
  });

  it("stores the PR lanes the delivery touches", async () => {
    const repository = { full_name: "Unkey/API" };
    const lanesOf = async (deliveryId: string, event: string, raw: unknown) => {
      await enqueueDeliveryJob(db, { deliveryId, event, action: null, raw });
      return (await row(deliveryId))?.lanes;
    };

    expect(await lanesOf("comment", "issue_comment", { repository, issue: { number: 7 } })).toEqual(
      ["unkey/api#7"],
    );
    const run = { repository, check_run: { pull_requests: [{ number: 7 }, { number: 9 }] } };
    expect(await lanesOf("run", "check_run", run)).toEqual(["unkey/api#7", "unkey/api#9"]);
    expect(await lanesOf("install", "installation", { repository })).toEqual([]);
  });

  it("stores neither a marker nor a job for a duplicate delivery", async () => {
    await enqueue("d-dup", { first: true });

    expect(
      await enqueueDeliveryJob(db, {
        deliveryId: "d-dup",
        event: "pull_request",
        action: "closed",
        raw: { first: false },
      }),
    ).toEqual({ isNew: false });
    expect(await db.select().from(jobs)).toHaveLength(1);
    expect((await row("d-dup"))?.raw).toEqual({ first: true });
    expect(await db.select().from(processedDeliveries)).toHaveLength(1);
  });
});

describe("claimNextJob", () => {
  it("claims due jobs oldest first by available_at, then created_at", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await due("later", new Date(now.getTime() - 1_000));
    await due("tie-newer", new Date(now.getTime() - 5_000), new Date(now.getTime() - 2_000));
    await due("tie-older", new Date(now.getTime() - 5_000), new Date(now.getTime() - 9_000));
    await due("not-yet", new Date(now.getTime() + 1));

    const order: string[] = [];
    for (let job = await claimNextJob(db); job; job = await claimNextJob(db)) order.push(job.id);

    expect(order).toEqual(["tie-older", "tie-newer", "later"]);
    expect(await row("not-yet")).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("marks the claim processing at the current time and counts an attempt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await due("job", now);

    const job = claimed(await claimNextJob(db));

    expect(job).toMatchObject({ id: "job", status: "processing", attempts: 1, claimedAt: now });
    expect(await row("job")).toEqual(job);
  });

  it("orders a lease-expired job among pending ones by its available_at", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await due("crashed", new Date(now.getTime() - 3_000));
    claimed(await claimNextJob(db));
    await due("pending", new Date(now.getTime() - 1_000));

    vi.setSystemTime(new Date(now.getTime() + LEASE_MS));
    expect((await claimNextJob(db))?.id).toBe("crashed");
    expect((await claimNextJob(db))?.id).toBe("pending");
  });

  it("reclaims a processing job only once its lease expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await due("lease-job", now);
    expect((await claimNextJob(db))?.id).toBe("lease-job");

    vi.setSystemTime(new Date(now.getTime() + LEASE_MS - 1));
    expect(await claimNextJob(db)).toBeUndefined();

    vi.setSystemTime(new Date(now.getTime() + LEASE_MS));
    const reclaimed = claimed(await claimNextJob(db));
    expect(reclaimed).toMatchObject({ id: "lease-job", attempts: 2 });
  });

  it("reclaims a processing job that has no claim time", async () => {
    await enqueue("orphan");
    await db.update(jobs).set({ status: "processing", attempts: 3 }).where(eq(jobs.id, "orphan"));

    expect(await claimNextJob(db)).toMatchObject({ id: "orphan", attempts: 4 });
  });

  it("never claims done or failed jobs", async () => {
    await enqueue("done");
    await enqueue("failed");
    await db.update(jobs).set({ status: "done" }).where(eq(jobs.id, "done"));
    await db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, "failed"));

    expect(await claimNextJob(db)).toBeUndefined();
  });

  it("gives concurrent claimers different jobs", async () => {
    await enqueue("a");
    await enqueue("b");

    const both = await Promise.all([claimNextJob(db), claimNextJob(db), claimNextJob(db)]);

    expect(both.map((job) => job?.id).sort()).toEqual(["a", "b", undefined]);
  });
});

describe("claimNextJob lanes", () => {
  const repository = { full_name: "unkey/api" };
  const onPr = async (id: string, number: number) => {
    await enqueueTestJob(db, {
      deliveryId: id,
      event: "pull_request",
      action: "edited",
      raw: { repository, pull_request: { number } },
    });
  };
  const ids = async () => {
    const order: string[] = [];
    for (let job = await claimNextJob(db); job; job = await claimNextJob(db)) order.push(job.id);
    return order;
  };

  it("holds a PR's next job back while its current one runs, and lets other PRs through", async () => {
    await onPr("a1", 1);
    await onPr("a2", 1);
    await onPr("b1", 2);
    await enqueue("no-pr");

    expect(await ids()).toEqual(["a1", "b1", "no-pr"]);

    await completeJob(db, claimed(await row("a1")));
    expect(await ids()).toEqual(["a2"]);
  });

  it("claims a PR's next job once the running one's lease expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const at = (id: string, ms: number) =>
      db
        .update(jobs)
        .set({ availableAt: new Date(now.getTime() - ms) })
        .where(eq(jobs.id, id));
    await onPr("crashed", 1);
    await at("crashed", 1_000);
    expect((await claimNextJob(db))?.id).toBe("crashed");
    await onPr("next", 1);
    await at("next", 2_000);
    expect(await claimNextJob(db)).toBeUndefined();

    vi.setSystemTime(new Date(now.getTime() + LEASE_MS));
    expect((await claimNextJob(db))?.id).toBe("next");
    expect(await claimNextJob(db)).toBeUndefined();
  });

  it("holds a check run on several PRs until every one of them is free", async () => {
    await onPr("p1", 1);
    await onPr("p2", 2);
    await enqueueTestJob(db, {
      deliveryId: "run",
      event: "check_run",
      action: "completed",
      raw: { repository, check_run: { pull_requests: [{ number: 1 }, { number: 2 }] } },
    });

    expect(await ids()).toEqual(["p1", "p2"]);
    await completeJob(db, claimed(await row("p1")));
    expect(await claimNextJob(db)).toBeUndefined();
    await completeJob(db, claimed(await row("p2")));
    expect((await claimNextJob(db))?.id).toBe("run");
  });
});

describe("job claim fence", () => {
  it("purges the raw payload on completion (retention, KTD13)", async () => {
    await enqueue("d1", { secret: "private-repo-diff" });
    await completeJob(db, claimed(await claimNextJob(db)));

    expect(await row("d1")).toMatchObject({ status: "done", raw: null, claimedAt: null });
  });

  it("fences a stale worker after its processing lease is reclaimed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await due("fenced-job", now);
    const staleClaim = claimed(await claimNextJob(db));
    vi.setSystemTime(new Date(now.getTime() + LEASE_MS));
    const currentClaim = claimed(await claimNextJob(db));

    expect(await completeJob(db, staleClaim)).toBe(false);
    expect(await completeJob(db, currentClaim)).toBe(true);
    expect((await row("fenced-job"))?.status).toBe("done");
  });

  it("retains a terminal payload for one explicit safe replay", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await enqueue("terminal-job", { secret: "private-repo-diff" });
    await failJob(db, claimed(await claimNextJob(db)));

    expect(await row("terminal-job")).toMatchObject({
      status: "failed",
      raw: { secret: "private-repo-diff" },
    });

    vi.setSystemTime(new Date(now.getTime() + 2_000));
    expect(await resetFailedJob(db, "terminal-job")).toBe(true);
    const reset = await row("terminal-job");
    expect(reset?.status).toBe("pending");
    expect(reset?.attempts).toBe(0);
    expect(reset?.raw).toEqual({ secret: "private-repo-diff" });
    expect(reset?.availableAt.getTime()).toBe(now.getTime() + 2_000);
    expect(await resetFailedJob(db, "terminal-job")).toBe(false);
  });
});

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

/**
 * PGlite has one session, so a row lock held by another connection needs a
 * real server: set QUEUE_TEST_DATABASE_URL to an empty Postgres database.
 */
const PG_URL = process.env.QUEUE_TEST_DATABASE_URL;

describe.skipIf(!PG_URL)("claimNextJob on Postgres", () => {
  it("skips a job another worker's transaction holds, then claims it once released", async () => {
    const pg = createDb(PG_URL as string);
    try {
      const migrations = fileURLToPath(new URL("../db/migrations", import.meta.url));
      await pg.db.execute(sql.raw("drop schema public cascade; create schema public"));
      for (const file of readdirSync(migrations)
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        for (const stmt of readFileSync(`${migrations}/${file}`, "utf8").split(
          "--> statement-breakpoint",
        )) {
          if (stmt.trim()) await pg.db.execute(sql.raw(stmt));
        }
      }
      await enqueueInto(pg.db, "held");
      await enqueueInto(pg.db, "free");
      await pg.db
        .update(jobs)
        .set({ availableAt: new Date(Date.now() - 60_000) })
        .where(eq(jobs.id, "held"));

      await pg.db.transaction(async (tx) => {
        await tx.select().from(jobs).where(eq(jobs.id, "held")).for("update");
        expect((await claimNextJob(pg.db))?.id).toBe("free");
        expect(await claimNextJob(pg.db)).toBeUndefined();
      });
      expect((await claimNextJob(pg.db))?.id).toBe("held");
    } finally {
      await pg.close();
    }
  });
});
