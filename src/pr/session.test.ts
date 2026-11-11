import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileArrivalKey } from "#events";
import { upsertIdentity } from "#identity";
import { type ArrivalKey, Retry, createLogger } from "#lib";
import { scheduleReminder } from "#reminders";
import { SlackApiError, keys } from "#slack";
import type { Db } from "../db/client.ts";
import { pullRequests, reminders } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { type PullRequestPayload, pullRequestEvent } from "../testing/events.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
import { convergePullRequest } from "../testing/pr.ts";
import { PullRequestLifecycleBusyError, session } from "./session.ts";
import {
  applyPullRequestSource,
  claimPullRequestLifecycle,
  findByRepoNumber,
  prId,
  pullRequestLifecycleClaimedAt,
  releasePullRequestLifecycle,
  setChannel,
} from "./store.ts";

let db: Db;
let slack: FakeSlackGateway;
let close: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackGateway();
});
afterEach(() => close());

const payload = (
  action: string,
  over: Partial<PullRequestPayload["pull_request"]> = {},
  repoFullName = "unkey/api",
) =>
  ({
    action,
    repository: { full_name: repoFullName },
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
      ...over,
    },
  }) satisfies PullRequestPayload;

const deps = () => ({ db, slack, logger: createLogger("error") });
const arrival = (key: string) => key as ArrivalKey;

