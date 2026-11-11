import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertIdentity } from "#identity";
import { findAllByRepoHeadSha, findAllByRepoNumbers, findByRepoNumber } from "#pr";
import { enqueueDeliveryJob } from "#queue";
import {
  cancelForReviewer,
  claimReminder,
  isReminderClaimCurrent,
  listDueWithContext,
  scheduleReminder,
} from "#reminders";
import { findByGithubId } from "../identity/store.ts";
import {
  applyPullRequestSource,
  claimPullRequestLifecycle,
  prId,
  releasePullRequestLifecycle,
} from "../pr/store.ts";
import type { Db } from "./client.ts";
import { jobs, messages, processedDeliveries, reminders } from "./schema.ts";
import { createTestDb } from "./testDb.ts";

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

describe("pull_requests", () => {
  it("leases lifecycle reconciliation per GitHub PR and fences stale release", async () => {
    const stale = await claimPullRequestLifecycle(db, 999, {
      now: new Date(1_000),
      leaseMs: 5_000,
    });
    expect(stale).toBeDefined();
    expect(
      await claimPullRequestLifecycle(db, 999, { now: new Date(5_999), leaseMs: 5_000 }),
    ).toBeUndefined();
    const current = await claimPullRequestLifecycle(db, 999, {
      now: new Date(6_000),
      leaseMs: 5_000,
    });
    if (!stale || !current) throw new Error("expected lifecycle claims");

    expect(await releasePullRequestLifecycle(db, stale)).toBe(false);
    expect(await releasePullRequestLifecycle(db, current)).toBe(true);
  });

  it("upsert is idempotent on (repo, number) — updates, does not duplicate", async () => {
    await applyPullRequestSource(db, {
      repoFullName: "unkey/api",
      number: 1423,
      githubPrId: 999,
      currentState: "draft",
    });
    await applyPullRequestSource(db, {
      repoFullName: "unkey/api",
      number: 1423,
      githubPrId: 999,
      currentState: "pr",
    });
    const row = await findByRepoNumber(db, "unkey/api", 1423);
    expect(row?.currentState).toBe("pr");
    expect(row?.id).toBe(prId("unkey/api", 1423));
  });

  it("updates head_sha on a synchronize upsert and finds the PR by it", async () => {
    await applyPullRequestSource(db, {
      repoFullName: "unkey/api",
      number: 1423,
      githubPrId: 999,
      currentState: "pr",
      headSha: "abc123",
    });
    await applyPullRequestSource(db, {
      repoFullName: "unkey/api",
      number: 1423,
      githubPrId: 999,
      currentState: "pr",
      headSha: "def456",
    });
    const byHead = await findAllByRepoHeadSha(db, "unkey/api", "def456");
    expect(byHead.map((row) => row.number)).toEqual([1423]);
    expect(await findAllByRepoHeadSha(db, "unkey/api", "abc123")).toEqual([]);
  });

  it("preserves the row id and foreign-key identity when a repository is renamed", async () => {
    const original = (
      await applyPullRequestSource(db, {
        repoFullName: "unkey/api",
        number: 1423,
        githubPrId: 999,
        currentState: "pr",
      })
    ).row;
    const renamed = (
      await applyPullRequestSource(db, {
        repoFullName: "unkey/platform",
        number: 1423,
        githubPrId: 999,
        currentState: "pr",
      })
    ).row;

    expect(renamed.id).toBe(original.id);
    expect(await findByRepoNumber(db, "unkey/api", 1423)).toBeUndefined();
    expect((await findByRepoNumber(db, "unkey/platform", 1423))?.id).toBe(original.id);
  });

  it("finds repository-scoped PR numbers in caller order", async () => {
    await applyPullRequestSource(db, {
      repoFullName: "unkey/api",
      number: 7,
      githubPrId: 700,
      currentState: "pr",
    });
    await applyPullRequestSource(db, {
      repoFullName: "unkey/api",
      number: 9,
      githubPrId: 900,
      currentState: "pr",
    });
    await applyPullRequestSource(db, {
      repoFullName: "other/api",
      number: 7,
      githubPrId: 701,
      currentState: "pr",
    });

    const rows = await findAllByRepoNumbers(db, "unkey/api", [9, 404, 7]);
    expect(rows.map((row) => row.number)).toEqual([9, 7]);
  });
});

