import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "#config";
import { getSlackUserTokenRow, upsertIdentity, upsertSlackUserToken } from "#identity";
import { createLogger } from "#lib";
import { onReviewComment } from "#mirror";
import type { Db } from "../db/client.ts";
import { createTestDb } from "../db/testDb.ts";
import { createTokenCipher } from "../lib/tokenCipher.ts";
import { applyPullRequestSource, setChannel } from "../pr/store.ts";
import { SLACK_POST_USER_SCOPE } from "../slack/oauth.ts";
import { TEST_ENV } from "../testing/context.ts";
import { handlerDeps } from "../testing/deps.ts";
import { reviewCommentEvent } from "../testing/events.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
import { createContext, userTokenAccess } from "./context.ts";

const ENC_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const ROTATED_KEY = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

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

describe("user token access", () => {
  it("posts as the bot when a stored token no longer decrypts, keeping the token", async () => {
    const row = (
      await applyPullRequestSource(db, {
        repoFullName: "unkey/api",
        number: 1423,
        githubPrId: 999,
        currentState: "pr",
      })
    ).row;
    await setChannel(db, row.id, "C1", "ts-root");
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    slack.profiles.set("U7", { name: "Flo Rider" });
    await upsertSlackUserToken(db, {
      slackUserId: "U7",
      slackTeamId: "T123",
      encryptedToken: createTokenCipher(ROTATED_KEY).encrypt("xoxp-flo"),
      scopes: SLACK_POST_USER_SCOPE,
    });
    const warn = vi.fn();
    const logger = { ...createLogger("error"), warn };
    const handler = handlerDeps(db, slack, {
      logger,
      ...userTokenAccess({ db, slack, logger, teamId: "T123", cipher: createTokenCipher(ENC_KEY) }),
    });

    await onReviewComment(
      handler,
      reviewCommentEvent({
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
        },
      }),
    );

    expect(slack.messages).toHaveLength(1);
    expect(slack.messages[0]?.authorUserToken).toBeUndefined();
    expect(slack.messages[0]?.username).toBe("Flo Rider");
    expect(await getSlackUserTokenRow(db, "T123", "U7")).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      "Slack user token cannot be decrypted; posting as the bot",
      expect.objectContaining({ slackUserId: "U7" }),
    );
  });
});

describe("createContext", () => {
  const routePaths = (ctx: ReturnType<typeof createContext>) =>
    ctx.routes.flatMap((route) => route.routes.map((r) => `${r.method} ${r.path}`));

  it("builds every dependency from config, with Slack user OAuth off", async () => {
    const ctx = createContext(loadConfig(TEST_ENV));
    try {
      expect(ctx.deps).toMatchObject({
        slackTeamId: "T123",
        shippedChannel: undefined,
        commentOnMerge: false,
        postPrComment: undefined,
        quietArchive: undefined,
        authorPoster: undefined,
        threadComments: true,
      });
      expect(routePaths(ctx)).not.toContain("GET /oauth/slack/callback");
      expect(routePaths(ctx)).toContain("GET /oauth/github/callback");
      expect(routePaths(ctx)).toContain("POST /slack/commands");
    } finally {
      await ctx.close();
    }
  });

  it("turns on post-as-user, quiet archive and the Slack OAuth route together", async () => {
    const ctx = createContext(
      loadConfig({
        ...TEST_ENV,
        SLACK_OAUTH_CLIENT_ID: "1234.5678",
        SLACK_OAUTH_CLIENT_SECRET: "slack-oauth-secret",
        SLACK_USER_TOKEN_ENC_KEY: ENC_KEY,
        GITHUB_COMMENT_ON_MERGE: "true",
      }),
    );
    try {
      expect(ctx.deps.authorPoster).toBeDefined();
      expect(ctx.deps.quietArchive).toBeDefined();
      expect(ctx.deps.postPrComment).toBeDefined();
      expect(routePaths(ctx)).toContain("GET /oauth/slack/callback");
    } finally {
      await ctx.close();
    }
  });
});