describe("PR session channel convergence (U4 channel lifecycle)", () => {
  it("invites the linked PR author into the channel on open", async () => {
    await upsertIdentity(db, {
      githubUserId: 100,
      githubLogin: "oz",
      slackUserId: "U100",
      source: "self-link",
    });
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["U100"] }]);
    // Idempotent: a second event does not re-invite the author.
    await convergePullRequest(deps(), pullRequestEvent(payload("synchronize")));
    expect(slack.invites).toHaveLength(1);
  });

  it("shows the PR author's plain name in 'Opened by', never a ping", async () => {
    await upsertIdentity(db, {
      githubUserId: 100,
      githubLogin: "oz",
      slackUserId: "U100",
      source: "self-link",
    });
    slack.profiles.set("U100", { name: "Oz Perkins" });
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    const blocks = JSON.stringify(slack.messages);
    expect(blocks).toContain("👤 Opened by Oz Perkins");
    expect(blocks).not.toContain("<@U100>"); // never tag the author
  });

  it("archives a merged PR and warns when Slack refuses to invite its author", async () => {
    await upsertIdentity(db, {
      githubUserId: 100,
      githubLogin: "oz",
      slackUserId: "U100",
      source: "self-link",
    });
    slack.uninvitableUsers.set("U100", "user_is_restricted");
    const warn = vi.fn();
    const d = { ...deps(), logger: { ...createLogger("error"), warn } };

    await convergePullRequest(d, pullRequestEvent(payload("opened")));
    await convergePullRequest(d, pullRequestEvent(payload("closed", { merged: true })));

    expect(slack.invites).toHaveLength(0);
    expect(JSON.stringify(slack.messages)).toContain("Opened by");
    expect(slack.channels).toEqual([
      expect.objectContaining({ name: expect.stringMatching(/^merged-/), archived: true }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      "Slack refused to invite user into channel",
      expect.objectContaining({ userId: "U100", slackError: "user_is_restricted", role: "author" }),
    );
  });

  it("does not invite an unlinked author (degrades quietly)", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    expect(slack.invites).toHaveLength(0);
  });

  it("announces a merge in the shipped channel (merged only)", async () => {
    const d = { ...deps(), shippedChannel: "C0SHIPPED" };
    await convergePullRequest(d, pullRequestEvent(payload("opened")));
    await convergePullRequest(d, pullRequestEvent(payload("closed", { merged: true })));
    const shipped = slack.messages.find((m) => m.channel === "C0SHIPPED");
    expect(JSON.stringify(shipped?.blocks)).toContain("has shipped");
  });

  it("shows the shipped author's plain Slack name, never an @-ping", async () => {
    await upsertIdentity(db, {
      githubUserId: 100,
      githubLogin: "oz",
      slackUserId: "U100",
      source: "self-link",
    });
    slack.profiles.set("U100", { name: "Oz Perkins" });
    const d = { ...deps(), shippedChannel: "C0SHIPPED" };
    await convergePullRequest(d, pullRequestEvent(payload("opened")));
    await convergePullRequest(d, pullRequestEvent(payload("closed", { merged: true })));
    const shipped = slack.messages.find((m) => m.channel === "C0SHIPPED");
    const blocks = JSON.stringify(shipped?.blocks);
    expect(blocks).toContain("Oz Perkins");
    expect(blocks).not.toContain("<@U100>"); // broadcast channel: no ping
  });

  it("archives and cancels reminders on merge even if the #shipped post fails", async () => {
    const d = { ...deps(), shippedChannel: "C0SHIPPED" };
    await convergePullRequest(d, pullRequestEvent(payload("opened"))); // creates the PR row + channel C1
    await scheduleReminder(db, {
      prId: prId("unkey/api", 1423),
      reviewerGithubId: 7,
      dueAt: new Date("2026-08-13T00:00:00Z"),
      stamp: { updatedAt: new Date(0), version: "" },
    });
    const realPost = slack.post.bind(slack);
    slack.post = async (channel, m, opts) => {
      if (channel === "C0SHIPPED") throw new Error("shipped channel unreachable");
      return realPost(channel, m, opts);
    };

    await convergePullRequest(d, pullRequestEvent(payload("closed", { merged: true })));

    expect(slack.channel("C1")?.archived).toBe(true); // archived despite shipped failure
    const [rem] = await db
      .select()
      .from(reminders)
      .where(eq(reminders.id, `${prId("unkey/api", 1423)}::7`));
    expect(rem?.status).toBe("cancelled"); // reminder cancelled despite shipped failure
  });

  it("does not announce a plain close (not merged)", async () => {
    const d = { ...deps(), shippedChannel: "C0SHIPPED" };
    await convergePullRequest(d, pullRequestEvent(payload("opened")));
    await convergePullRequest(d, pullRequestEvent(payload("closed", { merged: false })));
    expect(slack.messages.some((m) => m.channel === "C0SHIPPED")).toBe(false);
  });

  it("comments the Slack channel URL on the PR when merged (opt-in), once", async () => {
    const postPrComment = vi.fn((_repo: string, _number: number, _body: string) =>
      Promise.resolve(),
    );
    const d = {
      ...deps(),
      commentOnMerge: true,
      postPrComment,
      slackTeamId: "T1",
    };
    await convergePullRequest(d, pullRequestEvent(payload("opened")));
    await convergePullRequest(d, pullRequestEvent(payload("closed", { merged: true })));
    expect(postPrComment).toHaveBeenCalledTimes(1);
    const call = postPrComment.mock.calls[0];
    expect(call?.[0]).toBe("unkey/api");
    expect(call?.[1]).toBe(1423);
    expect(call?.[2]).toContain("slack.com/app_redirect?channel=C1&team=T1");
  });

  it("posts both the #shipped note and the merge comment on the webhook close path", async () => {
    const postPrComment = vi.fn(async () => {});
    const d = {
      ...deps(),
      shippedChannel: "C0SHIPPED",
      commentOnMerge: true,
      postPrComment,
      slackTeamId: "T1",
    };
    await convergePullRequest(d, pullRequestEvent(payload("opened")));
    await convergePullRequest(d, pullRequestEvent(payload("closed", { merged: true })));

    expect(slack.messages.some((message) => message.channel === "C0SHIPPED")).toBe(true);
    expect(postPrComment).toHaveBeenCalledTimes(1);
    expect(slack.channel("C1")?.archived).toBe(true);
  });

  it("skips the #shipped note and the merge comment on a reconcile catch-up", async () => {
    const postPrComment = vi.fn(async () => {});
    const d = {
      ...deps(),
      shippedChannel: "C0SHIPPED",
      commentOnMerge: true,
      postPrComment,
      slackTeamId: "T1",
    };
    await convergePullRequest(d, pullRequestEvent(payload("opened")));
    await scheduleReminder(db, {
      prId: prId("unkey/api", 1423),
      reviewerGithubId: 7,
      dueAt: new Date("2026-08-13T00:00:00Z"),
      stamp: { updatedAt: new Date(0), version: "" },
    });

    const merged = pullRequestEvent(payload("closed", { merged: true }));
    const cause = {
      kind: "reconcile",
      merged: true,
      arrivalKey: reconcileArrivalKey(new Date()),
    } as const;
    await expect(
      session(d, { kind: "snapshot", snapshot: merged.pr, cause }, async (s) => s.converged),
    ).resolves.toMatchObject({
      accepted: true,
      skippedShipped: true,
      skippedMergeComment: true,
    });

    expect(slack.messages.some((message) => message.channel === "C0SHIPPED")).toBe(false);
    expect(postPrComment).not.toHaveBeenCalled();
    expect(slack.channel("C1")?.name).toBe("merged-oz-unkey-api-1423-add-auth");
    expect(slack.channel("C1")?.archived).toBe(true);
    const row = await findByRepoNumber(db, "unkey/api", 1423);
    expect(row?.currentState).toBe("merged");
    expect(row?.appliedState).toBe("merged");
    expect(row?.mergeCommentPostedAt).toBeNull();
    const [reminder] = await db
      .select()
      .from(reminders)
      .where(eq(reminders.id, `${prId("unkey/api", 1423)}::7`));
    expect(reminder?.status).toBe("cancelled");
  });

  it("does not comment on the PR when the opt-in is off", async () => {
    const postPrComment = vi.fn(async () => {});
    const d = { ...deps(), commentOnMerge: false, postPrComment, slackTeamId: "T1" };
    await convergePullRequest(d, pullRequestEvent(payload("opened")));
    await convergePullRequest(d, pullRequestEvent(payload("closed", { merged: true })));
    expect(postPrComment).not.toHaveBeenCalled();
  });

  it("opens with a description: linked PR number and the branch flow", async () => {
    await convergePullRequest(
      deps(),
      pullRequestEvent(
        payload("opened", { base: { ref: "main" }, head: { sha: "sha1", ref: "feat/auth" } }),
      ),
    );
    const root = JSON.stringify(slack.messages[0]?.blocks);
    expect(root).toContain("https://github.com/unkey/api/pull/1423|PR #1423");
    expect(root).toContain("wants to merge into `main` from `feat/auth`");
  });

  it("sets the channel topic to a linked PR description", async () => {
    await convergePullRequest(
      deps(),
      pullRequestEvent(
        payload("opened", { base: { ref: "main" }, head: { sha: "sha1", ref: "fix/gates" } }),
      ),
    );
    expect(slack.channel("C1")?.topic).toBe(
      "<https://github.com/unkey/api/pull/1423|PR 1423>: oz wants to merge into main from fix/gates",
    );
  });

  it("opened draft creates a draft-* channel, stores mapping + root ts", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened", { draft: true })));
    expect(slack.channels).toHaveLength(1);
    expect(slack.channels[0]?.name).toBe("draft-oz-unkey-api-1423-add-auth");
    const row = await findByRepoNumber(db, "unkey/api", 1423);
    expect(row?.channelId).toBe("C1");
    expect(row?.rootMessageTs).toBe("ts-1");
    expect(row?.currentState).toBe("draft");
  });

  it("heals a stuck draft channel when ready_for_review was missed (state follows facts)", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened", { draft: true })));
    expect(slack.channel("C1")?.name).toBe("draft-oz-unkey-api-1423-add-auth");
    // ready_for_review never applied; a later synchronize carries draft: false.
    await convergePullRequest(
      deps(),
      pullRequestEvent(
        payload("synchronize", { draft: false, updated_at: "2026-08-11T12:01:00Z" }),
      ),
    );
    expect(slack.channel("C1")?.name).toBe("pr-oz-unkey-api-1423-add-auth");
  });

  it("keeps a draft channel draft on a synchronize that is still a draft", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened", { draft: true })));
    await convergePullRequest(
      deps(),
      pullRequestEvent(payload("synchronize", { draft: true, updated_at: "2026-08-11T12:01:00Z" })),
    );
    expect(slack.channel("C1")?.name).toBe("draft-oz-unkey-api-1423-add-auth");
  });

  it("does not revive a merged PR from a stray synchronize", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    await convergePullRequest(deps(), pullRequestEvent(payload("closed", { merged: true })));
    expect(slack.channel("C1")?.name).toBe("merged-oz-unkey-api-1423-add-auth");
    // A late, non-lifecycle event must not flip it back to an open state.
    await convergePullRequest(
      deps(),
      pullRequestEvent(
        payload("synchronize", { draft: false, updated_at: "2026-08-11T13:00:00Z" }),
      ),
    );
    expect(slack.channel("C1")?.name).toBe("merged-oz-unkey-api-1423-add-auth");
    expect(slack.channel("C1")?.archived).toBe(true);
  });

  it("ready_for_review renames draft -> pr; converted_to_draft renames back", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened", { draft: true })));
    await convergePullRequest(
      deps(),
      pullRequestEvent(payload("ready_for_review", { draft: false })),
    );
    expect(slack.channel("C1")?.name).toBe("pr-oz-unkey-api-1423-add-auth");
    await convergePullRequest(
      deps(),
      pullRequestEvent(payload("converted_to_draft", { draft: true })),
    );
    expect(slack.channel("C1")?.name).toBe("draft-oz-unkey-api-1423-add-auth");
  });

  it("closed+merged renames to merged then archives (rename precedes archive)", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    await convergePullRequest(deps(), pullRequestEvent(payload("closed", { merged: true })));
    const ch = slack.channel("C1");
    expect(ch?.name).toBe("merged-oz-unkey-api-1423-add-auth");
    expect(ch?.archived).toBe(true);
  });

  it("closed without merge renames to closed then archives", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    await convergePullRequest(deps(), pullRequestEvent(payload("closed", { merged: false })));
    expect(slack.channel("C1")?.name).toBe("closed-oz-unkey-api-1423-add-auth");
    expect(slack.channel("C1")?.archived).toBe(true);
  });

  it("reopened unarchives and renames to pr", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    await convergePullRequest(deps(), pullRequestEvent(payload("closed", { merged: false })));
    await convergePullRequest(deps(), pullRequestEvent(payload("reopened")));
    expect(slack.channel("C1")?.archived).toBe(false);
    expect(slack.channel("C1")?.name).toBe("pr-oz-unkey-api-1423-add-auth");
  });

  it("does not write to an archived channel on a later event for a merged PR (no is_archived)", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    await convergePullRequest(deps(), pullRequestEvent(payload("closed", { merged: true })));
    expect(slack.channel("C1")?.archived).toBe(true);

    // The author links their Slack account only AFTER the merge. A subsequent
    // pull_request event must NOT try to post the author-invite into the now
    // archived channel (that would throw is_archived and poison the job).
    await upsertIdentity(db, {
      githubUserId: 100,
      githubLogin: "oz",
      slackUserId: "U100",
      source: "self-link",
    });
    const before = slack.messages.length;

    await expect(
      convergePullRequest(
        deps(),
        pullRequestEvent(payload("edited", { updated_at: "2026-08-11T13:00:00Z" })),
      ),
    ).resolves.toMatchObject({
      accepted: true,
      skippedShipped: false,
      skippedMergeComment: false,
    });
    expect(slack.channel("C1")?.archived).toBe(true); // stays archived
    expect(slack.messages.length).toBe(before); // nothing posted to the archived channel
  });

  it("unarchives before writing when a merged PR is reopened after the author links late", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    await convergePullRequest(deps(), pullRequestEvent(payload("closed", { merged: true })));
    // Author links after the archive; reopen must unarchive before the invite.
    await upsertIdentity(db, {
      githubUserId: 100,
      githubLogin: "oz",
      slackUserId: "U100",
      source: "self-link",
    });

    await expect(
      convergePullRequest(
        deps(),
        pullRequestEvent(payload("reopened", { updated_at: "2026-08-11T13:00:00Z" })),
      ),
    ).resolves.toMatchObject({
      accepted: true,
      skippedShipped: false,
      skippedMergeComment: false,
    });
    expect(slack.channel("C1")?.archived).toBe(false);
    const blocks = JSON.stringify(slack.messages);
    expect(blocks).toContain("👤 Opened by"); // author-invite note posted to the live channel
    expect(blocks).not.toContain("<@U100>"); // plain name, never a ping
    expect(slack.invites).toContainEqual({ channelId: "C1", userIds: ["U100"] });
  });

  it("re-delivered opened event does not create a second channel", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    expect(slack.channels).toHaveLength(1);
    expect(await findByRepoNumber(db, "unkey/api", 1423).then((r) => r?.id)).toBe(
      prId("unkey/api", 1423),
    );
  });

  it("recovers an ambiguous create that succeeded in Slack before the response was lost", async () => {
    const create = slack.createChannel.bind(slack);
    slack.createChannel = async (name) => {
      await create(name);
      throw new SlackApiError("conversations.create", "no_response");
    };

    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));

    expect(slack.channels).toHaveLength(1);
    expect((await findByRepoNumber(db, "unkey/api", 1423))?.channelId).toBe("C1");
  });

  it("recovers name_taken by looking up only the exact deterministic channel name", async () => {
    await slack.createChannel("pr-oz-unkey-api-1423-add-auth");

    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));

    expect(slack.channels).toHaveLength(1);
    expect((await findByRepoNumber(db, "unkey/api", 1423))?.channelId).toBe("C1");
  });

  it.each([
    ["a rate limit", new Retry("Slack rate limited; retry after 30s", undefined, 30_000)],
    ["invalid_name", new SlackApiError("conversations.create", "invalid_name")],
    ["missing_scope", new SlackApiError("conversations.create", "missing_scope")],
  ])("fails a create rejected with %s without scanning channels", async (_, failure) => {
    slack.createChannel = async () => {
      throw failure;
    };
    const findChannelByName = vi.spyOn(slack, "findChannelByName");

    await expect(convergePullRequest(deps(), pullRequestEvent(payload("opened")))).rejects.toBe(
      failure,
    );

    expect(findChannelByName).not.toHaveBeenCalled();
    expect(slack.channels).toHaveLength(0);
    expect((await findByRepoNumber(db, "unkey/api", 1423))?.channelId).toBeNull();
  });

  it("sanitizes untrusted PR titles and logins in blocks and fallback text", async () => {
    const event = payload("opened", {
      title: "ship <!channel>",
      user: { login: "<!everyone>", id: 101 },
    });
    await convergePullRequest(deps(), pullRequestEvent(event));
    expect(JSON.stringify(slack.messages.at(-1))).not.toContain("<!channel>");
    expect(JSON.stringify(slack.messages.at(-1))).not.toContain("<!everyone>");
  });

  it("reuses a persisted channel and effect key after a root-post failure", async () => {
    const post = slack.post.bind(slack);
    let fail = true;
    slack.post = async (channel, message, opts) => {
      if (fail) {
        fail = false;
        throw new Error("transient Slack failure");
      }
      return post(channel, message, opts);
    };

    await expect(convergePullRequest(deps(), pullRequestEvent(payload("opened")))).rejects.toThrow(
      "transient Slack failure",
    );
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));

    expect(slack.channels).toHaveLength(1);
    expect(slack.messages).toHaveLength(1);
    expect(slack.messages[0]?.clientMsgId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("retries Slack reconciliation after a rename failure without regressing source state", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened", { draft: true })));
    const rename = slack.rename.bind(slack);
    let fail = true;
    slack.rename = async (channelId, name) => {
      if (fail) {
        fail = false;
        throw new Error("rename failed");
      }
      return rename(channelId, name);
    };

    const ready = payload("ready_for_review", {
      draft: false,
      updated_at: "2026-08-11T12:01:00Z",
    });
    await expect(convergePullRequest(deps(), pullRequestEvent(ready))).rejects.toThrow(
      "rename failed",
    );
    const pending = await findByRepoNumber(db, "unkey/api", 1423);
    expect(pending?.currentState).toBe("pr");
    expect(pending?.appliedState).toBe("draft");
    await convergePullRequest(deps(), pullRequestEvent(ready));

    expect(slack.channel("C1")?.name).toBe("pr-oz-unkey-api-1423-add-auth");
  });

  it("retries archive after rename succeeded but archive failed", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    const archive = slack.archive.bind(slack);
    let fail = true;
    slack.archive = async (channelId) => {
      if (fail) {
        fail = false;
        throw new Error("archive failed");
      }
      return archive(channelId);
    };

    const closed = payload("closed", {
      updated_at: "2026-08-11T12:01:00Z",
    });
    await expect(convergePullRequest(deps(), pullRequestEvent(closed))).rejects.toThrow(
      "archive failed",
    );
    const pending = await findByRepoNumber(db, "unkey/api", 1423);
    expect(pending?.currentState).toBe("closed");
    expect(pending?.appliedState).toBe("pr");
    await convergePullRequest(deps(), pullRequestEvent(closed));

    expect(slack.channel("C1")?.name).toBe("closed-oz-unkey-api-1423-add-auth");
    expect(slack.channel("C1")?.archived).toBe(true);
  });

  it("posts a terminal lifecycle note after rename and before archive", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    const operations: string[] = [];
    const rename = slack.rename.bind(slack);
    const post = slack.post.bind(slack);
    const archive = slack.archive.bind(slack);
    slack.rename = async (channelId, name) => {
      operations.push("rename");
      await rename(channelId, name);
    };
    slack.post = async (channel, message, opts) => {
      operations.push("post");
      return post(channel, message, opts);
    };
    slack.archive = async (channelId) => {
      operations.push("archive");
      await archive(channelId);
    };

    await convergePullRequest(
      deps(),
      pullRequestEvent(payload("closed", { updated_at: "2026-08-11T12:01:00Z" })),
    );

    expect(operations).toEqual(["rename", "post", "archive"]);
    expect(slack.channel("C1")?.archived).toBe(true);
  });

  it("runs the quiet-archive member cleanup immediately before archiving", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    const operations: string[] = [];
    const archive = slack.archive.bind(slack);
    slack.archive = async (channelId) => {
      operations.push("archive");
      await archive(channelId);
    };
    const quietArchive = async (channelId: string) => {
      operations.push(`quiet:${channelId}`);
    };

    await convergePullRequest(
      { ...deps(), quietArchive },
      pullRequestEvent(payload("closed", { merged: true, updated_at: "2026-08-11T12:01:00Z" })),
    );

    expect(operations).toEqual(["quiet:C1", "archive"]);
    expect(slack.channel("C1")?.archived).toBe(true);
  });

  it("retries a terminal lifecycle note before archiving the channel", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    const post = slack.post.bind(slack);
    let fail = true;
    slack.post = async (channel, message, opts) => {
      if (fail) {
        fail = false;
        throw new Error("note failed");
      }
      return post(channel, message, opts);
    };
    const closed = payload("closed", { updated_at: "2026-08-11T12:01:00Z" });

    await expect(convergePullRequest(deps(), pullRequestEvent(closed))).rejects.toThrow(
      "note failed",
    );
    expect(slack.channel("C1")?.archived).toBe(false);
    await convergePullRequest(deps(), pullRequestEvent(closed));

    expect(slack.channel("C1")?.archived).toBe(true);
    expect(slack.messages.filter((message) => message.text.includes("closed"))).toHaveLength(1);
  });

  it("archives a terminal-first event after a root-post failure and retry", async () => {
    const operations: string[] = [];
    const post = slack.post.bind(slack);
    const rename = slack.rename.bind(slack);
    const archive = slack.archive.bind(slack);
    let fail = true;
    slack.post = async (channel, message, opts) => {
      if (fail) {
        fail = false;
        throw new Error("root failed");
      }
      return post(channel, message, opts);
    };
    slack.rename = async (channelId, name) => {
      operations.push("rename");
      return rename(channelId, name);
    };
    slack.archive = async (channelId) => {
      operations.push("archive");
      return archive(channelId);
    };

    const closed = payload("closed", {
      merged: true,
      updated_at: "2026-08-11T12:01:00Z",
    });
    await expect(convergePullRequest(deps(), pullRequestEvent(closed))).rejects.toThrow(
      "root failed",
    );
    expect((await findByRepoNumber(db, "unkey/api", 1423))?.appliedState).toBeNull();
    await convergePullRequest(deps(), pullRequestEvent(closed));

    expect(slack.channels).toHaveLength(1);
    expect(slack.channel("C1")?.name).toBe("merged-oz-unkey-api-1423-add-auth");
    expect(slack.channel("C1")?.archived).toBe(true);
    expect(operations).toEqual(["rename", "archive"]);
  });

  it("ignores an older lifecycle event after a newer terminal state", async () => {
    await convergePullRequest(
      deps(),
      pullRequestEvent(
        payload("closed", {
          merged: true,
          updated_at: "2026-08-11T12:02:00Z",
        }),
      ),
    );
    await convergePullRequest(
      deps(),
      pullRequestEvent(
        payload("opened", {
          merged: false,
          updated_at: "2026-08-11T12:01:00Z",
        }),
      ),
    );

    const row = await findByRepoNumber(db, "unkey/api", 1423);
    expect(row?.currentState).toBe("merged");
    expect(row?.sourceUpdatedAt?.toISOString()).toBe("2026-08-11T12:02:00.000Z");
    expect(slack.channel("C1")?.name).toBe("merged-oz-unkey-api-1423-add-auth");
    expect(slack.channel("C1")?.archived).toBe(true);
  });

  it("uses the durable job arrival key to order equal GitHub updated_at snapshots", async () => {
    const opened = payload("opened", { draft: true });
    const ready = payload("ready_for_review", { draft: false });
    await convergePullRequest(deps(), pullRequestEvent(opened), arrival("2026-08-11T12:00:01Z:a"));
    await convergePullRequest(deps(), pullRequestEvent(ready), arrival("2026-08-11T12:00:02Z:b"));
    await convergePullRequest(deps(), pullRequestEvent(opened), arrival("2026-08-11T12:00:01Z:a"));

    const row = await findByRepoNumber(db, "unkey/api", 1423);
    expect(row?.currentState).toBe("pr");
    expect(row?.sourceArrivalKey).toBe("2026-08-11T12:00:02Z:b");
  });

  it("queues a second worker on the same PR in this process behind the first", async () => {
    const create = slack.createChannel.bind(slack);
    let releaseCreate: (() => void) | undefined;
    let signalCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    slack.createChannel = async (name) => {
      signalCreateStarted?.();
      await createGate;
      return create(name);
    };

    const older = convergePullRequest(
      deps(),
      pullRequestEvent(payload("opened", { draft: true })),
      arrival("2026-08-11T12:00:01Z:old"),
    );
    await createStarted;
    let newerSettled = false;
    const newer = convergePullRequest(
      deps(),
      pullRequestEvent(payload("ready_for_review", { updated_at: "2026-08-11T12:01:00Z" })),
      arrival("2026-08-11T12:01:01Z:new"),
    ).finally(() => {
      newerSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(newerSettled).toBe(false);
    releaseCreate?.();
    await older;
    await expect(newer).resolves.toMatchObject({ accepted: true });

    expect(slack.channels).toHaveLength(1);
    expect(slack.channel("C1")?.name).toBe("pr-oz-unkey-api-1423-add-auth");
    expect((await findByRepoNumber(db, "unkey/api", 1423))?.currentState).toBe("pr");
  });

  it("makes a worker retry while another replica holds the PR's database lease", async () => {
    await convergePullRequest(
      deps(),
      pullRequestEvent(payload("opened", { draft: true })),
      arrival("2026-08-11T12:00:01Z:old"),
    );
    const otherReplica = await claimPullRequestLifecycle(db, 999);
    if (!otherReplica) throw new Error("the lease should be free");
    const ready = pullRequestEvent(
      payload("ready_for_review", { updated_at: "2026-08-11T12:01:00Z" }),
    );

    await expect(
      convergePullRequest(deps(), ready, arrival("2026-08-11T12:01:01Z:new")),
    ).rejects.toBeInstanceOf(PullRequestLifecycleBusyError);
    expect((await findByRepoNumber(db, "unkey/api", 1423))?.currentState).toBe("draft");
    await releasePullRequestLifecycle(db, otherReplica);

    await convergePullRequest(deps(), ready, arrival("2026-08-11T12:01:01Z:new"));
    expect((await findByRepoNumber(db, "unkey/api", 1423))?.currentState).toBe("pr");
  });

  it("reuses the PR row and channel after a repository rename", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    const original = await findByRepoNumber(db, "unkey/api", 1423);

    await convergePullRequest(
      deps(),
      pullRequestEvent(payload("edited", { updated_at: "2026-08-11T12:01:00Z" }, "unkey/platform")),
    );

    const renamed = await findByRepoNumber(db, "unkey/platform", 1423);
    expect(renamed?.id).toBe(original?.id);
    expect(renamed?.channelId).toBe("C1");
    expect(renamed?.appliedChannelName).toBe("pr-oz-unkey-platform-1423-add-auth");
    expect(await findByRepoNumber(db, "unkey/api", 1423)).toBeUndefined();
    expect(slack.channels).toHaveLength(1);
    expect(slack.channel("C1")?.name).toBe("pr-oz-unkey-platform-1423-add-auth");
  });

  it("keeps a legacy (v1) channel on its author-less scheme across renames (backwards compat)", async () => {
    // A channel created before the v2 (author) scheme: stored with
    // channelNameVersion = 1 and a v1 applied name.
    slack.channels.push({ id: "C-LEGACY", name: "pr-unkey-api-1423-add-auth", archived: false });
    await db.insert(pullRequests).values({
      id: prId("unkey/api", 1423),
      repoFullName: "unkey/api",
      number: 1423,
      githubPrId: 999,
      channelId: "C-LEGACY",
      currentState: "pr",
      appliedState: "pr",
      appliedChannelName: "pr-unkey-api-1423-add-auth",
      channelNameVersion: 1,
      rootMessageTs: "ts-legacy",
      sourceUpdatedAt: new Date("2026-08-10T12:00:00Z"),
    });

    // A title edit forces a rename; a state change would too. Either way the new
    // name must stay in the v1 scheme — no author injected.
    await convergePullRequest(
      deps(),
      pullRequestEvent(
        payload("edited", { title: "Add better auth", updated_at: "2026-08-11T12:00:00Z" }),
      ),
    );
    expect(slack.channel("C-LEGACY")?.name).toBe("pr-unkey-api-1423-add-better-auth");
    expect(slack.channel("C-LEGACY")?.name).not.toContain("oz");

    await convergePullRequest(
      deps(),
      pullRequestEvent(
        payload("closed", { title: "Add better auth", updated_at: "2026-08-11T13:00:00Z" }),
      ),
    );
    expect(slack.channel("C-LEGACY")?.name).toBe("closed-unkey-api-1423-add-better-auth");
    expect((await findByRepoNumber(db, "unkey/api", 1423))?.channelNameVersion).toBe(1);
  });
});

