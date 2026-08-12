import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { upsertIdentity } from "../db/repositories/identities.ts";
import { findByRepoNumber, prId } from "../db/repositories/pullRequests.ts";
import { createTestDb } from "../db/testDb.ts";
import { createLogger } from "../logger.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import {
  PullRequestLifecycleBusyError,
  type PullRequestPayload,
  handlePullRequest,
} from "./pullRequest.ts";

let db: Db;
let slack: FakeSlackClient;
let close: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackClient();
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

describe("handlePullRequest (U4 channel lifecycle)", () => {
  it("invites the linked PR author into the channel on open", async () => {
    await upsertIdentity(db, {
      githubUserId: 100,
      githubLogin: "oz",
      slackUserId: "U100",
      source: "self-link",
    });
    await handlePullRequest(deps(), payload("opened"));
    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["U100"] }]);
    // Idempotent: a second event does not re-invite the author.
    await handlePullRequest(deps(), payload("synchronize"));
    expect(slack.invites).toHaveLength(1);
  });

  it("does not invite an unlinked author (degrades quietly)", async () => {
    await handlePullRequest(deps(), payload("opened"));
    expect(slack.invites).toHaveLength(0);
  });

  it("announces a merge in the shipped channel (merged only)", async () => {
    const d = { ...deps(), shippedChannel: "C0SHIPPED" };
    await handlePullRequest(d, payload("opened"));
    await handlePullRequest(d, payload("closed", { merged: true }));
    const shipped = slack.messages.find((m) => m.channel === "C0SHIPPED");
    expect(JSON.stringify(shipped?.blocks)).toContain("has shipped");
  });

  it("does not announce a plain close (not merged)", async () => {
    const d = { ...deps(), shippedChannel: "C0SHIPPED" };
    await handlePullRequest(d, payload("opened"));
    await handlePullRequest(d, payload("closed", { merged: false }));
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
    await handlePullRequest(d, payload("opened"));
    await handlePullRequest(d, payload("closed", { merged: true }));
    expect(postPrComment).toHaveBeenCalledTimes(1);
    const call = postPrComment.mock.calls[0];
    expect(call?.[0]).toBe("unkey/api");
    expect(call?.[1]).toBe(1423);
    expect(call?.[2]).toContain("slack.com/app_redirect?channel=C1&team=T1");
  });

  it("does not comment on the PR when the opt-in is off", async () => {
    const postPrComment = vi.fn(async () => {});
    const d = { ...deps(), commentOnMerge: false, postPrComment, slackTeamId: "T1" };
    await handlePullRequest(d, payload("opened"));
    await handlePullRequest(d, payload("closed", { merged: true }));
    expect(postPrComment).not.toHaveBeenCalled();
  });

  it("opens with a description: linked PR number and the branch flow", async () => {
    await handlePullRequest(
      deps(),
      payload("opened", { base: { ref: "main" }, head: { sha: "sha1", ref: "feat/auth" } }),
    );
    const root = JSON.stringify(slack.messages[0]?.blocks);
    expect(root).toContain("https://github.com/unkey/api/pull/1423|PR #1423");
    expect(root).toContain("wants to merge into `main` from `feat/auth`");
  });

  it("opened draft creates a draft-* channel, stores mapping + root ts", async () => {
    await handlePullRequest(deps(), payload("opened", { draft: true }));
    expect(slack.channels).toHaveLength(1);
    expect(slack.channels[0]?.name).toBe("draft-unkey-api-1423-19ec85a8");
    const row = await findByRepoNumber(db, "unkey/api", 1423);
    expect(row?.channelId).toBe("C1");
    expect(row?.rootMessageTs).toBe("ts-1");
    expect(row?.currentState).toBe("draft");
  });

  it("ready_for_review renames draft -> pr; converted_to_draft renames back", async () => {
    await handlePullRequest(deps(), payload("opened", { draft: true }));
    await handlePullRequest(deps(), payload("ready_for_review", { draft: false }));
    expect(slack.channel("C1")?.name).toBe("pr-unkey-api-1423-19ec85a8");
    await handlePullRequest(deps(), payload("converted_to_draft", { draft: true }));
    expect(slack.channel("C1")?.name).toBe("draft-unkey-api-1423-19ec85a8");
  });

  it("closed+merged renames to merged then archives (rename precedes archive)", async () => {
    await handlePullRequest(deps(), payload("opened"));
    await handlePullRequest(deps(), payload("closed", { merged: true }));
    const ch = slack.channel("C1");
    expect(ch?.name).toBe("merged-unkey-api-1423-19ec85a8");
    expect(ch?.archived).toBe(true);
  });

  it("closed without merge renames to closed then archives", async () => {
    await handlePullRequest(deps(), payload("opened"));
    await handlePullRequest(deps(), payload("closed", { merged: false }));
    expect(slack.channel("C1")?.name).toBe("closed-unkey-api-1423-19ec85a8");
    expect(slack.channel("C1")?.archived).toBe(true);
  });

  it("reopened unarchives and renames to pr", async () => {
    await handlePullRequest(deps(), payload("opened"));
    await handlePullRequest(deps(), payload("closed", { merged: false }));
    await handlePullRequest(deps(), payload("reopened"));
    expect(slack.channel("C1")?.archived).toBe(false);
    expect(slack.channel("C1")?.name).toBe("pr-unkey-api-1423-19ec85a8");
  });

  it("re-delivered opened event does not create a second channel", async () => {
    await handlePullRequest(deps(), payload("opened"));
    await handlePullRequest(deps(), payload("opened"));
    expect(slack.channels).toHaveLength(1);
    expect(await findByRepoNumber(db, "unkey/api", 1423).then((r) => r?.id)).toBe(
      prId("unkey/api", 1423),
    );
  });

  it("recovers an ambiguous create that succeeded in Slack before the response was lost", async () => {
    const create = slack.createChannel.bind(slack);
    slack.createChannel = async (name) => {
      await create(name);
      throw new Error("connection reset after accept");
    };

    await handlePullRequest(deps(), payload("opened"));

    expect(slack.channels).toHaveLength(1);
    expect((await findByRepoNumber(db, "unkey/api", 1423))?.channelId).toBe("C1");
  });

  it("recovers name_taken by looking up only the exact deterministic channel name", async () => {
    await slack.createChannel("pr-unkey-api-1423-19ec85a8");

    await handlePullRequest(deps(), payload("opened"));

    expect(slack.channels).toHaveLength(1);
    expect((await findByRepoNumber(db, "unkey/api", 1423))?.channelId).toBe("C1");
  });

  it("sanitizes untrusted PR titles and logins in blocks and fallback text", async () => {
    const event = payload("opened", {
      title: "ship <!channel>",
      user: { login: "<!everyone>", id: 101 },
    });
    await handlePullRequest(deps(), event);
    expect(JSON.stringify(slack.messages.at(-1))).not.toContain("<!channel>");
    expect(JSON.stringify(slack.messages.at(-1))).not.toContain("<!everyone>");
  });

  it("reuses a persisted channel and effect key after a root-post failure", async () => {
    const post = slack.postMessage.bind(slack);
    let fail = true;
    slack.postMessage = async (message) => {
      if (fail) {
        fail = false;
        throw new Error("transient Slack failure");
      }
      return post(message);
    };

    await expect(handlePullRequest(deps(), payload("opened"))).rejects.toThrow(
      "transient Slack failure",
    );
    await handlePullRequest(deps(), payload("opened"));

    expect(slack.channels).toHaveLength(1);
    expect(slack.messages).toHaveLength(1);
    expect(slack.messages[0]?.clientMsgId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("retries Slack reconciliation after a rename failure without regressing source state", async () => {
    await handlePullRequest(deps(), payload("opened", { draft: true }));
    const rename = slack.renameChannel.bind(slack);
    let fail = true;
    slack.renameChannel = async (channelId, name) => {
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
    await expect(handlePullRequest(deps(), ready)).rejects.toThrow("rename failed");
    const pending = await findByRepoNumber(db, "unkey/api", 1423);
    expect(pending?.currentState).toBe("pr");
    expect(pending?.appliedState).toBe("draft");
    await handlePullRequest(deps(), ready);

    expect(slack.channel("C1")?.name).toBe("pr-unkey-api-1423-19ec85a8");
  });

  it("retries archive after rename succeeded but archive failed", async () => {
    await handlePullRequest(deps(), payload("opened"));
    const archive = slack.archiveChannel.bind(slack);
    let fail = true;
    slack.archiveChannel = async (channelId) => {
      if (fail) {
        fail = false;
        throw new Error("archive failed");
      }
      return archive(channelId);
    };

    const closed = payload("closed", {
      updated_at: "2026-08-11T12:01:00Z",
    });
    await expect(handlePullRequest(deps(), closed)).rejects.toThrow("archive failed");
    const pending = await findByRepoNumber(db, "unkey/api", 1423);
    expect(pending?.currentState).toBe("closed");
    expect(pending?.appliedState).toBe("pr");
    await handlePullRequest(deps(), closed);

    expect(slack.channel("C1")?.name).toBe("closed-unkey-api-1423-19ec85a8");
    expect(slack.channel("C1")?.archived).toBe(true);
  });

  it("posts a terminal lifecycle note after rename and before archive", async () => {
    await handlePullRequest(deps(), payload("opened"));
    const operations: string[] = [];
    const rename = slack.renameChannel.bind(slack);
    const post = slack.postMessage.bind(slack);
    const archive = slack.archiveChannel.bind(slack);
    slack.renameChannel = async (channelId, name) => {
      operations.push("rename");
      await rename(channelId, name);
    };
    slack.postMessage = async (message) => {
      operations.push("post");
      return post(message);
    };
    slack.archiveChannel = async (channelId) => {
      operations.push("archive");
      await archive(channelId);
    };

    await handlePullRequest(deps(), payload("closed", { updated_at: "2026-08-11T12:01:00Z" }));

    expect(operations).toEqual(["rename", "post", "archive"]);
    expect(slack.channel("C1")?.archived).toBe(true);
  });

  it("retries a terminal lifecycle note before archiving the channel", async () => {
    await handlePullRequest(deps(), payload("opened"));
    const post = slack.postMessage.bind(slack);
    let fail = true;
    slack.postMessage = async (message) => {
      if (fail) {
        fail = false;
        throw new Error("note failed");
      }
      return post(message);
    };
    const closed = payload("closed", { updated_at: "2026-08-11T12:01:00Z" });

    await expect(handlePullRequest(deps(), closed)).rejects.toThrow("note failed");
    expect(slack.channel("C1")?.archived).toBe(false);
    await handlePullRequest(deps(), closed);

    expect(slack.channel("C1")?.archived).toBe(true);
    expect(slack.messages.filter((message) => message.text.includes("closed"))).toHaveLength(1);
  });

  it("archives a terminal-first event after a root-post failure and retry", async () => {
    const operations: string[] = [];
    const post = slack.postMessage.bind(slack);
    const rename = slack.renameChannel.bind(slack);
    const archive = slack.archiveChannel.bind(slack);
    let fail = true;
    slack.postMessage = async (message) => {
      if (fail) {
        fail = false;
        throw new Error("root failed");
      }
      return post(message);
    };
    slack.renameChannel = async (channelId, name) => {
      operations.push("rename");
      return rename(channelId, name);
    };
    slack.archiveChannel = async (channelId) => {
      operations.push("archive");
      return archive(channelId);
    };

    const closed = payload("closed", {
      merged: true,
      updated_at: "2026-08-11T12:01:00Z",
    });
    await expect(handlePullRequest(deps(), closed)).rejects.toThrow("root failed");
    expect((await findByRepoNumber(db, "unkey/api", 1423))?.appliedState).toBeNull();
    await handlePullRequest(deps(), closed);

    expect(slack.channels).toHaveLength(1);
    expect(slack.channel("C1")?.name).toBe("merged-unkey-api-1423-19ec85a8");
    expect(slack.channel("C1")?.archived).toBe(true);
    expect(operations).toEqual(["rename", "archive"]);
  });

  it("ignores an older lifecycle event after a newer terminal state", async () => {
    await handlePullRequest(
      deps(),
      payload("closed", {
        merged: true,
        updated_at: "2026-08-11T12:02:00Z",
      }),
    );
    await handlePullRequest(
      deps(),
      payload("opened", {
        merged: false,
        updated_at: "2026-08-11T12:01:00Z",
      }),
    );

    const row = await findByRepoNumber(db, "unkey/api", 1423);
    expect(row?.currentState).toBe("merged");
    expect(row?.sourceUpdatedAt?.toISOString()).toBe("2026-08-11T12:02:00.000Z");
    expect(slack.channel("C1")?.name).toBe("merged-unkey-api-1423-19ec85a8");
    expect(slack.channel("C1")?.archived).toBe(true);
  });

  it("uses the durable job arrival key to order equal GitHub updated_at snapshots", async () => {
    const opened = payload("opened", { draft: true });
    const ready = payload("ready_for_review", { draft: false });
    await handlePullRequest(deps(), opened, { sourceArrivalKey: "2026-08-11T12:00:01Z:a" });
    await handlePullRequest(deps(), ready, { sourceArrivalKey: "2026-08-11T12:00:02Z:b" });
    await handlePullRequest(deps(), opened, { sourceArrivalKey: "2026-08-11T12:00:01Z:a" });

    const row = await findByRepoNumber(db, "unkey/api", 1423);
    expect(row?.currentState).toBe("pr");
    expect(row?.sourceArrivalKey).toBe("2026-08-11T12:00:02Z:b");
  });

  it("serializes older and newer lifecycle workers through the database lease", async () => {
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

    const older = handlePullRequest(deps(), payload("opened", { draft: true }), {
      sourceArrivalKey: "2026-08-11T12:00:01Z:old",
    });
    await createStarted;
    await expect(
      handlePullRequest(
        deps(),
        payload("ready_for_review", {
          updated_at: "2026-08-11T12:01:00Z",
        }),
        { sourceArrivalKey: "2026-08-11T12:01:01Z:new" },
      ),
    ).rejects.toBeInstanceOf(PullRequestLifecycleBusyError);
    releaseCreate?.();
    await older;

    await handlePullRequest(
      deps(),
      payload("ready_for_review", { updated_at: "2026-08-11T12:01:00Z" }),
      { sourceArrivalKey: "2026-08-11T12:01:01Z:new" },
    );
    expect((await findByRepoNumber(db, "unkey/api", 1423))?.currentState).toBe("pr");
  });

  it("reuses the PR row and channel after a repository rename", async () => {
    await handlePullRequest(deps(), payload("opened"));
    const original = await findByRepoNumber(db, "unkey/api", 1423);

    await handlePullRequest(
      deps(),
      payload("edited", { updated_at: "2026-08-11T12:01:00Z" }, "unkey/platform"),
    );

    const renamed = await findByRepoNumber(db, "unkey/platform", 1423);
    expect(renamed?.id).toBe(original?.id);
    expect(renamed?.channelId).toBe("C1");
    expect(renamed?.appliedChannelName).toBe("pr-unkey-platform-1423-4a8dbb6a");
    expect(await findByRepoNumber(db, "unkey/api", 1423)).toBeUndefined();
    expect(slack.channels).toHaveLength(1);
    expect(slack.channel("C1")?.name).toBe("pr-unkey-platform-1423-4a8dbb6a");
  });
});
