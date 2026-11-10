import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "#app";
import { Retry, createLogger } from "#lib";
import type { Db } from "../db/client.ts";
import { claimNextJob, enqueueJob } from "../db/repositories/jobs.ts";
import {
  claimPullRequestLifecycle,
  prId,
  upsertPullRequest,
} from "../db/repositories/pullRequests.ts";
import { jobs } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { handlePullRequest } from "../handlers/pullRequest.ts";
import { keys } from "../slack/catalog.ts";
import { channelSink, claim, createLedger } from "../slack/ledger.ts";
import { type PullRequestPayload, pullRequestEvent } from "../testing/events.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
import { createWorker, startWorkerLoop } from "./loop.ts";

let db: Db;

const opened = async () => ({
  message: {
    kind: "root" as const,
    pr: {
      repo: "unkey/api",
      number: 1,
      title: "opened",
      url: "https://github.com/unkey/api/pull/1",
      authorLogin: "oz",
    },
  },
});
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
      dispatch: async () => {
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

  it("fails a job whose payload can never parse on the first attempt", async () => {
    const job = await enqueueJob(db, {
      deliveryId: "malformed",
      event: "pull_request",
      action: "opened",
      raw: { action: "opened", repository: { full_name: "unkey/api" } },
    });
    const error = vi.fn();
    const worker = createWorker({
      db,
      logger: { ...createLogger("error"), error },
      dispatch: createDispatcher({
        db,
        slack: new FakeSlackGateway(),
        logger: createLogger("error"),
      }),
      now: () => job.availableAt.getTime(),
    });

    expect(await worker.tick()).toBe(true);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row).toMatchObject({ status: "failed", attempts: 1, raw: job.raw });
    expect(error).toHaveBeenCalledWith(
      "job failed permanently",
      expect.objectContaining({
        jobId: job.id,
        reason: "invalid pull_request payload",
        issues: [expect.stringMatching(/^pull_request: /)],
      }),
    );
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
    const dispatch = vi.fn(async () => undefined);
    const worker = createWorker({
      db,
      logger: createLogger("error"),
      dispatch,
      now: () => clock + 1_000,
      maxAttempts: 1,
      retryBaseMs: 1_000,
      leaseMs: 1_000,
    });

    expect(await worker.tick()).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
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
  // Run the job at each retry time it asks for until it stops retrying.
  const settle = async (worker: { drain: () => Promise<number> }, id: string) => {
    for (;;) {
      await worker.drain();
      const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
      if (row?.status !== "pending") return row;
      vi.setSystemTime(row.availableAt);
    }
  };
  const openedPayload = {
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

  it("waits out a hint longer than the backoff and caps it at five minutes", async () => {
    const short = await enqueue("hint-short");
    const long = await enqueue("hint-long");
    const clock = Math.max(short.availableAt.getTime(), long.availableAt.getTime());
    const worker = createWorker({
      db,
      logger: createLogger("error"),
      dispatch: async (job) => {
        throw new Retry("busy", undefined, job.id === short.id ? 90_000 : 3_600_000);
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
    const effect = keys.root(prId("unkey/api", 1));
    await claim(db, effect, new Date());
    const slack = new FakeSlackGateway();
    const job = await enqueue("effect-held");
    const worker = createWorker({
      db,
      logger: createLogger("error"),
      dispatch: async () => {
        await createLedger(db).deliver(effect, channelSink(slack, "C1"), opened);
      },
    });

    const settled = await settle(worker, job.id);

    expect(settled?.status).toBe("done");
    expect(Date.now()).toBeGreaterThanOrEqual(start + 2 * 60_000);
    expect(slack.messages.map((m) => m.text)).toEqual(["PR #1: opened"]);
  });

  it("retries within seconds while a live run holds the Slack effect", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await upsertPullRequest(db, {
      repoFullName: "unkey/api",
      number: 1,
      githubPrId: 1,
      currentState: "pr",
    });
    const effect = keys.root(prId("unkey/api", 1));
    await claim(db, effect, new Date());
    const job = await enqueue("effect-live");
    const worker = createWorker({
      db,
      logger: createLogger("error"),
      dispatch: async () => {
        await createLedger(db).deliver(effect, channelSink(new FakeSlackGateway(), "C1"), opened);
      },
    });

    await worker.drain();
    expect(await availableAt(job.id)).toEqual({ status: "pending", at: start + 2_000 });
  });

  it("retries a PR lifecycle event after a crashed holder's lease instead of failing it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await claimPullRequestLifecycle(db, 999);
    const slack = new FakeSlackGateway();
    const job = await enqueue("lifecycle-held");
    const worker = createWorker({
      db,
      logger: createLogger("error"),
      dispatch: async () => {
        await handlePullRequest(
          { db, slack, logger: createLogger("error") },
          pullRequestEvent(openedPayload),
        );
      },
    });

    const settled = await settle(worker, job.id);

    expect(settled?.status).toBe("done");
    expect(Date.now()).toBeGreaterThanOrEqual(start + 5 * 60_000);
    expect(slack.channels).toHaveLength(1);
  });

  it("retries within seconds while a live run holds the PR lifecycle", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await claimPullRequestLifecycle(db, 999, { now: new Date(start - 1_000) });
    const job = await enqueue("lifecycle-live");
    const worker = createWorker({
      db,
      logger: createLogger("error"),
      dispatch: async () => {
        await handlePullRequest(
          { db, slack: new FakeSlackGateway(), logger: createLogger("error") },
          pullRequestEvent(openedPayload),
        );
      },
    });

    await worker.drain();
    expect(await availableAt(job.id)).toEqual({ status: "pending", at: start + 2_000 });
  });

  it("waits only for the time left on a PR lifecycle lease a crashed holder left", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await claimPullRequestLifecycle(db, 999, { now: new Date(start - 4.5 * 60_000) });
    const job = await enqueue("lifecycle-nearly-free");
    const worker = createWorker({
      db,
      logger: createLogger("error"),
      dispatch: async () => {
        await handlePullRequest(
          { db, slack: new FakeSlackGateway(), logger: createLogger("error") },
          pullRequestEvent(openedPayload),
        );
      },
    });

    await worker.drain();
    expect(await availableAt(job.id)).toEqual({ status: "pending", at: start + 30_000 });
  });
});

describe("worker lease", () => {
  it("keeps a job that outlives its lease from being claimed by another worker", async () => {
    const job = await enqueueJob(db, {
      deliveryId: "slow-job",
      event: "pull_request",
      action: "opened",
      raw: {},
    });
    const leaseMs = 300;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const worker = createWorker({
      db,
      logger: createLogger("error"),
      dispatch: async () => {
        started();
        await finished;
      },
      leaseMs,
    });

    const ticking = worker.tick();
    await running;
    await new Promise((resolve) => setTimeout(resolve, leaseMs * 3));
    expect(await claimNextJob(db, { leaseMs })).toBeUndefined();

    finish();
    await ticking;
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row).toMatchObject({ status: "done", attempts: 1 });
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
