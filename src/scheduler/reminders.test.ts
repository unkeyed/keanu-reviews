import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import {
  prId,
  setChannel,
  updateState,
  upsertPullRequest,
} from "../db/repositories/pullRequests.ts";
import { listDue } from "../db/repositories/reminders.ts";
import { reminders } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { createLogger } from "../logger.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import { createReminderScheduler } from "./reminders.ts";

let db: Db;
let slack: FakeSlackClient;
let close: () => Promise<void>;
let clock: number;

const HOURS = 12;
const PR = prId("unkey/api", 1);

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackClient();
  clock = 1_000_000_000_000;
  const row = await upsertPullRequest(db, {
    repoFullName: "unkey/api",
    number: 1,
    githubPrId: 1,
    currentState: "pr",
  });
  await setChannel(db, row.id, "C1", "ts-root");
});
afterEach(() => close());

const scheduler = () =>
  createReminderScheduler({
    db,
    slack,
    logger: createLogger("error"),
    reminderHours: HOURS,
    now: () => clock,
  });

const advanceHours = (h: number) => {
  clock += h * 60 * 60_000;
};

describe("reminder scheduler (U8, R9)", () => {
  it("schedules a pending reminder ~12h out", async () => {
    await scheduler().onReviewRequested(PR, 7);
    const due = await listDue(db, new Date(clock + (HOURS + 0.1) * 60 * 60_000));
    expect(due).toHaveLength(1);
    expect(await listDue(db, new Date(clock))).toHaveLength(0); // not yet due
  });

  it("posts exactly once at due time and flips the row to sent", async () => {
    const s = scheduler();
    await s.onReviewRequested(PR, 7);
    advanceHours(HOURS);
    expect(await s.processDue()).toBe(1);
    expect(slack.messages).toHaveLength(1);
    // second scan finds nothing pending
    expect(await s.processDue()).toBe(0);
  });

  it("returns a failed Slack delivery to pending instead of losing it", async () => {
    const s = scheduler();
    await s.onReviewRequested(PR, 7);
    advanceHours(HOURS);
    slack.postMessage = async () => {
      throw new Error("Slack unavailable");
    };

    await expect(s.processDue()).rejects.toThrow("Slack unavailable");

    const [row] = await db.select().from(reminders).where(eq(reminders.prId, PR));
    expect(row?.status).toBe("pending");
    expect(await listDue(db, new Date(clock))).toHaveLength(1);
  });

  it("does not post when the review was submitted before due time", async () => {
    const s = scheduler();
    await s.onReviewRequested(PR, 7);
    await s.onReviewSubmitted(PR, 7);
    advanceHours(HOURS);
    expect(await s.processDue()).toBe(0);
    expect(slack.messages).toHaveLength(0);
  });

  it("does not post after the PR is closed/merged (state guard)", async () => {
    const s = scheduler();
    await s.onReviewRequested(PR, 7);
    await updateState(db, PR, "merged");
    advanceHours(HOURS);
    expect(await s.processDue()).toBe(0);
  });

  it("cancels on review_request_removed", async () => {
    const s = scheduler();
    await s.onReviewRequested(PR, 7);
    await s.onReviewRequestRemoved(PR, 7);
    advanceHours(HOURS);
    expect(await s.processDue()).toBe(0);
  });

  it("does not let an older cancellation erase a newer re-request", async () => {
    const s = scheduler();
    const firstRequest = new Date(clock);
    const newerRequest = new Date(clock + 60 * 60_000);
    await s.onReviewRequested(PR, 7, firstRequest);
    await s.onReviewRequested(PR, 7, newerRequest);

    await s.onReviewSubmitted(PR, 7, new Date(clock + 30 * 60_000));

    const [row] = await db.select().from(reminders).where(eq(reminders.prId, PR));
    expect(row?.status).toBe("pending");
    expect(row?.dueAt.getTime()).toBe(newerRequest.getTime() + HOURS * 60 * 60_000);
  });

  it("posts exactly one reminder under two concurrent scanners (atomic claim)", async () => {
    const s = scheduler();
    await s.onReviewRequested(PR, 7);
    advanceHours(HOURS);
    const [a, b] = await Promise.all([s.processDue(), s.processDue()]);
    expect(a + b).toBe(1);
    expect(slack.messages).toHaveLength(1);
  });
});
