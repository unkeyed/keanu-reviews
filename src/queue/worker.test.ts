import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "#app";
import type { JobRow } from "#db";
import { type Logger, Retry, createLogger } from "#lib";
import type { Db } from "../db/client.ts";
import { jobs } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { createGithubEmailFetcher } from "../github/users.ts";
import { applyPullRequestSource, claimPullRequestLifecycle, prId } from "../pr/store.ts";
import { keys } from "../slack/catalog.ts";
import { channelSink, claim, createLedger } from "../slack/ledger.ts";
import { handlerDeps } from "../testing/deps.ts";
import { type PullRequestPayload, pullRequestEvent } from "../testing/events.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
import { convergePullRequest } from "../testing/pr.ts";
import { drainQueue, enqueueTestJob, tick } from "../testing/queue.ts";
import { LEASE_MS, claimNextJob } from "./store.ts";
import {
  type Claimed,
  HANDLER_TIMEOUT_MS,
  MAX_ATTEMPTS,
  createWorker,
  startWorker,
} from "./worker.ts";

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

const quiet = () => createLogger("error");
const enqueue = (deliveryId: string, raw: unknown = {}) =>
  enqueueTestJob(db, { deliveryId, event: "pull_request", action: "opened", raw });
const row = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0];

describe("worker retries", () => {
  it("backs off a failed job, then retains its payload for admin replay", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const job = await enqueue("retry-job", { private: "payload" });
    const worker = createWorker(db, quiet(), async () => {
      throw new Error("Slack unavailable");
    });

    const dueTimes: number[] = [];
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const startedAt = Date.now();
      expect(await tick(worker)).toBe(true);
      const pending = await row(job.id);
      expect(pending?.status).toBe("pending");
      expect(pending?.raw).toEqual({ private: "payload" });
      dueTimes.push((pending?.availableAt.getTime() ?? 0) - startedAt);
      expect(await tick(worker)).toBe(false);
      vi.setSystemTime(pending?.availableAt ?? new Date());
    }
    expect(dueTimes).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000]);

    expect(await tick(worker)).toBe(true);
    const failed = await row(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(MAX_ATTEMPTS);
    expect(failed?.raw).toEqual({ private: "payload" });
  });

  it("fails a job whose payload can never parse on the first attempt", async () => {
    const job = await enqueue("malformed", {
      action: "opened",
      repository: { full_name: "unkey/api" },
    });
    const error = vi.fn();
    const worker = createWorker(
      db,
      { ...quiet(), error },
      createDispatcher(handlerDeps(db, new FakeSlackGateway())),
    );

    expect(await tick(worker)).toBe(true);
    expect(await row(job.id)).toMatchObject({ status: "failed", attempts: 1, raw: job.raw });
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
    vi.useFakeTimers({ toFake: ["Date"] });
    const job = await enqueue("crashed-final-attempt", { private: "payload" });
    await db
      .update(jobs)
      .set({ status: "processing", attempts: MAX_ATTEMPTS, claimedAt: new Date() })
      .where(eq(jobs.id, job.id));
    vi.setSystemTime(Date.now() + LEASE_MS);
    const dispatch = vi.fn(async () => undefined);

    expect(await tick(createWorker(db, quiet(), dispatch))).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    const failed = await row(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.raw).toEqual({ private: "payload" });
  });
});

