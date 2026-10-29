import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";
import type { Db } from "../db/client.ts";
import { upsertIdentity } from "../db/repositories/identities.ts";
import { setChannel, upsertPullRequest } from "../db/repositories/pullRequests.ts";
import { getSlackUserTokenRow, upsertSlackUserToken } from "../db/repositories/slackUserTokens.ts";
import { createTestDb } from "../db/testDb.ts";
import { createLogger } from "../logger.ts";
import { SLACK_POST_USER_SCOPE } from "../slack/oauth.ts";
import { createTokenCipher } from "../slack/tokenCipher.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import { createServiceHandlers } from "./deps.ts";
import { handleReviewComment } from "./reviewComment.ts";

const ENC_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const ROTATED_KEY = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

const config = loadConfig({
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
  GITHUB_WEBHOOK_SECRET: "whsec_test_secret",
  GITHUB_INSTALLATION_ID: "42",
  GITHUB_OAUTH_CLIENT_ID: "Iv1.client-id",
  GITHUB_OAUTH_CLIENT_SECRET: "github_oauth_client_secret",
  OAUTH_STATE_SECRET: "oauth_state_secret_with_at_least_32_bytes",
  PUBLIC_URL: "https://bot.example.com/",
  SLACK_BOT_TOKEN: "xoxb-test-token",
  SLACK_SIGNING_SECRET: "slack_signing_secret",
  SLACK_TEAM_ID: "T123",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  SLACK_OAUTH_CLIENT_ID: "1234.5678",
  SLACK_OAUTH_CLIENT_SECRET: "slack-oauth-secret",
  SLACK_USER_TOKEN_ENC_KEY: ENC_KEY,
});

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

describe("createServiceHandlers post-as-user", () => {
  it("drops a token that no longer decrypts and posts the comment as the bot", async () => {
    const row = await upsertPullRequest(db, {
      repoFullName: "unkey/api",
      number: 1423,
      githubPrId: 999,
      currentState: "pr",
    });
    await setChannel(db, row.id, "C1", "ts-root");
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    slack.userProfiles.set("U7", { name: "Flo Rider" });
    await upsertSlackUserToken(db, {
      slackUserId: "U7",
      slackTeamId: "T123",
      encryptedToken: createTokenCipher(ROTATED_KEY).encrypt("xoxp-flo"),
      scopes: SLACK_POST_USER_SCOPE,
    });
    const warn = vi.fn();
    const { handler } = createServiceHandlers({
      config,
      db,
      slack,
      logger: { ...createLogger("error"), warn },
      auth: { getToken: async () => "ghs_unused", invalidate: () => {} },
    });

    await handleReviewComment(handler, {
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
    });

    expect(slack.messages).toHaveLength(1);
    expect(slack.messages[0]?.authorUserToken).toBeUndefined();
    expect(slack.messages[0]?.username).toBe("Flo Rider");
    expect(await getSlackUserTokenRow(db, "T123", "U7")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "dropping a Slack user token that cannot be decrypted",
      expect.objectContaining({ slackUserId: "U7" }),
    );
  });
});
