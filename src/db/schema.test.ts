import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./client.ts";
import { findByGithubId, upsertIdentity } from "./repositories/identities.ts";
import {
  claimNextJob,
  completeJob,
  enqueueDeliveryJob,
  enqueueJob,
  rescheduleOrFailJob,
  resetFailedJob,
} from "./repositories/jobs.ts";
import {
  claimMessageEffect,
  completeMessageEffect,
  findMessageEffect,
  messageClientMsgId,
  messageNaturalKey,
} from "./repositories/messages.ts";
import {
  claimPullRequestLifecycle,
  findAllByRepoHeadSha,
  findAllByRepoNumbers,
  findByRepoNumber,
  prId,
  releasePullRequestLifecycle,
  upsertPullRequest,
} from "./repositories/pullRequests.ts";
import {
  cancelForReviewer,
  claimReminder,
  isReminderClaimCurrent,
  listDue,
  scheduleReminder,
} from "./repositories/reminders.ts";
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
    await upsertPullRequest(db, {
      repoFullName: "unkey/api",
      number: 1423,
      githubPrId: 999,
      currentState: "draft",
    });
    await upsertPullRequest(db, {
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
    await upsertPullRequest(db, {
      repoFullName: "unkey/api",
      number: 1423,
      githubPrId: 999,
      currentState: "pr",
      headSha: "abc123",
    });
    await upsertPullRequest(db, {
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
    const original = await upsertPullRequest(db, {
      repoFullName: "unkey/api",
      number: 1423,
      githubPrId: 999,
      currentState: "pr",
    });
    const renamed = await upsertPullRequest(db, {
      repoFullName: "unkey/platform",
      number: 1423,
      githubPrId: 999,
      currentState: "pr",
    });

    expect(renamed.id).toBe(original.id);
    expect(await findByRepoNumber(db, "unkey/api", 1423)).toBeUndefined();
    expect((await findByRepoNumber(db, "unkey/platform", 1423))?.id).toBe(original.id);
  });

  it("finds repository-scoped PR numbers in caller order", async () => {
    await upsertPullRequest(db, {
      repoFullName: "unkey/api",
      number: 7,
      githubPrId: 700,
      currentState: "pr",
    });
    await upsertPullRequest(db, {
      repoFullName: "unkey/api",
      number: 9,
      githubPrId: 900,
      currentState: "pr",
    });
    await upsertPullRequest(db, {
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
  const seedPr = () =>
    upsertPullRequest(db, {
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
    });
    const [a, b] = await Promise.all([claimReminder(db, r.id), claimReminder(db, r.id)]);
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
    });
    const claimed = await claimReminder(db, r.id, new Date(2_000), 5_000);
    expect(claimed).toBeDefined();
    if (!claimed) throw new Error("expected reminder claim");

    await cancelForReviewer(db, prId("unkey/api", 1), 7);

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
    });
    await claimReminder(db, r.id, new Date(2_000), 5_000);
    expect(await listDue(db, new Date(6_999), 5_000)).toHaveLength(0);
    expect(await listDue(db, new Date(7_000), 5_000)).toHaveLength(1);
    expect(await claimReminder(db, r.id, new Date(7_000), 5_000)).toBeDefined();
  });

  it("cancel flips a pending reminder so it no longer lists as due", async () => {
    await seedPr();
    await scheduleReminder(db, {
      prId: prId("unkey/api", 1),
      reviewerGithubId: 7,
      dueAt: new Date(Date.now() - 1000),
    });
    await cancelForReviewer(db, prId("unkey/api", 1), 7);
    expect(await listDue(db, new Date())).toHaveLength(0);
  });

  it("persists cancellation tombstones so stale requests cannot resurrect", async () => {
    await seedPr();
    const pr = prId("unkey/api", 1);
    await cancelForReviewer(db, pr, 7, new Date(20_000), "v2");
    const stale = await scheduleReminder(db, {
      prId: pr,
      reviewerGithubId: 7,
      dueAt: new Date(100_000),
      sourceUpdatedAt: new Date(10_000),
      sourceVersion: "v1",
    });
    expect(stale.status).toBe("cancelled");
    expect(stale.generation).toBe(1);

    const current = await scheduleReminder(db, {
      prId: pr,
      reviewerGithubId: 7,
      dueAt: new Date(200_000),
      sourceUpdatedAt: new Date(30_000),
      sourceVersion: "v3",
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

describe("jobs", () => {
  it("purges raw payload on completion (retention, KTD13)", async () => {
    const job = await enqueueJob(db, {
      deliveryId: "d1",
      event: "pull_request",
      action: "opened",
      raw: { secret: "private-repo-diff" },
    });
    const claimed = await claimNextJob(db, { now: job.availableAt });
    expect(claimed?.id).toBe(job.id);
    if (!claimed) throw new Error("expected job claim");
    await completeJob(db, claimed);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id)).limit(1);
    expect(row?.status).toBe("done");
    expect(row?.raw).toBeNull();
  });

  it("reclaims a processing job after its lease expires", async () => {
    const job = await enqueueJob(db, {
      deliveryId: "lease-job",
      event: "pull_request",
      action: "opened",
      raw: {},
    });
    const now = job.availableAt.getTime();
    const first = await claimNextJob(db, { now: new Date(now), leaseMs: 5_000 });
    expect(first?.id).toBe(job.id);
    expect(await claimNextJob(db, { now: new Date(now + 4_999), leaseMs: 5_000 })).toBeUndefined();
    const reclaimed = await claimNextJob(db, {
      now: new Date(now + 5_000),
      leaseMs: 5_000,
    });
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.attempts).toBe(2);
  });

  it("fences a stale worker after its processing lease is reclaimed", async () => {
    const job = await enqueueJob(db, {
      deliveryId: "fenced-job",
      event: "pull_request",
      action: "opened",
      raw: {},
    });
    const now = job.availableAt.getTime();
    const staleClaim = await claimNextJob(db, { now: new Date(now), leaseMs: 5_000 });
    const currentClaim = await claimNextJob(db, {
      now: new Date(now + 5_000),
      leaseMs: 5_000,
    });
    if (!staleClaim || !currentClaim) throw new Error("expected both job claims");

    expect(await completeJob(db, staleClaim)).toBe(false);
    expect(await completeJob(db, currentClaim)).toBe(true);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.status).toBe("done");
  });

  it("retains a terminal payload for one explicit safe replay", async () => {
    const job = await enqueueJob(db, {
      deliveryId: "terminal-job",
      event: "pull_request",
      action: "opened",
      raw: { secret: "private-repo-diff" },
    });
    const now = job.availableAt.getTime();
    const claimed = await claimNextJob(db, { now: new Date(now), leaseMs: 5_000 });
    expect(claimed?.id).toBe(job.id);
    if (!claimed) throw new Error("expected job claim");
    await rescheduleOrFailJob(db, claimed, {
      maxAttempts: 1,
      retryAt: new Date(now + 1_000),
    });

    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.status).toBe("failed");
    expect(row?.raw).toEqual({ secret: "private-repo-diff" });

    expect(await resetFailedJob(db, job.id, new Date(now + 2_000))).toBe(true);
    const [reset] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(reset?.status).toBe("pending");
    expect(reset?.attempts).toBe(0);
    expect(reset?.raw).toEqual({ secret: "private-repo-diff" });
    expect(reset?.availableAt.getTime()).toBe(now + 2_000);
    expect(await resetFailedJob(db, job.id)).toBe(false);
  });
});

