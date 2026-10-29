import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { claimNextJob, enqueueJob } from "../db/repositories/jobs.ts";
import { claimMessageEffect } from "../db/repositories/messages.ts";
import {
  claimPullRequestLifecycle,
  prId,
  upsertPullRequest,
} from "../db/repositories/pullRequests.ts";
import { jobs } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { type PullRequestPayload, handlePullRequest } from "../handlers/pullRequest.ts";
import { createLogger } from "../logger.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import { createWorker, startWorkerLoop } from "./loop.ts";
import { RetryableError } from "./retryable.ts";

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

describe("worker retry hints", () => {
  const enqueue = (deliveryId: string) =>
    enqueueJob(db, { deliveryId, event: "pull_request", action: "opened", raw: {} });
  const availableAt = async (id: string) => {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    return { status: row?.status, at: row?.availableAt.getTime() };
  };

  it("waits out a hint longer than the backoff and caps it at five minutes", async () => {
    const short = await enqueue("hint-short");
    const long = await enqueue("hint-long");
    const clock = Math.max(short.availableAt.getTime(), long.availableAt.getTime());
    const worker = createWorker({
      db,
      logger: createLogger("error"),
      router: async (job) => {
        throw new RetryableError("busy", undefined, job.id === short.id ? 90_000 : 3_600_000);
      },
      now: () => clock,
    });

    await worker.drain();

    expect(await availableAt(short.id)).toEqual({ status: "pending", at: clock + 90_000 });
    expect(await availableAt(long.id)).toEqual({ status: "pending", at: clock + 300_000 });
  });

  it("delivers a Slack effect once a crashed holder's lease lifts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await upsertPullRequest(db, {
      repoFullName: "unkey/api",
      number: 1,
      githubPrId: 1,
      currentState: "pr",
    });
    const effect = { prId: prId("unkey/api", 1), kind: "lifecycle", githubEventRef: "opened" };
    await claimMessageEffect(db, effect);
    const slack = new FakeSlackClient();
    const job = await enqueue("effect-held");
    const worker = createWorker({
      db,
      logger: createLogger("error"),
      router: async () => {
        await deliverSlackMessage(db, slack, effect, { channel: "C1", text: "opened" });
      },
    });

    await worker.drain();
    expect(await availableAt(job.id)).toEqual({ status: "pending", at: start + 2 * 60_000 });
    expect(slack.messages).toEqual([]);

    vi.setSystemTime(start + 2 * 60_000);
    await worker.drain();

    expect(await availableAt(job.id)).toMatchObject({ status: "done" });
    expect(slack.messages.map((m) => m.text)).toEqual(["opened"]);
  });

  it("retries a PR lifecycle event after a crashed holder's lease instead of failing it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await claimPullRequestLifecycle(db, 999);
    const slack = new FakeSlackClient();
    const job = await enqueue("lifecycle-held");
    const payload = {
      action: "opened",
      repository: { full_name: "unkey/api" },
      pull_request: {
        number: 1423,
        id: 999,
        draft: false,
        merged: false,
        title: "Add auth",
        html_url: "https://github.com/unkey/api/pull/1423",
        user: { login: "oz", id: 100 },
        head: { sha: "sha1" },
        updated_at: "2026-08-11T12:00:00Z",
      },
    } satisfies PullRequestPayload;
    const worker = createWorker({
      db,
      logger: createLogger("error"),
      router: async () => {
        await handlePullRequest({ db, slack, logger: createLogger("error") }, payload);
      },
    });

    await worker.drain();
    expect(await availableAt(job.id)).toEqual({ status: "pending", at: start + 5 * 60_000 });

    vi.setSystemTime(start + 5 * 60_000);
    await worker.drain();

    expect(await availableAt(job.id)).toMatchObject({ status: "done" });
    expect(slack.channels).toHaveLength(1);
  });

  it("waits only for the time left on a PR lifecycle lease another claim holds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await claimPullRequestLifecycle(db, 999, { now: new Date(start - 4.5 * 60_000) });
    const job = await enqueue("lifecycle-nearly-free");
    const payload = {
      action: "opened",
      repository: { full_name: "unkey/api" },
      pull_request: {
        number: 1423,
        id: 999,
        draft: false,
        merged: false,
        title: "Add auth",
        html_url: "https://github.com/unkey/api/pull/1423",
        user: { login: "oz", id: 100 },
        head: { sha: "sha1" },
        updated_at: "2026-08-11T12:00:00Z",
      },
    } satisfies PullRequestPayload;
    const slack = new FakeSlackClient();
    const worker = createWorker({
      db,
      logger: createLogger("error"),
      router: async () => {
        await handlePullRequest({ db, slack, logger: createLogger("error") }, payload);
      },
    });

    await worker.drain();
    expect(await availableAt(job.id)).toEqual({ status: "pending", at: start + 30_000 });
  });
});

describe("worker loop", () => {
  const pendingTicks = () => {
    const finishers: ((more: boolean) => void)[] = [];
    const tick = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishers.push(resolve);
        }),
    );
    return { tick, finish: (more: boolean) => finishers.shift()?.(more) };
  };

  it("does not overlap drains when one interval takes longer than the timer", async () => {
    vi.useFakeTimers();
    const { tick, finish } = pendingTicks();
    const loop = startWorkerLoop({ tick }, 10, createLogger("error"));

    await vi.advanceTimersByTimeAsync(30);
    expect(tick).toHaveBeenCalledTimes(1);

    finish(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(tick).toHaveBeenCalledTimes(2);
    finish(false);
    await loop.stop();
  });

  it("stop resolves after the in-flight job finishes and claims no further jobs", async () => {
    vi.useFakeTimers();
    const { tick, finish } = pendingTicks();
    const loop = startWorkerLoop({ tick }, 10, createLogger("error"));
    await vi.advanceTimersByTimeAsync(10);

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(stopped).toBe(false);

    finish(true);
    await stopping;
    expect(stopped).toBe(true);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