describe("worker retry hints", () => {
  const availableAt = async (id: string) => {
    const r = await row(id);
    return { status: r?.status, at: r?.availableAt.getTime() };
  };
  const settle = async (worker: ReturnType<typeof createWorker>, id: string) => {
    for (;;) {
      await drainQueue(worker);
      const r = await row(id);
      if (r?.status !== "pending") return r;
      vi.setSystemTime(r.availableAt);
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
    vi.useFakeTimers({ toFake: ["Date"] });
    const short = await enqueue("hint-short");
    const long = await enqueue("hint-long");
    const clock = Date.now();
    const worker = createWorker(db, quiet(), async (job) => {
      throw new Retry("busy", undefined, job.id === short.id ? 90_000 : 3_600_000);
    });

    await drainQueue(worker);

    expect(await availableAt(short.id)).toEqual({ status: "pending", at: clock + 90_000 });
    expect(await availableAt(long.id)).toEqual({ status: "pending", at: clock + 300_000 });
  });

  it("waits up to fifteen minutes for a GitHub rate-limit reset", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const soon = await enqueue("rate-limit-soon");
    const later = await enqueue("rate-limit-later");
    const clock = Date.now();
    const resetIn = (job: JobRow) => (job.id === soon.id ? 12 * 60_000 : 60 * 60_000);
    const auth = { getToken: async () => "token", invalidate: () => {} };
    const worker = createWorker(db, quiet(), async (job) => {
      const reset = Math.ceil((Date.now() + resetIn(job)) / 1000);
      const fetchEmail = createGithubEmailFetcher(auth, "42", {
        fetch: async () =>
          Response.json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
            },
          ),
      });
      await fetchEmail("oz");
    });

    await drainQueue(worker);

    const soonAt = (await availableAt(soon.id)).at ?? 0;
    expect(soonAt - clock).toBeGreaterThanOrEqual(12 * 60_000);
    expect(soonAt - clock).toBeLessThan(12 * 60_000 + 1_000);
    expect(await availableAt(later.id)).toMatchObject({ status: "pending" });
    expect(((await availableAt(later.id)).at ?? 0) - clock).toBe(15 * 60_000);
  });

  it("delivers a Slack effect once a crashed holder's lease lifts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await applyPullRequestSource(db, {
      repoFullName: "unkey/api",
      number: 1,
      githubPrId: 1,
      currentState: "pr",
    });
    const effect = keys.root(prId("unkey/api", 1));
    await claim(db, effect, new Date());
    const slack = new FakeSlackGateway();
    const job = await enqueue("effect-held");
    const worker = createWorker(db, quiet(), async () => {
      await createLedger(db).deliver(effect, channelSink(slack, "C1"), opened);
    });

    const settled = await settle(worker, job.id);

    expect(settled?.status).toBe("done");
    expect(Date.now()).toBeGreaterThanOrEqual(start + 2 * 60_000);
    expect(slack.messages.map((m) => m.text)).toEqual(["PR #1: opened"]);
  });

  it("retries within seconds while a live run holds the Slack effect", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await applyPullRequestSource(db, {
      repoFullName: "unkey/api",
      number: 1,
      githubPrId: 1,
      currentState: "pr",
    });
    const effect = keys.root(prId("unkey/api", 1));
    await claim(db, effect, new Date());
    const job = await enqueue("effect-live");
    const worker = createWorker(db, quiet(), async () => {
      await createLedger(db).deliver(effect, channelSink(new FakeSlackGateway(), "C1"), opened);
    });

    await drainQueue(worker);
    expect(await availableAt(job.id)).toEqual({ status: "pending", at: start + 2_000 });
  });

  it("retries a PR lifecycle event after a crashed holder's lease instead of failing it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await claimPullRequestLifecycle(db, 999);
    const slack = new FakeSlackGateway();
    const job = await enqueue("lifecycle-held");
    const worker = createWorker(db, quiet(), async () => {
      await convergePullRequest(handlerDeps(db, slack), pullRequestEvent(openedPayload));
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
    const worker = createWorker(db, quiet(), async () => {
      await convergePullRequest(
        handlerDeps(db, new FakeSlackGateway()),
        pullRequestEvent(openedPayload),
      );
    });

    await drainQueue(worker);
    expect(await availableAt(job.id)).toEqual({ status: "pending", at: start + 2_000 });
  });

  it("waits only for the time left on a PR lifecycle lease a crashed holder left", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await claimPullRequestLifecycle(db, 999, { now: new Date(start - 4.5 * 60_000) });
    const job = await enqueue("lifecycle-nearly-free");
    const worker = createWorker(db, quiet(), async () => {
      await convergePullRequest(
        handlerDeps(db, new FakeSlackGateway()),
        pullRequestEvent(openedPayload),
      );
    });

    await drainQueue(worker);
    expect(await availableAt(job.id)).toEqual({ status: "pending", at: start + 30_000 });
  });
});

