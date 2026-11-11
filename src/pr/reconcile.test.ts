import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "#lib";
import { scheduleReminder } from "#reminders";
import type { Db } from "../db/client.ts";
import { pullRequests, reminders } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import type { InstallationAuth } from "../github/auth.ts";
import { GithubApiError } from "../github/http.ts";
import {
  type PullRequestSnapshot,
  type PullRequestSnapshotFetcher,
  createPullRequestSnapshotFetcher,
} from "../github/pullRequestSnapshot.ts";
import { handlerDeps } from "../testing/deps.ts";
import { type PullRequestPayload, pullRequestEvent } from "../testing/events.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
import { convergePullRequest } from "../testing/pr.ts";
import type { PrDeps } from "./converge.ts";
import { createClosedPullRequestReconciliation } from "./reconcile.ts";
import { claimPullRequestLifecycle, findByRepoNumber, prId } from "./store.ts";

let db: Db;
let slack: FakeSlackGateway;
let close: () => Promise<void>;
let events: { level: string; msg: string; fields?: Record<string, unknown> }[];

beforeEach(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  close = () => testDb.client.close();
  slack = new FakeSlackGateway();
  events = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await close();
});

function logger(): Logger {
  const record = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    events.push({ level, msg, fields });
  };
  const captured: Logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: () => captured,
  };
  return captured;
}

function handler(over: Partial<PrDeps> = {}): PrDeps {
  return handlerDeps(db, slack, { logger: logger(), ...over });
}

function opened(number: number, githubId: number): PullRequestPayload {
  return {
    action: "opened",
    repository: { full_name: "unkey/api" },
    pull_request: {
      number,
      id: githubId,
      draft: false,
      merged: false,
      title: `Change ${number}`,
      html_url: `https://github.com/unkey/api/pull/${number}`,
      user: { login: "oz", id: 100 },
      head: { sha: `sha${number}`, ref: "feature" },
      base: { ref: "main" },
      updated_at: "2026-08-11T12:00:00Z",
    },
  };
}

function snapshot(
  number: number,
  githubId: number,
  over: Partial<PullRequestSnapshot> = {},
): PullRequestSnapshot {
  return {
    repo: "unkey/api",
    number,
    githubPrId: githubId,
    title: `Change ${number}`,
    url: `https://github.com/unkey/api/pull/${number}`,
    author: { id: 100, login: "oz", isBot: false },
    draft: false,
    headSha: `sha${number}`,
    headRef: "feature",
    baseRef: "main",
    updatedAt: "2026-08-12T15:00:00Z",
    requestedReviewers: [],
    state: "closed",
    merged: false,
    ...over,
  };
}

async function openPr(number: number, githubId: number, deps = handler()): Promise<void> {
  await convergePullRequest(deps, pullRequestEvent(opened(number, githubId)));
}

function finished() {
  return events.find((event) => event.msg === "pull request reconciliation finished")?.fields;
}

