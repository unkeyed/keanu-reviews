import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { findByRepoNumber, prId } from "../db/repositories/pullRequests.ts";
import { scheduleReminder } from "../db/repositories/reminders.ts";
import { pullRequests, reminders } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import type { InstallationAuth } from "../github/auth.ts";
import { GithubApiError } from "../github/http.ts";
import {
  type PullRequestSnapshot,
  type PullRequestSnapshotFetcher,
  createPullRequestSnapshotFetcher,
} from "../github/pullRequestSnapshot.ts";
import {
  type PrHandlerDeps,
  type PullRequestPayload,
  handlePullRequest,
} from "../handlers/pullRequest.ts";
import type { Logger } from "../logger.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import { createClosedPullRequestReconciliation } from "./reconcileClosedPullRequests.ts";

let db: Db;
let slack: FakeSlackClient;
let close: () => Promise<void>;
let events: { level: string; msg: string; fields?: Record<string, unknown> }[];

beforeEach(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  close = () => testDb.client.close();
  slack = new FakeSlackClient();
  events = [];
});

afterEach(() => close());

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

function handler(over: Partial<PrHandlerDeps> = {}): PrHandlerDeps {
  return { db, slack, logger: logger(), ...over };
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
    id: githubId,
    number,
    state: "closed",
    merged: false,
    draft: false,
    title: `Change ${number}`,
    htmlUrl: `https://github.com/unkey/api/pull/${number}`,
    updatedAt: "2026-08-12T15:00:00Z",
    user: { id: 100, login: "oz" },
    headSha: `sha${number}`,
    headRef: "feature",
    baseRef: "main",
    ...over,
  };
}

async function openPr(number: number, githubId: number, deps = handler()): Promise<void> {
  await handlePullRequest(deps, opened(number, githubId));
}

function finished() {
  return events.find((event) => event.msg === "pull request reconciliation finished")?.fields;
}