describe("worker concurrency", () => {
  const queued = async (...specs: [id: string, pr: number | undefined][]) => {
    const base = Date.now() - 60_000;
    for (const [i, [id, pr]] of specs.entries()) {
      const raw =
        pr === undefined
          ? {}
          : { repository: { full_name: "unkey/api" }, pull_request: { number: pr } };
      const event = pr === undefined ? "check_run" : "pull_request";
      await enqueueTestJob(db, { deliveryId: id, event, action: "edited", raw });
      const at = new Date(base + i);
      await db.update(jobs).set({ createdAt: at, availableAt: at }).where(eq(jobs.id, id));
    }
  };
  const heldJobs = () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const signals = new Map<string, AbortSignal>();
    const dispatch = async (job: JobRow, signal: AbortSignal) => {
      started.push(job.id);
      signals.set(job.id, signal);
      await new Promise<void>((resolve) => releases.set(job.id, resolve));
    };
    return { dispatch, started, signals, release: (id: string) => releases.get(id)?.() };
  };
  const statuses = async () =>
    Object.fromEntries((await db.select().from(jobs)).map((j) => [j.id, j.status]));

  it("runs different PRs at once and one PR's jobs one at a time, in claim order", async () => {
    await queued(["a1", 1], ["a2", 1], ["b1", 2], ["u1", undefined]);
    const held = heldJobs();
    const loop = startWorker(createWorker(db, quiet(), held.dispatch), quiet(), 4);
    loop.wake();

    await vi.waitFor(() => expect(held.started).toEqual(["a1", "b1", "u1"]));
    held.release("b1");
    held.release("u1");
    await vi.waitFor(async () => expect((await statuses()).u1).toBe("done"));
    expect(held.started).toEqual(["a1", "b1", "u1"]);

    held.release("a1");
    await vi.waitFor(() => expect(held.started).toEqual(["a1", "b1", "u1", "a2"]));
    held.release("a2");
    await loop.stop();
    expect(await statuses()).toEqual({ a1: "done", a2: "done", b1: "done", u1: "done" });
  });

  it("runs one job at a time with a single slot", async () => {
    await queued(["a1", 1], ["b1", 2]);
    const held = heldJobs();
    const loop = startWorker(createWorker(db, quiet(), held.dispatch), quiet(), 1);
    loop.wake();

    await vi.waitFor(() => expect(held.started).toEqual(["a1"]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held.started).toEqual(["a1"]);
    held.release("a1");
    await vi.waitFor(() => expect(held.started).toEqual(["a1", "b1"]));
    held.release("b1");
    await loop.stop();
  });

  it("starts a chained job's timeout at its turn and renews its lease while it waits", async () => {
    fakeLeaseTimers();
    await queued(["t1", 1], ["t2", 1]);
    const held = heldJobs();
    const worker = createWorker(db, quiet(), held.dispatch);
    const first = await worker.claim();
    const second = await worker.claim();

    await vi.advanceTimersByTimeAsync(90_000);
    expect(held.started).toEqual(["t1"]);
    expect(await claimNextJob(db)).toBeUndefined();

    held.release("t1");
    await first?.settled;
    await vi.advanceTimersByTimeAsync(0);
    expect(held.started).toEqual(["t1", "t2"]);
    await vi.advanceTimersByTimeAsync(HANDLER_TIMEOUT_MS - 1);
    expect(held.signals.get("t2")?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second?.settled;
    expect(held.signals.get("t2")?.aborted).toBe(true);
    expect(await row("t2")).toMatchObject({ status: "pending", attempts: 1 });
    held.release("t2");
  });

  it("never runs a chained job whose lease another worker took while it waited", async () => {
    fakeLeaseTimers();
    await queued(["l1", 1], ["l2", 1]);
    const held = heldJobs();
    const warn = vi.fn();
    const worker = createWorker(db, { ...quiet(), warn }, held.dispatch);
    const first = await worker.claim();
    const second = await worker.claim();
    const stolenAt = new Date(Date.now() + 1);
    await db.update(jobs).set({ attempts: 2, claimedAt: stolenAt }).where(eq(jobs.id, "l2"));

    await vi.advanceTimersByTimeAsync(LEASE_MS / 3);
    expect(warn).toHaveBeenCalledWith("job lease lost to another worker", {
      jobId: "l2",
      event: "pull_request",
    });
    held.release("l1");
    await first?.settled;
    await second?.settled;

    expect(held.started).toEqual(["l1"]);
    expect(await row("l2")).toMatchObject({
      status: "processing",
      attempts: 2,
      claimedAt: stolenAt,
    });
  });

  it("stop hands back chained jobs that never ran and waits for the running ones", async () => {
    await queued(["s1", 1], ["s2", 1], ["s3", 2]);
    const held = heldJobs();
    const loop = startWorker(createWorker(db, quiet(), held.dispatch), quiet(), 4);
    loop.wake();
    await vi.waitFor(() => expect(held.started).toEqual(["s1", "s3"]));

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await vi.waitFor(async () =>
      expect(await row("s2")).toMatchObject({ status: "pending", attempts: 0, claimedAt: null }),
    );
    expect(stopped).toBe(false);

    held.release("s1");
    held.release("s3");
    await stopping;
    expect(held.started).toEqual(["s1", "s3"]);
    expect(await statuses()).toEqual({ s1: "done", s2: "pending", s3: "done" });
  });
});

function heldHandler() {
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let signal: AbortSignal | undefined;
  const dispatch = async (_job: JobRow, s: AbortSignal) => {
    signal = s;
    started();
    await finished;
  };
  return { dispatch, running, finish, signal: () => signal };
}

const fakeLeaseTimers = () =>
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });

