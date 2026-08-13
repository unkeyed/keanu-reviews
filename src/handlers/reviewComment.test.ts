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
    expect(msg?.threadTs).toBeUndefined(); // direct channel post, not threaded
    const text = JSON.stringify(msg?.blocks);
    expect(text).toContain("https://github.com/unkey/api/pull/1423#discussion_r55|Open");
    expect(text).not.toContain("/blob/"); // not the file/line view
    expect(text).toContain("`src/handlers/auth.ts:42`");
  });

  it("mentions the committer (PR author), not the commenter who wrote it", async () => {
    await seedChannel();
    // PR author is oz/100; the comment is by flo/7. Both linked.
    await upsertIdentity(db, {
      githubUserId: 100,
      githubLogin: "oz",
      slackUserId: "U100",
      source: "self-link",
    });
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    await handleReviewComment(deps(), payload());
    const blocks = JSON.stringify(slack.messages.at(-1)?.blocks);
    expect(blocks).toContain("<@U100>"); // committer
    expect(blocks).not.toContain("<@U7>"); // not the commenter
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
