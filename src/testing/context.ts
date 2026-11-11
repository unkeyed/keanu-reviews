import type { AppContext } from "#app";
import { loadConfig } from "#config";
import type { Db } from "#db";
import { createLogger } from "#lib";
import { handlerDeps } from "./deps.ts";
import type { FakeSlackGateway } from "./fakeSlack.ts";

export const TEST_ENV = {
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
};

export function testContext(
  db: Db,
  slack: FakeSlackGateway,
  over: Partial<AppContext> = {},
): AppContext & { closed: () => boolean } {
  let closed = false;
  const logger = createLogger("error");
  return {
    config: loadConfig(TEST_ENV),
    logger,
    db,
    deps: handlerDeps(db, slack, { logger }),
    fetchGithubUser: async () => undefined,
    routes: [],
    close: async () => {
      closed = true;
    },
    ...over,
    closed: () => closed,
  };
}
