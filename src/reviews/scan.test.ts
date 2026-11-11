import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrId } from "#lib";
import {
  cancelForReviewer,
  claimReminder,
  deferReminder,
  listDueWithContext,
  pushReminderDue,
  scheduleReminder,
} from "#reminders";
import type { Db } from "../db/client.ts";
import { reminders } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import type { CiReadiness } from "../github/ci.ts";
import {
  applyPullRequestSource,
  claimPullRequestLifecycle,
  prId,
  setChannel,
} from "../pr/store.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
import { setPrState } from "../testing/pr.ts";
import { reviewDeps } from "../testing/reviews.ts";
import type { ReviewDeps } from "./deps.ts";
import { scanDue } from "./scan.ts";

let db: Db;
let slack: FakeSlackGateway;
let close: () => Promise<void>;
let clock: number;

const HOURS = 12;
const HOLD_MS = 15 * 60_000;
const RETRY_BASE_MS = 60_000;
const BATCH = 50;
const PR = prId("unkey/api", 1);
// A Monday, so the default window (every weekday, all day) is open.
const MONDAY = Date.parse("2026-08-10T00:00:00Z");

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackGateway();
  clock = MONDAY;
  const row = (
    await applyPullRequestSource(db, {
      repoFullName: "unkey/api",
      number: 1,
      githubPrId: 1,
      currentState: "pr",
    })
  ).row;
  await setChannel(db, row.id, "C1", "ts-root");
});
afterEach(() => close());

const scan = (over: Partial<ReviewDeps> = {}) =>
  scanDue(reviewDeps(db, slack, { clock: { now: () => new Date(clock) }, ...over }));

let versions = 0;
/** Each write sorts after the previous one at the same instant, as job arrival keys do. */
const stamp = (at: number) => ({
  updatedAt: new Date(at),
  version: String(++versions).padStart(6, "0"),
});

const request = (pr: PrId, reviewer: number, at = clock) =>
  scheduleReminder(db, {
    prId: pr,
    reviewerGithubId: reviewer,
    dueAt: new Date(at + HOURS * 60 * 60_000),
    stamp: stamp(at),
  });

const cancel = (pr: PrId, reviewer: number, at = clock) =>
  cancelForReviewer(db, pr, reviewer, stamp(at));

const ready = { mergeableState: "clean", draft: false };
const blocked = { mergeableState: "blocked", draft: false };

const advanceHours = (h: number) => {
  clock += h * 60 * 60_000;
};

const rowsOf = (pr: PrId) => db.select().from(reminders).where(eq(reminders.prId, pr));

const seedHeadSha = () =>
  applyPullRequestSource(db, {
    repoFullName: "unkey/api",
    number: 1,
    githubPrId: 1,
    currentState: "pr",
    headSha: "sha-1",
  });