describe("dedupe", () => {
  it("persists the delivery marker and durable job in one transaction", async () => {
    const result = await enqueueDeliveryJob(db, {
      deliveryId: "delivery-atomic",
      event: "pull_request",
      action: "opened",
      raw: { private: "payload" },
    });

    expect(result.isNew).toBe(true);
    expect(await db.select().from(processedDeliveries)).toHaveLength(1);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it("rolls the delivery marker back when durable job insertion fails", async () => {
    await db.insert(jobs).values({
      id: "delivery-conflict",
      deliveryId: "unrelated-delivery",
      event: "pull_request",
      action: "opened",
      raw: {},
    });

    await expect(
      enqueueDeliveryJob(db, {
        deliveryId: "delivery-conflict",
        event: "pull_request",
        action: "opened",
        raw: { private: "payload" },
      }),
    ).rejects.toThrow();

    const markers = await db
      .select()
      .from(processedDeliveries)
      .where(eq(processedDeliveries.deliveryId, "delivery-conflict"));
    expect(markers).toHaveLength(0);
  });
});

describe("reminders", () => {
  const LEASE_MS = 5 * 60_000;
  const stamp = (updatedAt: Date, version = "") => ({ updatedAt, version });
  const seedPr = () =>
    applyPullRequestSource(db, {
      repoFullName: "unkey/api",
      number: 1,
      githubPrId: 1,
      currentState: "pr",
    });

  it("atomic claim returns the row to exactly one caller under concurrent claims", async () => {
    await seedPr();
    const r = await scheduleReminder(db, {
      prId: prId("unkey/api", 1),
      reviewerGithubId: 7,
      dueAt: new Date(Date.now() - 1000),
      stamp: stamp(new Date(0)),
    });
    const now = new Date();
    const [a, b] = await Promise.all([claimReminder(db, r.id, now), claimReminder(db, r.id, now)]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.status).toBe("sending");
  });

  it("allows cancellation to suppress a reminder while it is claimed", async () => {
    await seedPr();
    const r = await scheduleReminder(db, {
      prId: prId("unkey/api", 1),
      reviewerGithubId: 7,
      dueAt: new Date(1_000),
      stamp: stamp(new Date(0)),
    });
    const claimed = await claimReminder(db, r.id, new Date(2_000));
    expect(claimed).toBeDefined();
    if (!claimed) throw new Error("expected reminder claim");

    await cancelForReviewer(db, prId("unkey/api", 1), 7, stamp(new Date()));

    expect(await isReminderClaimCurrent(db, claimed)).toBe(false);
    const [row] = await db.select().from(reminders).where(eq(reminders.id, r.id));
    expect(row?.status).toBe("cancelled");
  });

  it("reclaims an expired reminder sending lease", async () => {
    await seedPr();
    const r = await scheduleReminder(db, {
      prId: prId("unkey/api", 1),
      reviewerGithubId: 7,
      dueAt: new Date(1_000),
      stamp: stamp(new Date(0)),
    });
    await claimReminder(db, r.id, new Date(2_000));
    const expiry = 2_000 + LEASE_MS;
    expect(await listDueWithContext(db, new Date(expiry - 1), 50)).toHaveLength(0);
    expect(await listDueWithContext(db, new Date(expiry), 50)).toHaveLength(1);
    expect(await claimReminder(db, r.id, new Date(expiry))).toBeDefined();
  });

  it("cancel flips a pending reminder so it no longer lists as due", async () => {
    await seedPr();
    await scheduleReminder(db, {
      prId: prId("unkey/api", 1),
      reviewerGithubId: 7,
      dueAt: new Date(Date.now() - 1000),
      stamp: stamp(new Date(0)),
    });
    await cancelForReviewer(db, prId("unkey/api", 1), 7, stamp(new Date()));
    expect(await listDueWithContext(db, new Date(), 50)).toHaveLength(0);
  });

  it("lists a due reminder with its PR and the reviewer's linked Slack user", async () => {
    await seedPr();
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    for (const reviewer of [7, 8]) {
      await scheduleReminder(db, {
        prId: prId("unkey/api", 1),
        reviewerGithubId: reviewer,
        dueAt: new Date(1_000),
        stamp: stamp(new Date(0)),
      });
    }
    await applyPullRequestSource(db, {
      repoFullName: "unkey/api",
      number: 2,
      githubPrId: 2,
      currentState: "draft",
      channelId: "C2",
      headSha: "sha-2",
    });
    await scheduleReminder(db, {
      prId: prId("unkey/api", 2),
      reviewerGithubId: 7,
      dueAt: new Date(1_000),
      stamp: stamp(new Date(0)),
    });

    const due = await listDueWithContext(db, new Date(2_000), 50);

    expect(due.map((d) => [d.reminder.id, d.pr?.githubPrId, d.reviewerSlackUserId])).toEqual([
      ["unkey/api#1::7", 1, "U7"],
      ["unkey/api#1::8", 1, undefined],
      ["unkey/api#2::7", 2, "U7"],
    ]);
    expect(due[0]?.pr).toEqual({
      githubPrId: 1,
      repoFullName: "unkey/api",
      number: 1,
      currentState: "pr",
      channelId: null,
      headSha: null,
    });
    expect(due[2]?.pr).toMatchObject({ currentState: "draft", channelId: "C2", headSha: "sha-2" });
  });

  it("persists cancellation tombstones so stale requests cannot resurrect", async () => {
    await seedPr();
    const pr = prId("unkey/api", 1);
    await cancelForReviewer(db, pr, 7, stamp(new Date(20_000), "v2"));
    const stale = await scheduleReminder(db, {
      prId: pr,
      reviewerGithubId: 7,
      dueAt: new Date(100_000),
      stamp: stamp(new Date(10_000), "v1"),
    });
    expect(stale.status).toBe("cancelled");
    expect(stale.generation).toBe(1);

    const current = await scheduleReminder(db, {
      prId: pr,
      reviewerGithubId: 7,
      dueAt: new Date(200_000),
      stamp: stamp(new Date(30_000), "v3"),
    });
    expect(current.status).toBe("pending");
    expect(current.generation).toBe(2);
  });
});

describe("identities", () => {
  it("lookup by numeric id returns the mapped Slack id; unknown returns undefined", async () => {
    await upsertIdentity(db, {
      githubUserId: 42,
      githubLogin: "octocat",
      slackUserId: "U123",
      source: "self-link",
    });
    expect((await findByGithubId(db, 42))?.slackUserId).toBe("U123");
    expect(await findByGithubId(db, 99)).toBeUndefined();
  });
});