describe("worker lease", () => {
  it("keeps a job that outlives its lease from being claimed by another worker", async () => {
    fakeLeaseTimers();
    const job = await enqueue("slow-job");
    const handler = heldHandler();
    const ticking = tick(createWorker(db, quiet(), handler.dispatch));
    await handler.running;

    await vi.advanceTimersByTimeAsync(LEASE_MS + LEASE_MS / 3);
    expect(await claimNextJob(db)).toBeUndefined();

    handler.finish();
    await ticking;
    expect(await row(job.id)).toMatchObject({ status: "done", attempts: 1 });
  });

  it("aborts the handler and leaves the job alone once another worker holds its lease", async () => {
    fakeLeaseTimers();
    const job = await enqueue("stolen-job", { private: "payload" });
    const handler = heldHandler();
    const warn = vi.fn();
    const ticking = tick(createWorker(db, { ...quiet(), warn }, handler.dispatch));
    await handler.running;
    const stolenAt = new Date(Date.now() + 1);
    await db.update(jobs).set({ attempts: 2, claimedAt: stolenAt }).where(eq(jobs.id, job.id));

    await vi.advanceTimersByTimeAsync(LEASE_MS / 3);

    expect(await ticking).toBe(true);
    expect(handler.signal()?.aborted).toBe(true);
    expect(warn).toHaveBeenCalledWith("job lease lost to another worker", {
      jobId: job.id,
      event: "pull_request",
    });
    expect(await row(job.id)).toMatchObject({
      status: "processing",
      attempts: 2,
      claimedAt: stolenAt,
      raw: { private: "payload" },
    });
    handler.finish();
  });

  it("aborts a handler that runs past the timeout and retries its job", async () => {
    fakeLeaseTimers();
    const job = await enqueue("hung-job");
    const handler = heldHandler();
    const error = vi.fn();
    const ticking = tick(createWorker(db, { ...quiet(), error }, handler.dispatch));
    await handler.running;
    const startedAt = Date.now();

    await vi.advanceTimersByTimeAsync(HANDLER_TIMEOUT_MS - 1);
    expect(handler.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await ticking).toBe(true);
    expect(handler.signal()?.aborted).toBe(true);
    expect(error).toHaveBeenCalledWith("job failed", {
      jobId: job.id,
      event: "pull_request",
      err: `job handler timed out after ${HANDLER_TIMEOUT_MS}ms`,
    });
    const retried = await row(job.id);
    expect(retried).toMatchObject({ status: "pending", attempts: 1, claimedAt: null });
    expect(retried?.availableAt.getTime()).toBe(startedAt + HANDLER_TIMEOUT_MS + 2_000);
    handler.finish();
  });

  it("stays under the window in which another worker could take over a Slack effect", () => {
    expect(HANDLER_TIMEOUT_MS + LEASE_MS / 3).toBeLessThanOrEqual(2 * 60_000);
  });
});