describe("reminder scan (U8, R9)", () => {
  it("holds a due reminder outside the delivery window, delivers it inside", async () => {
    const window = { startHour: 5, endHour: 14, timeZone: "America/New_York" };
    clock = Date.parse("2026-08-12T18:00:00Z"); // schedule -> due 2026-08-13T06:00:00Z
    await request(PR, 7);

    clock = Date.parse("2026-08-13T07:00:00Z"); // 03:00 ET — outside the window
    expect(await scan({ reminderWindow: window })).toBe(0);
    expect(slack.messages).toHaveLength(0);

    clock = Date.parse("2026-08-13T13:00:00Z"); // 09:00 ET — inside the window
    expect(await scan({ reminderWindow: window })).toBe(1);
    expect(slack.messages).toHaveLength(1);
  });

  it("schedules a pending reminder ~12h out", async () => {
    await request(PR, 7);
    const due = await listDueWithContext(db, new Date(clock + (HOURS + 0.1) * 60 * 60_000), BATCH);
    expect(due).toHaveLength(1);
    expect(await listDueWithContext(db, new Date(clock), BATCH)).toHaveLength(0); // not yet due
  });

  it("posts exactly once at due time and flips the row to sent", async () => {
    await request(PR, 7);
    advanceHours(HOURS);
    expect(await scan()).toBe(1);
    expect(slack.messages).toHaveLength(1);
    // second scan finds nothing pending
    expect(await scan()).toBe(0);
  });

  it("reschedules a failed Slack delivery with backoff instead of blocking the scan", async () => {
    await request(PR, 7);
    advanceHours(HOURS);
    slack.post = async () => {
      throw new Error("Slack unavailable");
    };

    await expect(scan()).resolves.toBe(0);

    const [row] = await rowsOf(PR);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.availableAt.getTime()).toBe(clock + RETRY_BASE_MS);
    expect(await listDueWithContext(db, new Date(clock), BATCH)).toHaveLength(0);
  });

  it("does not post when the review was submitted before due time", async () => {
    await request(PR, 7);
    await cancel(PR, 7);
    advanceHours(HOURS);
    expect(await scan()).toBe(0);
    expect(slack.messages).toHaveLength(0);
  });

  it("does not post after the PR is closed/merged (state guard)", async () => {
    await request(PR, 7);
    await setPrState(db, PR, "merged");
    advanceHours(HOURS);
    expect(await scan()).toBe(0);
  });

  it("holds a due reminder while the PR is a draft and sends it once ready", async () => {
    await request(PR, 7);
    await setPrState(db, PR, "draft");
    advanceHours(HOURS);
    expect(await scan()).toBe(0);
    expect(slack.messages).toHaveLength(0);
    const [row] = await rowsOf(PR);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);

    await setPrState(db, PR, "pr");
    clock += HOLD_MS;
    expect(await scan()).toBe(1);
    expect(slack.messages).toHaveLength(1);
  });

  it("holds a due reminder while CI is failing or pending, then sends it when CI passes", async () => {
    await seedHeadSha();
    let readiness: CiReadiness = "failing";
    const fetchCiReadiness = async () => readiness;
    await request(PR, 7);
    advanceHours(HOURS);

    expect(await scan({ fetchCiReadiness })).toBe(0);
    readiness = "pending";
    clock += HOLD_MS;
    expect(await scan({ fetchCiReadiness })).toBe(0);
    const [row] = await rowsOf(PR);
    expect(row?.status).toBe("pending");
    expect(slack.messages).toHaveLength(0);

    readiness = "passing";
    clock += HOLD_MS;
    expect(await scan({ fetchCiReadiness })).toBe(1);
    expect(slack.messages).toHaveLength(1);
  });

  it("still reminds when the commit has no CI configured", async () => {
    await seedHeadSha();
    await request(PR, 7);
    advanceHours(HOURS);
    expect(await scan({ fetchCiReadiness: async () => "absent" })).toBe(1);
  });

  it("holds the reminder when the CI lookup fails", async () => {
    await seedHeadSha();
    await request(PR, 7);
    advanceHours(HOURS);
    const fetchCiReadiness = async (): Promise<CiReadiness> => {
      throw new Error("github down");
    };
    expect(await scan({ fetchCiReadiness })).toBe(0);
    const [row] = await rowsOf(PR);
    expect(row?.status).toBe("pending");
  });

  it("suppresses the reminder when the PR is ready to merge", async () => {
    await request(PR, 7);
    advanceHours(HOURS);
    expect(await scan({ fetchPullRequest: async () => ready })).toBe(0);
    expect(slack.messages).toHaveLength(0);
    const [row] = await rowsOf(PR);
    expect(row?.status).toBe("cancelled");
  });

  it("suppresses a ready-to-merge PR even when the approval read fails", async () => {
    await request(PR, 7);
    advanceHours(HOURS);
    const fetchApprovalCount = async (): Promise<number> => {
      throw new Error("github down");
    };
    expect(await scan({ fetchPullRequest: async () => ready, fetchApprovalCount })).toBe(0);
    const [row] = await rowsOf(PR);
    expect(row?.status).toBe("cancelled");
  });

  it("still reminds every requested reviewer when the PR has zero approvals", async () => {
    await request(PR, 7);
    await request(PR, 8);
    advanceHours(HOURS);
    const deps = { fetchPullRequest: async () => blocked, fetchApprovalCount: async () => 0 };
    expect(await scan(deps)).toBe(2);
    expect(slack.messages).toHaveLength(2);
    expect(slack.messages.map((message) => message.channel)).toEqual(["C1", "C1"]);
  });

  it("sends no reminder to remaining reviewers or the channel once the PR has one approval", async () => {
    await request(PR, 7);
    await request(PR, 8);
    advanceHours(HOURS);
    const deps = { fetchPullRequest: async () => blocked, fetchApprovalCount: async () => 1 };
    expect(await scan(deps)).toBe(0);
    expect(slack.messages).toHaveLength(0);
    const rows = await rowsOf(PR);
    expect(rows.map((row) => row.status).sort()).toEqual(["cancelled", "cancelled"]);
  });

  it.each([2, 3])(
    "sends no reminder to remaining reviewers or the channel when the PR has %i approvals",
    async (approvals) => {
      await request(PR, 7);
      await request(PR, 8);
      advanceHours(HOURS);
      const deps = {
        fetchPullRequest: async () => blocked,
        fetchApprovalCount: async () => approvals,
      };
      expect(await scan(deps)).toBe(0);
      expect(slack.messages).toHaveLength(0);
      const rows = await rowsOf(PR);
      expect(rows.map((row) => row.status).sort()).toEqual(["cancelled", "cancelled"]);
    },
  );

  it("honors a higher configured approval threshold", async () => {
    await request(PR, 7);
    advanceHours(HOURS);
    const deps = {
      suppressApprovals: 2,
      fetchPullRequest: async () => blocked,
      fetchApprovalCount: async () => 1,
    };
    expect(await scan(deps)).toBe(1);
    expect(slack.messages).toHaveLength(1);
  });

  it("delivers anyway when the readiness lookup fails (fail-open)", async () => {
    await request(PR, 7);
    advanceHours(HOURS);
    const fetchPullRequest = async () => {
      throw new Error("github down");
    };
    expect(await scan({ fetchPullRequest, fetchApprovalCount: async () => 5 })).toBe(1);
    expect(slack.messages).toHaveLength(1);
  });

  it("does a single readiness lookup per PR across its reviewers", async () => {
    let calls = 0;
    const fetchPullRequest = async () => {
      calls += 1;
      return ready;
    };
    await request(PR, 7);
    await request(PR, 8);
    advanceHours(HOURS);
    expect(await scan({ fetchPullRequest })).toBe(0);
    expect(calls).toBe(1); // shared across both reviewers' reminders
  });

  it("cancels on review_request_removed", async () => {
    await request(PR, 7);
    await cancel(PR, 7);
    advanceHours(HOURS);
    expect(await scan()).toBe(0);
  });

  it("does not let an older cancellation erase a newer re-request", async () => {
    const firstRequest = clock;
    const newerRequest = clock + 60 * 60_000;
    await request(PR, 7, firstRequest);
    await request(PR, 7, newerRequest);

    await cancel(PR, 7, clock + 30 * 60_000);

    const [row] = await rowsOf(PR);
    expect(row?.status).toBe("pending");
    expect(row?.dueAt.getTime()).toBe(newerRequest + HOURS * 60 * 60_000);
  });

  it("posts exactly one reminder under two concurrent scanners (atomic claim)", async () => {
    await request(PR, 7);
    advanceHours(HOURS);
    const [a, b] = await Promise.all([scan(), scan()]);
    expect(a + b).toBe(1);
    expect(slack.messages).toHaveLength(1);
  });

  it("leaves a PR another replica holds due for the next scan", async () => {
    await request(PR, 7);
    advanceHours(HOURS);
    const lease = await claimPullRequestLifecycle(db, 1);
    expect(lease).toBeDefined();

    expect(await scan()).toBe(0);
    const [held] = await rowsOf(PR);
    expect(held?.status).toBe("pending");
    expect(held?.attempts).toBe(0);
    expect(slack.messages).toHaveLength(0);
  });

  it("retries an ambiguously accepted post with the same generation idempotency key", async () => {
    await request(PR, 7);
    advanceHours(HOURS);
    const post = slack.post.bind(slack);
    let loseResponse = true;
    slack.post = async (channel, message, opts) => {
      const result = await post(channel, message, opts);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost after accept");
      }
      return result;
    };

    expect(await scan()).toBe(0);
    expect(slack.messages).toHaveLength(1);
    clock += RETRY_BASE_MS;
    expect(await scan()).toBe(1);

    expect(slack.messages).toHaveLength(1);
    expect(slack.messages[0]?.clientMsgId).toMatch(/^[0-9a-f-]{36}$/);
    const [row] = await rowsOf(PR);
    expect(row?.status).toBe("sent");
  });

  it("continues past a poison reminder so another due row can be delivered", async () => {
    await request(PR, 7);
    await request(PR, 8);
    advanceHours(HOURS);
    const post = slack.post.bind(slack);
    let poison = true;
    slack.post = async (channel, message, opts) => {
      if (poison) {
        poison = false;
        throw new Error("poison row");
      }
      return post(channel, message, opts);
    };

    expect(await scan()).toBe(1);
    expect(slack.messages).toHaveLength(1);
    const rows = await rowsOf(PR);
    expect(rows.map((row) => row.status).sort()).toEqual(["pending", "sent"]);
  });

  it("marks a reminder failed after its bounded exponential retry budget", async () => {
    await request(PR, 7);
    advanceHours(HOURS);
    slack.post = async () => {
      throw new Error("permanent Slack failure");
    };

    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await scan()).toBe(0);
      const [row] = await rowsOf(PR);
      expect(row?.attempts).toBe(attempt);
      if (attempt < 5) {
        expect(row?.status).toBe("pending");
        expect(row?.availableAt.getTime()).toBe(clock + RETRY_BASE_MS * 2 ** (attempt - 1));
        clock = row?.availableAt.getTime() ?? clock;
      }
    }

    const [row] = await rowsOf(PR);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(5);
    clock += 60 * 60_000;
    expect(await scan()).toBe(0);
  });

  it("processes reminders in bounded batches without starving the remainder", async () => {
    for (let reviewer = 1; reviewer <= BATCH + 1; reviewer++) await request(PR, reviewer);
    advanceHours(HOURS);

    expect(await scan()).toBe(BATCH);
    expect(await scan()).toBe(1);
    expect(slack.messages).toHaveLength(BATCH + 1);
  });

  it("delivers a reminder queued behind more than a batch of held reminders", async () => {
    await setPrState(db, PR, "draft");
    for (let reviewer = 1; reviewer <= BATCH; reviewer++) await request(PR, reviewer);
    const other = (
      await applyPullRequestSource(db, {
        repoFullName: "unkey/api",
        number: 2,
        githubPrId: 2,
        currentState: "pr",
      })
    ).row;
    await setChannel(db, other.id, "C2", "ts-root-2");
    clock += 60_000;
    await request(other.id, 100);
    advanceHours(HOURS);

    expect((await scan()) + (await scan())).toBe(1);

    expect(slack.messages.map((message) => message.channel)).toEqual(["C2"]);
    const held = await rowsOf(PR);
    expect(held).toHaveLength(BATCH);
    for (const row of held) {
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
      expect(row.availableAt.getTime()).toBe(clock + HOLD_MS);
    }
  });

  it("checks CI for a held PR once per hold interval, not on every scan", async () => {
    await seedHeadSha();
    let lookups = 0;
    const fetchCiReadiness = async (): Promise<CiReadiness> => {
      lookups += 1;
      return "failing";
    };
    await request(PR, 7);
    await request(PR, 8);
    advanceHours(HOURS);

    await scan({ fetchCiReadiness });
    await scan({ fetchCiReadiness });
    clock += HOLD_MS - 1;
    await scan({ fetchCiReadiness });
    expect(lookups).toBe(1);

    clock += 1;
    await scan({ fetchCiReadiness });
    expect(lookups).toBe(2);
  });

  it("holds a reminder for an open PR whose channel does not exist yet", async () => {
    const pending = (
      await applyPullRequestSource(db, {
        repoFullName: "unkey/api",
        number: 2,
        githubPrId: 2,
        currentState: "pr",
      })
    ).row;
    await request(pending.id, 7);
    advanceHours(HOURS);

    // More scans than the attempt budget: holding spends no attempt.
    for (let scans = 0; scans < 6; scans++) {
      expect(await scan()).toBe(0);
      clock += HOLD_MS;
    }
    const [held] = await rowsOf(pending.id);
    expect(held?.status).toBe("pending");
    expect(held?.attempts).toBe(0);

    await setChannel(db, pending.id, "C2", "ts-root-2");
    expect(await scan()).toBe(1);
    expect(slack.messages.map((message) => message.channel)).toEqual(["C2"]);
  });

  it("restarts the reminder clock when the review alert goes out after a hold", async () => {
    await setPrState(db, PR, "draft");
    await request(PR, 7);
    advanceHours(HOURS);
    expect(await scan()).toBe(0);

    await setPrState(db, PR, "pr");
    await pushReminderDue(db, PR, 7, new Date(clock + HOURS * 60 * 60_000));
    clock += HOLD_MS;
    expect(await scan()).toBe(0);

    advanceHours(HOURS);
    expect(await scan()).toBe(1);
  });

  it("releases an expired sending lease back to pending when the reminder is held", async () => {
    await request(PR, 7);
    advanceHours(HOURS);
    await db
      .update(reminders)
      .set({ status: "sending", attempts: 1, claimedAt: new Date(clock - 10 * 60_000) })
      .where(eq(reminders.prId, PR));
    await setPrState(db, PR, "draft");

    expect(await scan()).toBe(0);

    const [row] = await rowsOf(PR);
    expect(row?.status).toBe("pending");
    expect(row?.claimedAt).toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.availableAt.getTime()).toBe(clock + HOLD_MS);
  });
});

describe("deferReminder", () => {
  it("does not override a claim taken after the row was listed", async () => {
    await request(PR, 7);
    advanceHours(HOURS);
    const now = new Date(clock);
    const [listed] = await listDueWithContext(db, now, BATCH);
    if (!listed) throw new Error("expected a due reminder");
    await claimReminder(db, listed.reminder.id, now);

    await deferReminder(db, listed.reminder, new Date(clock + HOLD_MS), now);

    const [row] = await rowsOf(PR);
    expect(row?.status).toBe("sending");
    expect(row?.availableAt.getTime()).toBe(listed.reminder.availableAt.getTime());
  });

  it("does not resurrect a reminder cancelled after it was listed", async () => {
    await request(PR, 7);
    advanceHours(HOURS);
    const now = new Date(clock);
    const [listed] = await listDueWithContext(db, now, BATCH);
    if (!listed) throw new Error("expected a due reminder");
    await cancel(PR, 7);

    await deferReminder(db, listed.reminder, new Date(clock + HOLD_MS), now);

    const [row] = await rowsOf(PR);
    expect(row?.status).toBe("cancelled");
  });
});