describe("messages", () => {
  const seedPr = () =>
    upsertPullRequest(db, {
      repoFullName: "unkey/api",
      number: 1,
      githubPrId: 1,
      currentState: "pr",
    });

  it("uses a stable natural key and deterministic Slack client_msg_id", async () => {
    await seedPr();
    const input = {
      prId: prId("unkey/api", 1),
      kind: "lifecycle",
      githubEventRef: "opened:sha-1",
    };
    const claim = await claimMessageEffect(db, input, { now: new Date(1_000) });
    expect(claim?.naturalKey).toBe(messageNaturalKey(input));
    expect(claim?.clientMsgId).toBe(messageClientMsgId(messageNaturalKey(input)));
    expect(claim?.clientMsgId).toMatch(/^[0-9a-f-]{36}$/);
    expect(claim?.slackTs).toBeNull();
    expect(claim?.status).toBe("sending");
  });

  it("reclaims expired sending effects and fences stale completion", async () => {
    await seedPr();
    const input = {
      prId: prId("unkey/api", 1),
      kind: "review_comment",
      githubEventRef: "55",
    };
    const stale = await claimMessageEffect(db, input, { now: new Date(1_000), leaseMs: 5_000 });
    expect(stale).toBeDefined();
    expect(
      await claimMessageEffect(db, input, { now: new Date(5_999), leaseMs: 5_000 }),
    ).toBeUndefined();
    const current = await claimMessageEffect(db, input, {
      now: new Date(6_000),
      leaseMs: 5_000,
    });
    if (!stale || !current) throw new Error("expected effect claims");
    expect(current.clientMsgId).toBe(stale.clientMsgId);
    expect(await completeMessageEffect(db, stale, "stale-ts")).toBe(false);
    expect(await completeMessageEffect(db, current, "real-ts")).toBe(true);
    expect((await findMessageEffect(db, input))?.slackTs).toBe("real-ts");
    expect(await claimMessageEffect(db, input)).toBeUndefined();
  });

  it("keeps a message effect fenced beyond the worker's default job lease", async () => {
    await seedPr();
    const input = {
      prId: prId("unkey/api", 1),
      kind: "review",
      githubEventRef: "77",
    };
    const first = await claimMessageEffect(db, input, { now: new Date(1_000) });
    expect(first).toBeDefined();

    expect(await claimMessageEffect(db, input, { now: new Date(61_000) })).toBeUndefined();
    expect(await claimMessageEffect(db, input, { now: new Date(121_000) })).toBeDefined();
  });

  it("keeps primary keys database-safe while natural keys deduplicate effects", async () => {
    await upsertPullRequest(db, {
      repoFullName: "unkey/api",
      number: 1,
      githubPrId: 1,
      currentState: "pr",
    });
    const input = { prId: prId("unkey/api", 1), kind: "root", githubEventRef: "root" };
    const claim = await claimMessageEffect(db, input);
    if (!claim) throw new Error("expected message claim");
    await completeMessageEffect(db, claim, "1.0");

    const [row] = await db.select().from(messages);
    expect(row?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
