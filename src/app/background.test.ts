import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, jobs, pullRequestLifecycleClaims } from "#db";
import { createLogger } from "#lib";
import { createTestDb } from "../db/testDb.ts";
import {
  claimPullRequestLifecycle,
  releasePullRequestLifecycle,
  renewPullRequestLifecycle,
} from "../pr/store.ts";
import { enqueueTestJob } from "../testing/queue.ts";
import { millisecondsUntilUtcHour, pruneHistory } from "./background.ts";

describe("millisecondsUntilUtcHour", () => {
  it("waits until the next occurrence, including across a month boundary", () => {
    expect(millisecondsUntilUtcHour(new Date("2026-10-16T07:59:59.000Z"), 8)).toBe(1000);
    expect(millisecondsUntilUtcHour(new Date("2026-10-16T08:00:00.000Z"), 8)).toBe(
      24 * 60 * 60_000,
    );
    expect(millisecondsUntilUtcHour(new Date("2026-10-31T09:00:00.000Z"), 8)).toBe(
      23 * 60 * 60_000,
    );
  });
});

describe("pruneHistory", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = () => t.client.close();
  });
  afterEach(async () => {
    await close();
  });

  const now = new Date("2026-11-11T08:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const DAY = 24 * 60 * 60_000;
  const claimIds = async () =>
    (await db.select().from(pullRequestLifecycleClaims)).map((c) => c.githubPrId).sort();

  it("deletes lifecycle claims a crash left behind a day ago, and logs the count", async () => {
    const orphan = await claimPullRequestLifecycle(db, 1, { now: ago(DAY + 60_000) });
    const live = await claimPullRequestLifecycle(db, 2, { now: ago(100_000) });
    const idleUnderADay = await claimPullRequestLifecycle(db, 3, { now: ago(DAY - 60_000) });
    expect([orphan, live, idleUnderADay].every(Boolean)).toBe(true);
    const info = vi.fn();

    await pruneHistory(db, { ...createLogger("error"), info }, now);

    expect(await claimIds()).toEqual([2, 3]);
    expect(info).toHaveBeenCalledWith("pruned job history", {
      jobs: 0,
      deliveries: 0,
      lifecycleClaims: 1,
    });
    expect(await claimPullRequestLifecycle(db, 1, { now })).toBeDefined();
  });

  it("leaves a live holder able to renew and release its lease", async () => {
    const live = await claimPullRequestLifecycle(db, 2, { now: ago(100_000) });
    if (!live) throw new Error("claim failed");

    await pruneHistory(db, createLogger("error"), now);

    expect(await renewPullRequestLifecycle(db, live, now)).toBe(true);
    expect(await releasePullRequestLifecycle(db, { ...live, claimedAt: now })).toBe(true);
  });

  it("keeps failed jobs however old", async () => {
    const failed = await enqueueTestJob(db, {
      deliveryId: "old-failed",
      event: "pull_request",
      action: "opened",
      raw: {},
    });
    await db.update(jobs).set({ status: "failed", availableAt: ago(60 * DAY) });

    await pruneHistory(db, createLogger("error"), now);

    expect((await db.select().from(jobs)).map((j) => j.id)).toEqual([failed.id]);
  });
});