describe("worker loop", () => {
  const pendingClaims = () => {
    const finishers: ((more: boolean) => void)[] = [];
    let finishJob: () => void = () => {};
    const job = new Promise<void>((resolve) => {
      finishJob = resolve;
    });
    const claim = vi.fn(
      () =>
        new Promise<Claimed | undefined>((resolve) => {
          finishers.push((more) => resolve(more ? { settled: job } : undefined));
        }),
    );
    return { claim, finish: (more: boolean) => finishers.shift()?.(more), finishJob };
  };
  const loopLogger = (): Logger => quiet();

  it("does not overlap drains when one poll takes longer than the timer", async () => {
    vi.useFakeTimers();
    const { claim, finish } = pendingClaims();
    const loop = startWorker({ claim }, loopLogger());

    await vi.advanceTimersByTimeAsync(3_000);
    expect(claim).toHaveBeenCalledTimes(1);

    finish(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(claim).toHaveBeenCalledTimes(2);
    finish(false);
    await loop.stop();
  });

  it("stop resolves after the in-flight job finishes and claims no further jobs", async () => {
    vi.useFakeTimers();
    const { claim, finish, finishJob } = pendingClaims();
    const loop = startWorker({ claim }, loopLogger());
    await vi.advanceTimersByTimeAsync(1_000);
    finish(true);
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stopped).toBe(false);

    finishJob();
    await stopping;
    expect(stopped).toBe(true);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("backs its idle poll off from one second to five, and back to one after work", async () => {
    vi.useFakeTimers();
    let queued = 0;
    const polls: number[] = [];
    const start = Date.now();
    const claim = vi.fn(async () => {
      polls.push(Date.now() - start);
      if (queued === 0) return undefined;
      queued -= 1;
      return { settled: Promise.resolve() };
    });
    const loop = startWorker({ claim }, loopLogger(), 4);

    await vi.advanceTimersByTimeAsync(17_000);
    expect(polls).toEqual([1_000, 3_000, 7_000, 12_000, 17_000]);

    queued = 1;
    polls.length = 0;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls).toEqual([22_000, 22_000]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls).toEqual([22_000, 22_000, 23_000]);
    await loop.stop();
  });

  it("drains at once when nudged, even mid-backoff", async () => {
    vi.useFakeTimers();
    const claim = vi.fn(async () => undefined);
    const loop = startWorker({ claim }, loopLogger(), 4);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(claim).toHaveBeenCalledTimes(3);

    loop.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(4);
    await loop.stop();
  });

  it("drains again right after the run in flight when nudged during it", async () => {
    vi.useFakeTimers();
    const { claim, finish } = pendingClaims();
    const loop = startWorker({ claim }, loopLogger());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claim).toHaveBeenCalledTimes(1);

    loop.wake();
    finish(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(2);
    finish(false);
    await loop.stop();
  });

  it("runs a webhook's job as soon as the webhook nudges the worker", async () => {
    const ran: string[] = [];
    const loop = startWorker(
      createWorker(db, quiet(), async (job) => {
        ran.push(job.id);
      }),
      quiet(),
    );
    await enqueue("nudged");
    const nudgedAt = Date.now();
    loop.wake();
    await vi.waitFor(() => expect(ran).toEqual(["nudged"]), { timeout: 900, interval: 5 });
    expect(Date.now() - nudgedAt).toBeLessThan(900);
    await loop.stop();
    expect((await row("nudged"))?.status).toBe("done");
  });
});
