import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./client.ts";
import { markDeliverySeen } from "./repositories/deliveries.ts";
import { findByGithubId, upsertIdentity } from "./repositories/identities.ts";
import { completeJob, enqueueJob } from "./repositories/jobs.ts";
import {
  findByHeadSha,
  findByRepoNumber,
  prId,
  upsertPullRequest,
} from "./repositories/pullRequests.ts";
import {
  cancelForReviewer,
  claimReminder,
  listDue,
  scheduleReminder,
} from "./repositories/reminders.ts";
import { jobs } from "./schema.ts";
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
    const byHead = await findByHeadSha(db, "def456");
    expect(byHead?.number).toBe(1423);
    expect(await findByHeadSha(db, "abc123")).toBeUndefined();
  });
});

describe("dedupe", () => {
  it("recording a delivery id twice is a no-op after the first", async () => {
    expect(await markDeliverySeen(db, "delivery-1")).toBe(true);
    expect(await markDeliverySeen(db, "delivery-1")).toBe(false);
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
    await completeJob(db, job.id);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id)).limit(1);
    expect(row?.status).toBe("done");
    expect(row?.raw).toBeNull();
  });
});
