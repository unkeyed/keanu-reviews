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

const scheduler = (options: Partial<Parameters<typeof createReminderScheduler>[0]> = {}) =>
  createReminderScheduler({
    db,
    slack,
    logger: createLogger("error"),
    reminderHours: HOURS,
    now: () => clock,
    ...options,
  });

const ready = { mergeable: true, mergeableState: "clean", draft: false };
const blocked = { mergeable: false, mergeableState: "blocked", draft: false };

const advanceHours = (h: number) => {
  clock += h * 60 * 60_000;
};

describe("reminder scheduler (U8, R9)", () => {
  it("holds a due reminder outside the delivery window, delivers it inside", async () => {
    const s = createReminderScheduler({
      db,
      slack,
      logger: createLogger("error"),
      reminderHours: HOURS,
      now: () => clock,
      deliveryWindow: { startHour: 5, endHour: 14, timeZone: "America/New_York" },
    });
    clock = Date.parse("2026-08-12T18:00:00Z"); // schedule -> due 2026-08-13T06:00:00Z
    await s.onReviewRequested(PR, 7);

    clock = Date.parse("2026-08-13T07:00:00Z"); // 03:00 ET — outside the window
    expect(await s.processDue()).toBe(0);
    expect(slack.messages).toHaveLength(0);

    clock = Date.parse("2026-08-13T13:00:00Z"); // 09:00 ET — inside the window
    expect(await s.processDue()).toBe(1);
    expect(slack.messages).toHaveLength(1);
  });

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

  it("reschedules a failed Slack delivery with backoff instead of blocking the scan", async () => {
    const s = scheduler({ retryBaseMs: 1_000 });
    await s.onReviewRequested(PR, 7);
    advanceHours(HOURS);
    slack.postMessage = async () => {
      throw new Error("Slack unavailable");
    };

    await expect(s.processDue()).resolves.toBe(0);

    const [row] = await db.select().from(reminders).where(eq(reminders.prId, PR));
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.availableAt.getTime()).toBe(clock + 1_000);
    expect(await listDue(db, new Date(clock))).toHaveLength(0);
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

  it("suppresses the reminder when the PR is ready to merge", async () => {
    const s = scheduler({ fetchPullRequest: async () => ready });
    await s.onReviewRequested(PR, 7);
    advanceHours(HOURS);
    expect(await s.processDue()).toBe(0);
    expect(slack.messages).toHaveLength(0);
    const [row] = await db.select().from(reminders).where(eq(reminders.prId, PR));
    expect(row?.status).toBe("cancelled");
  });

  it("suppresses the reminder when the PR already has two approvals", async () => {
    const s = scheduler({ fetchApprovalCount: async () => 2 });
    await s.onReviewRequested(PR, 7);
    advanceHours(HOURS);
    expect(await s.processDue()).toBe(0);
    expect(slack.messages).toHaveLength(0);
  });

  it("still reminds when the PR is blocked and under the approval threshold", async () => {
    const s = scheduler({
      fetchPullRequest: async () => blocked,
      fetchApprovalCount: async () => 1,
    });
    await s.onReviewRequested(PR, 7);
    advanceHours(HOURS);
    expect(await s.processDue()).toBe(1);
    expect(slack.messages).toHaveLength(1);
  });

  it("delivers anyway when the readiness lookup fails (fail-open)", async () => {
    const s = scheduler({
      fetchPullRequest: async () => {
        throw new Error("github down");
      },
    });
    await s.onReviewRequested(PR, 7);
    advanceHours(HOURS);
    expect(await s.processDue()).toBe(1);
    expect(slack.messages).toHaveLength(1);
  });

  it("does a single readiness lookup per PR across its reviewers", async () => {
    let calls = 0;
    const s = scheduler({
      fetchPullRequest: async () => {
        calls += 1;
        return ready;
      },
    });
    await s.onReviewRequested(PR, 7);
    await s.onReviewRequested(PR, 8);
    advanceHours(HOURS);
    expect(await s.processDue()).toBe(0);
    expect(calls).toBe(1); // shared across both reviewers' reminders
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

  it("retries an ambiguously accepted post with the same generation idempotency key", async () => {
    const s = scheduler({ retryBaseMs: 1_000 });
    await s.onReviewRequested(PR, 7);
    advanceHours(HOURS);
    const post = slack.postMessage.bind(slack);
    let loseResponse = true;
    slack.postMessage = async (message) => {
      const result = await post(message);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost after accept");
      }
      return result;
    };

    expect(await s.processDue()).toBe(0);
    expect(slack.messages).toHaveLength(1);
    clock += 1_000;
    expect(await s.processDue()).toBe(1);

    expect(slack.messages).toHaveLength(1);
    expect(slack.messages[0]?.clientMsgId).toMatch(/^[0-9a-f-]{36}$/);
    const [row] = await db.select().from(reminders).where(eq(reminders.prId, PR));
    expect(row?.status).toBe("sent");
  });

  it("continues past a poison reminder so another due row can be delivered", async () => {
    const s = scheduler({ retryBaseMs: 1_000 });
    await s.onReviewRequested(PR, 7);
    await s.onReviewRequested(PR, 8);
    advanceHours(HOURS);
    const post = slack.postMessage.bind(slack);
    let poison = true;
    slack.postMessage = async (message) => {
      if (poison) {
        poison = false;
        throw new Error("poison row");
      }
      return post(message);
    };

    expect(await s.processDue()).toBe(1);
    expect(slack.messages).toHaveLength(1);
    const rows = await db.select().from(reminders).where(eq(reminders.prId, PR));
    expect(rows.map((row) => row.status).sort()).toEqual(["pending", "sent"]);
  });

  it("marks a reminder failed after its bounded exponential retry budget", async () => {
    const s = scheduler({ maxAttempts: 2, retryBaseMs: 1_000 });
    await s.onReviewRequested(PR, 7);
    advanceHours(HOURS);
    slack.postMessage = async () => {
      throw new Error("permanent Slack failure");
    };

    expect(await s.processDue()).toBe(0);
    clock += 1_000;
    expect(await s.processDue()).toBe(0);

    const [row] = await db.select().from(reminders).where(eq(reminders.prId, PR));
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(2);
    expect(await s.processDue()).toBe(0);
  });

  it("processes reminders in bounded batches without starving the remainder", async () => {
    const s = scheduler({ batchSize: 2 });
    await s.onReviewRequested(PR, 7);
    await s.onReviewRequested(PR, 8);
    await s.onReviewRequested(PR, 9);
    advanceHours(HOURS);

    expect(await s.processDue()).toBe(2);
    expect(await s.processDue()).toBe(1);
    expect(slack.messages).toHaveLength(3);
  });
});