describe("PR session", () => {
  const child = (over: Partial<PullRequestPayload["pull_request"]> = {}) =>
    ({
      kind: "snapshot",
      snapshot: pullRequestEvent(payload("synchronize", over)).pr,
      cause: { kind: "child" },
    }) as const;

  it("builds a missing channel and root when a child event asks for a ready PR", async () => {
    const ready = await session(deps(), child(), (s) => s.ready());

    expect(ready).toMatchObject({ channelId: "C1", rootMessageTs: "ts-1", currentState: "pr" });
    expect(ready.sourceArrivalKey).toBeNull();
    expect(slack.channel("C1")?.name).toBe("pr-oz-unkey-api-1423-add-auth");
  });

  it("leaves a ready PR's stored facts alone for a child event", async () => {
    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    const before = await findByRepoNumber(db, "unkey/api", 1423);

    const ready = await session(
      deps(),
      child({ draft: true, updated_at: "2026-08-11T13:00:00Z" }),
      async (s) => s.ready(),
    );

    expect(ready.currentState).toBe("pr");
    expect(ready.sourceUpdatedAt).toEqual(before?.sourceUpdatedAt);
    expect(slack.channel("C1")?.name).toBe("pr-oz-unkey-api-1423-add-auth");
  });

  it("retries a child event whose stale snapshot cannot build the missing channel", async () => {
    slack.createChannel = async () => {
      throw new SlackApiError("conversations.create", "invalid_name");
    };
    await expect(
      convergePullRequest(
        deps(),
        pullRequestEvent(payload("opened", { updated_at: "2026-08-11T12:05:00Z" })),
      ),
    ).rejects.toThrow(SlackApiError);
    const info = vi.fn();
    const d = { ...deps(), logger: { ...createLogger("error"), info } };

    await expect(session(d, child(), (s) => s.ready())).rejects.toThrow(
      new Retry("PR channel is not ready for unkey/api#1423"),
    );
    expect(info).toHaveBeenCalledWith(
      "stale PR lifecycle event ignored",
      expect.objectContaining({ githubPrId: 999, incomingUpdatedAt: "2026-08-11T12:00:00Z" }),
    );
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("locks an existing PR without converging it", async () => {
    const existing = { kind: "existing", githubPrId: 999 } as const;
    await expect(session(deps(), existing, (s) => s.ready())).rejects.toThrow(
      new Retry("PR channel is not ready for GitHub PR 999"),
    );
    expect(slack.channels).toHaveLength(0);

    await convergePullRequest(deps(), pullRequestEvent(payload("opened")));
    await expect(
      session(deps(), existing, async (s) => ({ converged: s.converged, ready: await s.ready() })),
    ).resolves.toMatchObject({ converged: undefined, ready: { channelId: "C1" } });
  });

  it("delivers a child event's message into the channel it builds, once per key", async () => {
    const key = keys.issueComment(prId("unkey/api", 1423), 1);
    const build = vi.fn(async () => ({ message: { kind: "reminder", hours: 12 } as const }));

    const first = await session(deps(), child(), (s) => s.deliver(key, build));
    const again = await session(deps(), child(), async (s) => ({
      delivered: await s.deliver(key, build),
      ts: await s.sentTs(key),
    }));

    expect(first).toEqual({ status: "posted", ts: "ts-2" });
    expect(again).toEqual({ delivered: { status: "already-sent", ts: "ts-2" }, ts: "ts-2" });
    expect(build).toHaveBeenCalledTimes(1);
    expect(slack.messages.map((m) => [m.channel, m.ts])).toEqual([
      ["C1", "ts-1"],
      ["C1", "ts-2"],
    ]);
  });

  it("writes into an existing PR's stored channel, which needs no root", async () => {
    const row = (
      await applyPullRequestSource(db, {
        repoFullName: "unkey/api",
        number: 1423,
        githubPrId: 999,
        currentState: "pr",
      })
    ).row;
    const existing = { kind: "existing", githubPrId: 999 } as const;
    const key = keys.issueComment(row.id, 1);
    const note = { message: { kind: "reminder", hours: 12 } as const };
    const post = () => session(deps(), existing, (s) => s.deliver(key, async () => note));

    await expect(post()).rejects.toThrow(new Retry("PR channel is not ready for GitHub PR 999"));
    await setChannel(db, row.id, "C9", null);
    await expect(post()).resolves.toEqual({ status: "posted", ts: "ts-1" });
    await session(deps(), existing, async (s) => {
      const channel = await s.channel();
      await channel.update("ts-1", { kind: "reminder", hours: 24 });
      await channel.invite(["U1"], { role: "mention" });
      await channel.remove("ts-1");
    });

    expect(slack.updates.map((u) => [u.channel, u.ts])).toEqual([["C9", "ts-1"]]);
    expect(slack.invites).toEqual([{ channelId: "C9", userIds: ["U1"] }]);
    expect(slack.deletes).toEqual([{ channel: "C9", ts: "ts-1", authorUserToken: undefined }]);
  });

  it("refuses a session opened inside another and releases the outer lease", async () => {
    await expect(
      session(deps(), child(), () => session(deps(), child(), async () => "nested")),
    ).rejects.toThrow("PR session for 999 cannot open another");

    await expect(session(deps(), child(), async () => "after")).resolves.toBe("after");
  });

  it("renews the lifecycle lease while the body runs", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const start = Date.now();
      const renewed = await session(deps(), child(), async () => {
        vi.advanceTimersByTime(100_000);
        for (let i = 0; i < 100; i++) {
          const claimedAt = await pullRequestLifecycleClaimedAt(db, 999);
          if (claimedAt && claimedAt.getTime() > start) return claimedAt.getTime();
          await new Promise((resolve) => setImmediate(resolve));
        }
        return start;
      });
      expect(renewed).toBe(start + 100_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a lease another replica took over before release", async () => {
    const error = vi.fn();
    const d = { ...deps(), logger: { ...createLogger("error"), error } };

    await session(d, child(), async () => {
      await claimPullRequestLifecycle(db, 999, { now: new Date(Date.now() + 10 * 60_000) });
    });

    expect(error).toHaveBeenCalledWith("PR lifecycle lease was lost before release", {
      githubPrId: 999,
    });
  });
});