describe("closed pull request reconciliation", () => {
  it("archives a merged pull request without the #shipped note or merge comment", async () => {
    const postPrComment = vi.fn(async () => {});
    const deps = handler({
      shippedChannel: "C0SHIPPED",
      commentOnMerge: true,
      postPrComment,
      slackTeamId: "T1",
    });
    await openPr(1, 101, deps);
    await scheduleReminder(db, {
      prId: prId("unkey/api", 1),
      reviewerGithubId: 7,
      dueAt: new Date("2026-08-13T00:00:00Z"),
    });
    const fetchSnapshot = vi.fn<PullRequestSnapshotFetcher>(async () => ({
      snapshot: snapshot(1, 101, { merged: true }),
    }));
    const run = createClosedPullRequestReconciliation({
      handler: deps,
      fetchSnapshot,
      logger: deps.logger,
    });

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
    const run = createClosedPullRequestReconciliation({
      handler: deps,
      fetchSnapshot,
      logger: deps.logger,
    });

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
      updated_at: new Date().toISOString(), // recent → inside the re-archive window
    },
  });
  const noSnapshots = vi.fn<PullRequestSnapshotFetcher>(async () => ({ snapshot: undefined }));

  it("re-archives a terminal channel that drifted open after a late write", async () => {
    const deps = handler();
    await openPr(1, 101, deps);
    await handlePullRequest(deps, merge(1, 101));
    expect(slack.channel("C1")?.archived).toBe(true);
    // A late CI/comment/review write would unarchive the channel to deliver.
    await slack.unarchiveChannel("C1");
    expect(slack.channel("C1")?.archived).toBe(false);

    const run = createClosedPullRequestReconciliation({
      handler: deps,
      fetchSnapshot: noSnapshots,
      logger: deps.logger,
    });
    const result = await run();

    expect(result.reArchived).toBe(1);
    expect(slack.channel("C1")?.archived).toBe(true); // closed back up
    expect(events).toContainEqual(
      expect.objectContaining({
        msg: "re-archived PR channel that drifted open after a late write",
        fields: expect.objectContaining({ number: 1, channelId: "C1" }),
      }),
    );
  });

  it("leaves an already-archived terminal channel alone", async () => {
    const deps = handler();
    await openPr(1, 101, deps);
    await handlePullRequest(deps, merge(1, 101)); // archives C1 and leaves it archived

    const run = createClosedPullRequestReconciliation({
      handler: deps,
      fetchSnapshot: noSnapshots,
      logger: deps.logger,
    });
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
    const run = createClosedPullRequestReconciliation({
      handler: deps,
      fetchSnapshot,
      logger: deps.logger,
    });

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
    await handlePullRequest(deps, {
      ...opened(4, 104),
      action: "closed",
      pull_request: {
        ...opened(4, 104).pull_request,
        merged: true,
        updated_at: "2026-08-12T00:00:00Z",
      },
    });
    const fetchSnapshot = vi.fn<PullRequestSnapshotFetcher>(async () => {
      throw new Error("GitHub should not be consulted");
    });
    const run = createClosedPullRequestReconciliation({
      handler: deps,
      fetchSnapshot,
      logger: deps.logger,
    });

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
    const run = createClosedPullRequestReconciliation({
      handler: deps,
      fetchSnapshot,
      logger: deps.logger,
    });

    await expect(run()).resolves.toMatchObject({ checked: 0, archived: 0, failed: 0 });
    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(slack.channel("C1")?.archived).toBe(false);
  });

  it("treats Slack already_archived as a successful archive", async () => {
    const deps = handler();
    await openPr(6, 106, deps);
    slack.archiveChannel = async (channelId) => {
      const channel = slack.channel(channelId);
      if (channel) channel.archived = true;
      throw { data: { error: "already_archived" } };
    };
    const fetchSnapshot = vi.fn<PullRequestSnapshotFetcher>(async () => ({
      snapshot: snapshot(6, 106, { merged: true }),
    }));
    const run = createClosedPullRequestReconciliation({
      handler: deps,
      fetchSnapshot,
      logger: deps.logger,
    });

    await expect(run()).resolves.toMatchObject({
      checked: 1,
      merged: 1,
      archived: 1,
      failed: 0,
    });
    expect(slack.channel("C1")?.archived).toBe(true);
    const row = await findByRepoNumber(db, "unkey/api", 6);
    expect(row?.appliedState).toBe("merged");
    expect(events).toContainEqual(
      expect.objectContaining({ level: "info", msg: "channel already archived" }),
    );
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
    const run = createClosedPullRequestReconciliation({
      handler: deps,
      fetchSnapshot,
      logger: deps.logger,
    });

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
    const sleep = vi.fn(async () => {});
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
    const run = createClosedPullRequestReconciliation({
      handler: deps,
      fetchSnapshot: createPullRequestSnapshotFetcher(auth, "42", {
        fetch: fetchFn,
        sleep,
        logger: deps.logger,
      }),
      logger: deps.logger,
    });

    await expect(run()).resolves.toMatchObject({
      checked: 2,
      merged: 2,
      archived: 2,
      failed: 0,
      rateLimited: false,
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
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
    const sleep = vi.fn(async () => {});
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/pulls/2")) throw new Error("second pull request should not be requested");
      return new Response(JSON.stringify({ message: "secondary rate limit" }), {
        status: 429,
        headers: { "retry-after": "7200", "x-ratelimit-remaining": "0" },
      });
    });
    const auth: InstallationAuth = { getToken: async () => "token", invalidate: () => {} };
    const run = createClosedPullRequestReconciliation({
      handler: deps,
      fetchSnapshot: createPullRequestSnapshotFetcher(auth, "42", {
        fetch: fetchFn,
        sleep,
        maxBackoffMs: 120_000,
      }),
      logger: deps.logger,
    });

    await expect(run()).resolves.toMatchObject({
      checked: 0,
      merged: 0,
      archived: 0,
      failed: 0,
      rateLimited: true,
    });
    expect(sleep).not.toHaveBeenCalled();
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
    const run = createClosedPullRequestReconciliation({
      handler: deps,
      fetchSnapshot: createPullRequestSnapshotFetcher(auth, "42", { fetch: fetchFn }),
      logger: deps.logger,
    });

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
    const run = createClosedPullRequestReconciliation({
      handler: deps,
      fetchSnapshot,
      logger: deps.logger,
    });

    const first = run();
    await expect(run()).resolves.toMatchObject({ overlapped: true, checked: 0, failed: 0 });
    release();
    await expect(first).resolves.toMatchObject({ overlapped: false, checked: 1, skipped: 1 });
  });
});
