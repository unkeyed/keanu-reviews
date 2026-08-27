import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import { upsertIdentity } from "../db/repositories/identities.ts";
import { setChannel, upsertPullRequest } from "../db/repositories/pullRequests.ts";
import { createTestDb } from "../db/testDb.ts";
import { createLogger } from "../logger.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import { type ReviewCommentPayload, handleReviewComment } from "./reviewComment.ts";

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

const deps = () => ({ db, slack, logger: createLogger("error") });

const payload = (over: Partial<ReviewCommentPayload["comment"]> = {}): ReviewCommentPayload => ({
  action: "created",
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
  comment: {
    id: 55,
    commit_id: "abc123",
    path: "src/handlers/auth.ts",
    line: 42,
    body: "simplify this",
    html_url: "https://github.com/unkey/api/pull/1423#discussion_r55",
    user: { id: 7, login: "flo" },
    ...over,
  },
});

const seedChannel = async () => {
  const row = await upsertPullRequest(db, {
    repoFullName: "unkey/api",
    number: 1423,
    githubPrId: 999,
    currentState: "pr",
  });
  await setChannel(db, row.id, "C1", "ts-root");
};

describe("handleReviewComment (U6)", () => {
  it("links Open to the PR discussion, with file:line shown as text", async () => {
    await seedChannel();
    await handleReviewComment(deps(), payload());
    const msg = slack.messages.at(-1);
    const text = JSON.stringify(msg?.blocks);
    expect(text).toContain("https://github.com/unkey/api/pull/1423#discussion_r55|Open");
    expect(text).not.toContain("/blob/"); // not the file/line view
    expect(text).toContain("`src/handlers/auth.ts:42`");
  });

  it("authors the comment as the commenter's linked Slack user (name + avatar)", async () => {
    await seedChannel();
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    slack.userProfiles.set("U7", { name: "Flo Rider", iconUrl: "https://slack/avatar.png" });
    await handleReviewComment(deps(), payload());
    const msg = slack.messages.at(-1);
    expect(msg?.username).toBe("Flo Rider"); // posted AS the Slack user
    expect(msg?.iconUrl).toBe("https://slack/avatar.png");
    const blocks = JSON.stringify(msg?.blocks);
    expect(blocks).not.toContain("by flo"); // no redundant "· by …" label
    expect(blocks).not.toContain("<@"); // never a mention
  });

  it("posts the comment AS the linked user via their token, auto-inviting them", async () => {
    await seedChannel();
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    slack.userProfiles.set("U7", { name: "Flo Rider", iconUrl: "https://slack/avatar.png" });
    const authorPoster = {
      getUserToken: async (id: string) => (id === "U7" ? "xoxp-flo" : undefined),
      onInvalidToken: async () => {},
    };
    await handleReviewComment({ ...deps(), authorPoster }, payload());
    const msg = slack.messages.at(-1);
    expect(msg?.authorUserToken).toBe("xoxp-flo"); // authored with the user's own token
    expect(msg?.authorUserId).toBe("U7");
    expect(msg?.username).toBeUndefined(); // no bot name/avatar spoof
    const blocks = JSON.stringify(msg?.blocks);
    expect(blocks).not.toContain("by flo"); // no redundant label
    expect(blocks).not.toContain("<@"); // never a mention
    // A non-member commenter is invited so chat.postMessage as them can land.
    expect(slack.invites).toContainEqual({ channelId: "C1", userIds: ["U7"] });
  });

  it("drops a dead user token and falls back to bot impersonation (no double post)", async () => {
    await seedChannel();
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    slack.userProfiles.set("U7", { name: "Flo Rider", iconUrl: "https://slack/avatar.png" });
    slack.invalidTokens.add("xoxp-dead");
    const dropped: string[] = [];
    const authorPoster = {
      getUserToken: async () => "xoxp-dead",
      onInvalidToken: async (id: string) => {
        dropped.push(id);
      },
    };
    await handleReviewComment({ ...deps(), authorPoster }, payload());
    expect(dropped).toEqual(["U7"]); // revoked token dropped
    const msg = slack.messages.at(-1);
    expect(msg?.authorUserToken).toBeUndefined(); // fell back off the user token
    expect(msg?.username).toBe("Flo Rider"); // bot impersonation instead
    expect(slack.messages).toHaveLength(1); // exactly one post, not two
  });

  it("posts as the bot with a plain login label when the author is unlinked", async () => {
    await seedChannel();
    await handleReviewComment(deps(), payload({ user: { id: 100, login: "oz" } }));
    const msg = slack.messages.at(-1);
    expect(msg?.username).toBeUndefined(); // falls back to bot authorship
    expect(JSON.stringify(msg?.blocks)).toContain("by oz");
  });

  it("invites the Slack user linked to an @-mentioned GitHub login", async () => {
    await seedChannel();
    await upsertIdentity(db, {
      githubUserId: 42,
      githubLogin: "dave-hawkins",
      slackUserId: "Udave",
      source: "self-link",
    });
    await handleReviewComment(
      deps(),
      payload({ body: "Hey @dave-hawkins I need some guidance here" }),
    );
    expect(slack.invites).toContainEqual({ channelId: "C1", userIds: ["Udave"] });
  });

  it("does not re-invite the PR author when they are @-mentioned", async () => {
    await seedChannel();
    // The PR author (payload default) is `oz`, linked to a Slack user.
    await upsertIdentity(db, {
      githubUserId: 100,
      githubLogin: "oz",
      slackUserId: "Uoz",
      source: "self-link",
    });
    await handleReviewComment(deps(), payload({ body: "thanks @oz!" }));
    expect(slack.invites).toHaveLength(0); // author already a channel member
  });

  it("invites other mentioned users but skips the PR author", async () => {
    await seedChannel();
    await upsertIdentity(db, {
      githubUserId: 100,
      githubLogin: "oz",
      slackUserId: "Uoz",
      source: "self-link",
    });
    await upsertIdentity(db, {
      githubUserId: 42,
      githubLogin: "dave-hawkins",
      slackUserId: "Udave",
      source: "self-link",
    });
    await handleReviewComment(deps(), payload({ body: "@oz @dave-hawkins please look" }));
    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["Udave"] }]);
  });

  it("does not invite for an unlinked mention or a team mention", async () => {
    await seedChannel();
    await handleReviewComment(
      deps(),
      payload({ body: "cc @not-linked and @unkey/api for review" }),
    );
    expect(slack.invites).toHaveLength(0);
  });

  it("syncs a comment edit onto the existing Slack message (chat.update, no new post)", async () => {
    await seedChannel();
    await handleReviewComment(deps(), payload({ body: "original body" }));
    const original = slack.messages.at(-1);
    expect(JSON.stringify(original?.blocks)).toContain("original body");
    const count = slack.messages.length;

    await handleReviewComment(deps(), { ...payload({ body: "edited body" }), action: "edited" });

    expect(slack.messages).toHaveLength(count); // updated in place, not re-posted
    expect(slack.updates).toHaveLength(1);
    const updated = slack.messages.find((m) => m.ts === original?.ts);
    expect(JSON.stringify(updated?.blocks)).toContain("edited body");
    expect(JSON.stringify(updated?.blocks)).not.toContain("original body");
  });

  it("posts an edit as a new message when the comment was never mirrored", async () => {
    await seedChannel();
    await handleReviewComment(deps(), { ...payload({ body: "late body" }), action: "edited" });
    expect(slack.messages).toHaveLength(1);
    expect(slack.updates).toHaveLength(0);
    expect(JSON.stringify(slack.messages.at(-1)?.blocks)).toContain("late body");
  });

  it("edits a user-authored comment with that user's token", async () => {
    await seedChannel();
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    slack.userProfiles.set("U7", { name: "Flo Rider" });
    const authorPoster = {
      getUserToken: async () => "xoxp-flo",
      onInvalidToken: async () => {},
    };
    await handleReviewComment({ ...deps(), authorPoster }, payload({ body: "v1" }));
    await handleReviewComment(
      { ...deps(), authorPoster },
      { ...payload({ body: "v2" }), action: "edited" },
    );
    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]?.authorUserToken).toBe("xoxp-flo"); // edited as the user
  });

  it("removes the mirrored Slack message when the comment is deleted", async () => {
    await seedChannel();
    await handleReviewComment(deps(), payload());
    const original = slack.messages.at(-1);
    expect(original).toBeDefined();

    await handleReviewComment(deps(), { ...payload(), action: "deleted" });

    expect(slack.deletes).toEqual([
      { channel: "C1", ts: original?.ts, authorUserToken: undefined },
    ]);
    expect(slack.messages.find((m) => m.ts === original?.ts)).toBeUndefined(); // gone
  });

  it("does nothing when deleting a comment that was never mirrored", async () => {
    await seedChannel();
    await handleReviewComment(deps(), { ...payload(), action: "deleted" });
    expect(slack.deletes).toHaveLength(0);
    expect(slack.messages).toHaveLength(0);
  });

  it("does not create a channel when a comment is deleted for an untracked PR", async () => {
    // No seedChannel: the PR was never tracked.
    await handleReviewComment(deps(), { ...payload(), action: "deleted" });
    expect(slack.channels).toHaveLength(0);
    expect(slack.deletes).toHaveLength(0);
  });

  it("deletes a user-authored comment with that user's token", async () => {
    await seedChannel();
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    slack.userProfiles.set("U7", { name: "Flo Rider" });
    const authorPoster = { getUserToken: async () => "xoxp-flo", onInvalidToken: async () => {} };
    await handleReviewComment({ ...deps(), authorPoster }, payload());
    await handleReviewComment({ ...deps(), authorPoster }, { ...payload(), action: "deleted" });
    expect(slack.deletes).toHaveLength(1);
    expect(slack.deletes[0]?.authorUserToken).toBe("xoxp-flo");
  });

  it("embeds an image from a human comment as an image block", async () => {
    await seedChannel();
    await handleReviewComment(
      deps(),
      payload({ body: "here it is ![shot](https://img.example.com/x.png)" }),
    );
    const blocks = slack.messages.at(-1)?.blocks ?? [];
    expect(blocks).toContainEqual({
      type: "image",
      image_url: "https://img.example.com/x.png",
      alt_text: "shot",
    });
    // The raw markdown is not left in the quoted text.
    expect(JSON.stringify(blocks)).not.toContain("![shot]");
  });

  it("does not embed images from an allow-listed bot's comment", async () => {
    await seedChannel();
    const allowed = { ...deps(), allowedBots: new Set(["pullfrog"]) };
    await handleReviewComment(
      allowed,
      payload({
        id: 88,
        user: { id: 20, login: "pullfrog[bot]", type: "Bot" },
        body: "preview ![p](https://img.example.com/y.png)",
      }),
    );
    expect(slack.messages).toHaveLength(1); // mirrored (allow-listed)
    const blocks = slack.messages.at(-1)?.blocks ?? [];
    expect(blocks.some((b) => (b as { type?: string }).type === "image")).toBe(false);
  });

  it("mirrors an allow-listed bot's comment top-level but still skips other bots", async () => {
    await seedChannel();
    const allowed = { ...deps(), allowedBots: new Set(["pullfrog"]) };
    // Pullfrog is allow-listed (matches "pullfrog[bot]" after normalization).
    await handleReviewComment(
      allowed,
      payload({ id: 71, user: { id: 20, login: "pullfrog[bot]", type: "Bot" } }),
    );
    expect(slack.messages).toHaveLength(1);
    expect(slack.messages.at(-1)?.threadTs).toBeUndefined(); // top-level, not threaded
    // A different bot is still filtered even with an allowlist present.
    await handleReviewComment(
      allowed,
      payload({ id: 72, user: { id: 21, login: "vercel[bot]", type: "Bot" } }),
    );
    expect(slack.messages).toHaveLength(1);
  });

  it("posts a thread-starting review comment top-level (not under the PR root)", async () => {
    await seedChannel();
    await handleReviewComment(deps(), payload());
    expect(slack.messages.at(-1)?.threadTs).toBeUndefined();
  });

  it("threads a reply under the Slack message of the comment it replies to", async () => {
    await seedChannel();
    // The original comment (id 55) posts top-level and gets a Slack ts.
    await handleReviewComment(deps(), payload({ id: 55 }));
    const parentTs = slack.messages.at(-1)?.ts;
    expect(parentTs).toBeTruthy();
    // A reply to it (in_reply_to_id: 55) threads under that message.
    await handleReviewComment(deps(), payload({ id: 56, in_reply_to_id: 55, body: "agreed" }));
    expect(slack.messages.at(-1)?.threadTs).toBe(parentTs);
  });

  it("posts a reply top-level when THREAD_COMMENTS is disabled", async () => {
    await seedChannel();
    await handleReviewComment({ ...deps(), threadComments: false }, payload({ id: 55 }));
    await handleReviewComment(
      { ...deps(), threadComments: false },
      payload({ id: 56, in_reply_to_id: 55 }),
    );
    expect(slack.messages.at(-1)?.threadTs).toBeUndefined();
  });

  it("posts a reply top-level when its parent comment was never mirrored", async () => {
    await seedChannel();
    await handleReviewComment(deps(), payload({ id: 56, in_reply_to_id: 999 }));
    expect(slack.messages.at(-1)?.threadTs).toBeUndefined();
  });

  it("reconciles the channel from the payload when the comment arrives first (out-of-order)", async () => {
    // No channel seeded — the opened event hasn't been processed.
    await handleReviewComment(deps(), payload());
    expect(slack.channels).toHaveLength(1); // lazily created
    // The last message is the threaded comment, not a null-target post.
    expect(slack.messages.at(-1)?.channel).toBeDefined();
  });

  it("ignores an inline comment from a bot", async () => {
    await seedChannel();
    await handleReviewComment(
      deps(),
      payload({ user: { id: 9, login: "vercel[bot]", type: "Bot" } }),
    );
    expect(slack.messages).toHaveLength(0);
  });

  it("does not double-post a re-delivered comment", async () => {
    await seedChannel();
    await handleReviewComment(deps(), payload());
    const count = slack.messages.length;
    await handleReviewComment(deps(), payload());
    expect(slack.messages.length).toBe(count);
  });

  it("retries a failed Slack delivery without suppressing the comment", async () => {
    await seedChannel();
    const post = slack.postMessage.bind(slack);
    let fail = true;
    slack.postMessage = async (message) => {
      if (fail) {
        fail = false;
        throw new Error("transient Slack failure");
      }
      return post(message);
    };

    await expect(handleReviewComment(deps(), payload())).rejects.toThrow("transient Slack failure");
    await handleReviewComment(deps(), payload());

    expect(slack.messages).toHaveLength(1);
    expect(slack.messages[0]?.clientMsgId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("deduplicates an ambiguous retry after Slack accepted the first post", async () => {
    await seedChannel();
    const post = slack.postMessage.bind(slack);
    let loseResponse = true;
    slack.postMessage = async (message) => {
      const response = await post(message);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("connection closed after send");
      }
      return response;
    };

    await expect(handleReviewComment(deps(), payload())).rejects.toThrow(
      "connection closed after send",
    );
    await handleReviewComment(deps(), payload());
    expect(slack.messages).toHaveLength(1);
  });

  it("uses the canonical comment URL when GitHub supplies no current line", async () => {
    await seedChannel();
    await handleReviewComment(deps(), payload({ line: null, start_line: null }));
    const rendered = JSON.stringify(slack.messages.at(-1)?.blocks);
    expect(rendered).toContain("https://github.com/unkey/api/pull/1423#discussion_r55|Open");
    expect(rendered).not.toContain(":1`");
  });

  it("sanitizes untrusted paths and logins in blocks and fallback text", async () => {
    await seedChannel();
    await handleReviewComment(
      deps(),
      payload({ path: "src/` <!channel>.ts", user: { id: 8, login: "<!everyone>" } }),
    );
    const message = slack.messages.at(-1);
    expect(JSON.stringify(message)).not.toContain("<!channel>");
    expect(JSON.stringify(message)).not.toContain("<!everyone>");
  });

  it("sets a top-level text fallback on every message", async () => {
    await seedChannel();
    await handleReviewComment(deps(), payload());
    expect(slack.messages.at(-1)?.text).toBeTruthy();
  });
});