describe("closed pull request reconciliation", () => {
  it("archives a merged pull request without the #shipped note or merge comment", async () => {
    const postPrComment = vi.fn(async () => {});
    const deps = handler({
      shippedChannel: "C0SHIPPED",
      postPrComment,
      slackTeamId: "T1",
    });
    await openPr(1, 101, deps);
    await scheduleReminder(db, {
      prId: prId("unkey/api", 1),
      reviewerGithubId: 7,
      dueAt: new Date("2026-08-13T00:00:00Z"),
      stamp: { updatedAt: new Date(0), version: "" },
    });
    const fetchSnapshot = vi.fn<PullRequestSnapshotFetcher>(async () => ({
      snapshot: snapshot(1, 101, { merged: true }),
    }));
    const run = createClosedPullRequestReconciliation(deps, fetchSnapshot);

    await expect(run()).resolves.toMatchObject({
      checked: 1,
      merged: 1,
      closed: 0,
      archived: 1,
      skipped: 0,
      failed: 0,
      skippedShipped: 1,
      skippedMergeComments: 1,
      rateLimited: false,
    });

    expect(slack.channel("C1")?.archived).toBe(true);
    expect(slack.channel("C1")?.name.startsWith("merged-")).toBe(true);
    expect(slack.messages.some((message) => message.channel === "C0SHIPPED")).toBe(false);
    expect(postPrComment).not.toHaveBeenCalled();
    const row = await findByRepoNumber(db, "unkey/api", 1);
    expect(row?.currentState).toBe("merged");
    expect(row?.appliedState).toBe("merged");
    expect(row?.mergeCommentPostedAt).toBeNull();
    const [reminder] = await db
      .select()
      .from(reminders)
      .where(eq(reminders.id, `${prId("unkey/api", 1)}::7`));
    expect(reminder?.status).toBe("cancelled");
    expect(events).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "skipped #shipped note",
        fields: expect.objectContaining({ number: 1 }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "skipped merge comment",
        fields: expect.objectContaining({ number: 1 }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "pull request reconciliation archived channel",
        fields: expect.objectContaining({
          number: 1,
          outcome: "merged",
          channelId: "C1",
          skippedShipped: true,
          skippedMergeComment: true,
        }),
      }),
    );
    expect(finished()).toMatchObject({
      checked: 1,
      merged: 1,
      archived: 1,
      failed: 0,
      skippedShipped: 1,
      skippedMergeComments: 1,
    });

    const messages = slack.messages.length;
    await expect(run()).resolves.toMatchObject({
      checked: 0,
      merged: 0,
      archived: 0,
      skipped: 0,
      failed: 0,
    });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(slack.messages).toHaveLength(messages);
  });

  it("archives a closed, unmerged pull request and does not announce it as shipped", async () => {
    const deps = handler({ shippedChannel: "C0SHIPPED" });
    await openPr(2, 102, deps);
    const fetchSnapshot = vi.fn<PullRequestSnapshotFetcher>(async () => ({
      snapshot: snapshot(2, 102, { merged: false, state: "closed" }),
    }));
    const run = createClosedPullRequestReconciliation(deps, fetchSnapshot);

    await expect(run()).resolves.toMatchObject({
      checked: 1,
      merged: 0,
      closed: 1,
      archived: 1,
      skipped: 0,
      failed: 0,
      skippedShipped: 0,
      skippedMergeComments: 0,
    });
    expect(slack.channel("C1")?.archived).toBe(true);
    expect(slack.channel("C1")?.name.startsWith("closed-")).toBe(true);
    expect(slack.messages.some((message) => message.channel === "C0SHIPPED")).toBe(false);
    const row = await findByRepoNumber(db, "unkey/api", 2);
    expect(row?.currentState).toBe("closed");
    expect(row?.appliedState).toBe("closed");
  });

  const merge = (number: number, githubId: number): PullRequestPayload => ({
    ...opened(number, githubId),
    action: "closed",
    pull_request: {
      ...opened(number, githubId).pull_request,
      merged: true,
      updated_at: new Date().toISOString(),
    },
  });
  const noSnapshots = vi.fn<PullRequestSnapshotFetcher>(async () => ({ snapshot: undefined }));

  it("re-archives a terminal channel that drifted open after a late write", async () => {
    const deps = handler();
    await openPr(1, 101, deps);
    await convergePullRequest(deps, pullRequestEvent(merge(1, 101)));
    expect(slack.channel("C1")?.archived).toBe(true);
    await slack.unarchive("C1");
    expect(slack.channel("C1")?.archived).toBe(false);

    const run = createClosedPullRequestReconciliation(deps, noSnapshots);
    const result = await run();

    expect(result.reArchived).toBe(1);
    expect(slack.channel("C1")?.archived).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        msg: "re-archived PR channel that drifted open after a late write",
        fields: expect.objectContaining({ number: 1, channelId: "C1" }),
      }),
    );
  });

  it("leaves a channel open when its PR reopens after the sweep listed it (F2)", async () => {
    const deps = handler();
    await openPr(1, 101, deps);
    await convergePullRequest(deps, pullRequestEvent(merge(1, 101)));
    await openPr(2, 102, deps);
    await convergePullRequest(deps, pullRequestEvent(merge(2, 102)));
    let listed = () => {};
    const reopened = new Promise<void>((resolve) => {
      listed = resolve;
    }).then(() =>
      convergePullRequest(
        deps,
        pullRequestEvent({
          ...opened(1, 101),
          action: "reopened",
          pull_request: {
            ...opened(1, 101).pull_request,
            updated_at: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      ),
    );
    const isArchived = slack.isArchived.bind(slack);
    slack.isArchived = async (channelId) => {
      if (channelId === "C2") {
        listed();
        await reopened;
      }
      return isArchived(channelId);
    };

    const result = await createClosedPullRequestReconciliation(deps, noSnapshots)();

    expect(result).toMatchObject({ reArchived: 0, failed: 0 });
    expect(slack.channel("C1")).toMatchObject({
      archived: false,
      name: expect.stringMatching(/^pr-/),
    });
    expect(await findByRepoNumber(db, "unkey/api", 1)).toMatchObject({
      currentState: "pr",
      appliedState: "pr",
    });
  });

  it("leaves a drifted channel to the next run while another replica holds the PR", async () => {
    const deps = handler();
    await openPr(1, 101, deps);
    await convergePullRequest(deps, pullRequestEvent(merge(1, 101)));
    await slack.unarchive("C1");
    await claimPullRequestLifecycle(db, 101);

    const result = await createClosedPullRequestReconciliation(deps, noSnapshots)();

    expect(result).toMatchObject({ reArchived: 0, failed: 0 });
    expect(slack.channel("C1")?.archived).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "re-archive sweep skipped; lifecycle already in progress",
        fields: expect.objectContaining({ number: 1, channelId: "C1" }),
      }),
    );
  });

  it("leaves an already-archived terminal channel alone", async () => {
    const deps = handler();
    await openPr(1, 101, deps);
    await convergePullRequest(deps, pullRequestEvent(merge(1, 101)));

    const run = createClosedPullRequestReconciliation(deps, noSnapshots);
    const result = await run();

    expect(result.reArchived).toBe(0);
    expect(slack.channel("C1")?.archived).toBe(true);
  });

  it("leaves a pull request GitHub still reports as open", async () => {
    const deps = handler();
    await openPr(3, 103, deps);
    const fetchSnapshot = vi.fn<PullRequestSnapshotFetcher>(async () => ({
      snapshot: snapshot(3, 103, { state: "open", merged: false }),
    }));
    const run = createClosedPullRequestReconciliation(deps, fetchSnapshot);

    await expect(run()).resolves.toMatchObject({
      checked: 1,
      merged: 0,
      closed: 0,
      archived: 0,
      skipped: 1,
      failed: 0,
    });
    expect(slack.channel("C1")?.archived).toBe(false);
    expect(slack.channel("C1")?.name.startsWith("pr-")).toBe(true);
    const row = await findByRepoNumber(db, "unkey/api", 3);
    expect(row?.currentState).toBe("pr");
    expect(row?.appliedState).toBe("pr");
  });

  it("does nothing when the channel is already archived", async () => {
    const deps = handler();
    await openPr(4, 104, deps);
    await convergePullRequest(
      deps,
      pullRequestEvent({
        ...opened(4, 104),
        action: "closed",
        pull_request: {
          ...opened(4, 104).pull_request,
          merged: true,
          updated_at: "2026-08-12T00:00:00Z",
        },
      }),
    );
    const fetchSnapshot = vi.fn<PullRequestSnapshotFetcher>(async () => {
      throw new Error("GitHub should not be consulted");
    });
    const run = createClosedPullRequestReconciliation(deps, fetchSnapshot);

    await expect(run()).resolves.toMatchObject({
      checked: 0,
      archived: 0,
      skipped: 0,
      failed: 0,
    });
    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(slack.channel("C1")?.archived).toBe(true);
  });

  it("does nothing when the database already shows the pull request closed", async () => {
    const deps = handler();
    await openPr(5, 105, deps);
    await db.update(pullRequests).set({ currentState: "closed" }).where(eq(pullRequests.number, 5));
    const fetchSnapshot = vi.fn<PullRequestSnapshotFetcher>(async () => {
      throw new Error("GitHub should not be consulted");
    });
    const run = createClosedPullRequestReconciliation(deps, fetchSnapshot);

    await expect(run()).resolves.toMatchObject({ checked: 0, archived: 0, failed: 0 });
    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(slack.channel("C1")?.archived).toBe(false);
  });

  it("continues after a GitHub error on one pull request", async () => {
    const deps = handler();
    await openPr(1, 101, deps);
    await openPr(2, 102, deps);
    await openPr(3, 103, deps);
    const fetchSnapshot = vi.fn<PullRequestSnapshotFetcher>(async (_repo, number) => {
      if (number === 2) {
        throw new GithubApiError("GitHub API returned HTTP 500", {
          kind: "http",
          status: 500,
          url: "https://api.github.com/repos/unkey/api/pulls/2",
        });
      }
      return { snapshot: snapshot(number, 100 + number, { merged: true }) };
    });
    const run = createClosedPullRequestReconciliation(deps, fetchSnapshot);

    await expect(run()).resolves.toMatchObject({
      checked: 3,
      merged: 2,
      archived: 2,
      failed: 1,
      skipped: 0,
    });
    expect(slack.channel("C1")?.archived).toBe(true);
    expect(slack.channel("C2")?.archived).toBe(false);
    expect(slack.channel("C3")?.archived).toBe(true);
    const failed = await findByRepoNumber(db, "unkey/api", 2);
    expect(failed?.currentState).toBe("pr");
    expect(events).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "pull request reconciliation failed",
        fields: expect.objectContaining({ number: 2 }),
      }),
    );
  });

  it("backs off on a GitHub rate limit and then archives the rest", async () => {
    const deps = handler();
    await openPr(1, 101, deps);
    await openPr(2, 102, deps);
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/pulls/1")) {
        const calls = fetchFn.mock.calls.filter((call) => String(call[0]).endsWith("/pulls/1"));
        if (calls.length === 1) {
          return new Response(JSON.stringify({ message: "rate limit" }), {
            status: 429,
            headers: { "retry-after": "2", "x-ratelimit-remaining": "0" },
          });
        }
      }
      const number = url.endsWith("/pulls/2") ? 2 : 1;
      return new Response(
        JSON.stringify({
          id: 100 + number,
          number,
          state: "closed",
          merged: true,
          draft: false,
          title: `Change ${number}`,
          html_url: `https://github.com/unkey/api/pull/${number}`,
          updated_at: "2026-08-12T15:00:00Z",
          user: { id: 100, login: "oz" },
          head: { sha: `sha${number}`, ref: "feature" },
          base: { ref: "main" },
        }),
        { status: 200, headers: { "x-ratelimit-remaining": number === 1 ? "10" : "9" } },
      );
    });
    const auth: InstallationAuth = { getToken: async () => "token", invalidate: () => {} };
    const run = createClosedPullRequestReconciliation(
      deps,
      createPullRequestSnapshotFetcher(auth, "42", { fetch: fetchFn }),
    );

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const running = run();
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(running).resolves.toMatchObject({
      checked: 2,
      merged: 2,
      archived: 2,
      failed: 0,
      rateLimited: false,
    });
    expect(slack.channel("C1")?.archived).toBe(true);
    expect(slack.channel("C2")?.archived).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "GitHub rate limit backoff",
        fields: expect.objectContaining({ number: 1, waitMs: 2000 }),
      }),
    );
  });

  it("stops cleanly when the rate limit cannot be waited out, without failing the run", async () => {
    const deps = handler();
    await openPr(1, 101, deps);
    await openPr(2, 102, deps);
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/pulls/2")) throw new Error("second pull request should not be requested");
      return new Response(JSON.stringify({ message: "secondary rate limit" }), {
        status: 429,
        headers: { "retry-after": "7200", "x-ratelimit-remaining": "0" },
      });
    });
    const auth: InstallationAuth = { getToken: async () => "token", invalidate: () => {} };
    const run = createClosedPullRequestReconciliation(
      deps,
      createPullRequestSnapshotFetcher(auth, "42", { fetch: fetchFn }),
    );

    await expect(run()).resolves.toMatchObject({
      checked: 0,
      merged: 0,
      archived: 0,
      failed: 0,
      rateLimited: true,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(slack.channel("C1")?.archived).toBe(false);
    expect(slack.channel("C2")?.archived).toBe(false);
    expect(finished()).toMatchObject({ rateLimited: true, failed: 0 });
  });

  it("stops after a response that reports no remaining budget", async () => {
    const deps = handler();
    await openPr(1, 101, deps);
    await openPr(2, 102, deps);
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/pulls/2")) throw new Error("second pull request should not be requested");
      return new Response(
        JSON.stringify({
          id: 101,
          number: 1,
          state: "closed",
          merged: true,
          draft: false,
          title: "Change 1",
          html_url: "https://github.com/unkey/api/pull/1",
          updated_at: "2026-08-12T15:00:00Z",
          user: { id: 100, login: "oz" },
          head: { sha: "sha1", ref: "feature" },
          base: { ref: "main" },
        }),
        { status: 200, headers: { "x-ratelimit-remaining": "0" } },
      );
    });
    const auth: InstallationAuth = { getToken: async () => "token", invalidate: () => {} };
    const run = createClosedPullRequestReconciliation(
      deps,
      createPullRequestSnapshotFetcher(auth, "42", { fetch: fetchFn }),
    );

    await expect(run()).resolves.toMatchObject({
      checked: 1,
      merged: 1,
      archived: 1,
      failed: 0,
      rateLimited: true,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(slack.channel("C1")?.archived).toBe(true);
    expect(slack.channel("C2")?.archived).toBe(false);
  });

  it("does not overlap runs in one process", async () => {
    const deps = handler();
    await openPr(1, 101, deps);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchSnapshot = vi.fn<PullRequestSnapshotFetcher>(async () => {
      await gate;
      return { snapshot: snapshot(1, 101, { state: "open", merged: false }) };
    });
    const run = createClosedPullRequestReconciliation(deps, fetchSnapshot);

    const first = run();
    await expect(run()).resolves.toMatchObject({ overlapped: true, checked: 0, failed: 0 });
    release();
    await expect(first).resolves.toMatchObject({ overlapped: false, checked: 1, skipped: 1 });
  });
});
