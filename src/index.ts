import { serve } from "@hono/node-server";
import { type Config, ConfigError, SECRET_KEYS, loadConfig } from "./config.ts";
import { createDb } from "./db/client.ts";
import { createDbReadyCheck } from "./db/readiness.ts";
import { deleteSlackUserToken, getSlackUserToken } from "./db/repositories/slackUserTokens.ts";
import { createInstallationAuth } from "./github/auth.ts";
import { createPrCommenter } from "./github/comments.ts";
import { createGithubOAuthClient } from "./github/oauth.ts";
import { octokitMintFn } from "./github/octokitAuth.ts";
import {
  createGithubEmailFetcher,
  createPrForShaFetcher,
  createPullRequestFetcher,
} from "./github/users.ts";
import { createLogger, registerSecretValues } from "./logger.ts";
import { createGithubOAuthRoute } from "./routes/githubOAuth.ts";
import { createGithubWebhookRoute } from "./routes/githubWebhook.ts";
import { createSlackCommandRoute } from "./routes/slackCommand.ts";
import { createSlackOAuthRoute } from "./routes/slackOAuth.ts";
import { startReminderLoop } from "./scheduler/loop.ts";
import { createReminderScheduler } from "./scheduler/reminders.ts";
import { createApp } from "./server.ts";
import { quietlyRemoveMembers } from "./slack/memberCleanup.ts";
import { createSlackOAuthClient } from "./slack/oauth.ts";
import { createTokenCipher } from "./slack/tokenCipher.ts";
import { createWebApiSlackClient } from "./slack/webApiClient.ts";
import { createWorker, startWorkerLoop } from "./worker/loop.ts";
import { createRouter } from "./worker/router.ts";

function boot(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  registerSecretValues(
    SECRET_KEYS.map((k) => config[k]).filter((v): v is string => typeof v === "string"),
  );
  const logger = createLogger(config.LOG_LEVEL, { service: "keanu-reviews" });

  // Infrastructure
  const { db } = createDb(config.DATABASE_URL);
  const slack = createWebApiSlackClient(config.SLACK_BOT_TOKEN);
  const auth = createInstallationAuth(
    octokitMintFn(config.GITHUB_APP_ID, config.GITHUB_APP_PRIVATE_KEY),
  );
  const installationId = config.GITHUB_INSTALLATION_ID;

  // Quiet archiving (opt-in): when Slack user-OAuth is configured, collect
  // per-user tokens so PR channels can be emptied of members before archive,
  // suppressing Slack's "archived the channel" notification. Config enforces
  // that the three settings are present together, so testing one is sufficient.
  const githubOauthCallbackUrl = `${config.PUBLIC_URL}/oauth/github/callback`;
  const slackOauthCallbackUrl = `${config.PUBLIC_URL}/oauth/slack/callback`;
  let quietArchive: ((channelId: string) => Promise<void>) | undefined;
  let slackOauthRoute: ReturnType<typeof createSlackOAuthRoute> | undefined;
  if (
    config.SLACK_OAUTH_CLIENT_ID &&
    config.SLACK_OAUTH_CLIENT_SECRET &&
    config.SLACK_USER_TOKEN_ENC_KEY
  ) {
    const cipher = createTokenCipher(config.SLACK_USER_TOKEN_ENC_KEY);
    slackOauthRoute = createSlackOAuthRoute({
      db,
      logger,
      oauthClient: createSlackOAuthClient({
        clientId: config.SLACK_OAUTH_CLIENT_ID,
        clientSecret: config.SLACK_OAUTH_CLIENT_SECRET,
      }),
      oauthStateSecret: config.OAUTH_STATE_SECRET,
      slackTeamId: config.SLACK_TEAM_ID,
      callbackUrl: slackOauthCallbackUrl,
      cipher,
    });
    quietArchive = async (channelId) => {
      await quietlyRemoveMembers(
        {
          slack,
          logger,
          getUserToken: async (slackUserId) => {
            const encrypted = await getSlackUserToken(db, config.SLACK_TEAM_ID, slackUserId);
            return encrypted ? cipher.decrypt(encrypted) : undefined;
          },
          onInvalidToken: (slackUserId) =>
            deleteSlackUserToken(db, config.SLACK_TEAM_ID, slackUserId),
        },
        channelId,
      );
    };
    logger.info("quiet archiving enabled (Slack user OAuth configured)");
  }

  // Scheduler + router + worker
  const scheduler = createReminderScheduler({
    db,
    slack,
    logger,
    reminderHours: config.REMINDER_HOURS,
    deliveryWindow: {
      startHour: config.REMINDER_WINDOW_START_HOUR,
      endHour: config.REMINDER_WINDOW_END_HOUR,
      timeZone: config.REMINDER_WINDOW_TZ,
    },
  });
  const router = createRouter({
    db,
    slack,
    logger,
    fetchGithubEmail: createGithubEmailFetcher(auth, installationId),
    fetchPrForSha: createPrForShaFetcher(auth, installationId),
    fetchPullRequest: createPullRequestFetcher(auth, installationId),
    shippedChannel: config.SLACK_SHIPPED_CHANNEL,
    // Opt-in GitHub write: post the Slack channel URL on merge. Off by default.
    commentOnMerge: config.GITHUB_COMMENT_ON_MERGE,
    postPrComment: config.GITHUB_COMMENT_ON_MERGE
      ? createPrCommenter(auth, installationId)
      : undefined,
    slackTeamId: config.SLACK_TEAM_ID,
    onReviewRequested: scheduler.onReviewRequested,
    onReviewSubmitted: scheduler.onReviewSubmitted,
    onReviewRequestRemoved: scheduler.onReviewRequestRemoved,
    quietArchive,
    allowedBots: config.ALLOWED_BOTS,
    threadComments: config.THREAD_COMMENTS,
  });
  const worker = createWorker({ db, logger, router });

  // Routes
  const githubWebhook = createGithubWebhookRoute({
    db,
    logger,
    webhookSecret: config.GITHUB_WEBHOOK_SECRET,
    allowedInstallationIds: [installationId],
  });
  const githubOauth = createGithubOAuthRoute({
    db,
    logger,
    oauthClient: createGithubOAuthClient({
      clientId: config.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: config.GITHUB_OAUTH_CLIENT_SECRET,
    }),
    oauthStateSecret: config.OAUTH_STATE_SECRET,
    slackTeamId: config.SLACK_TEAM_ID,
    callbackUrl: githubOauthCallbackUrl,
  });
  const slackCommand = createSlackCommandRoute({
    db,
    logger,
    signingSecret: config.SLACK_SIGNING_SECRET,
    slackTeamId: config.SLACK_TEAM_ID,
    oauthStateSecret: config.OAUTH_STATE_SECRET,
    githubOauthClientId: config.GITHUB_OAUTH_CLIENT_ID,
    githubOauthCallbackUrl,
    slackOauthClientId: config.SLACK_OAUTH_CLIENT_ID,
    slackOauthCallbackUrl: slackOauthRoute ? slackOauthCallbackUrl : undefined,
  });

  const app = createApp({
    logger,
    checkReady: createDbReadyCheck(db),
    mounts: [
      githubWebhook,
      githubOauth,
      slackCommand,
      ...(slackOauthRoute ? [slackOauthRoute] : []),
    ],
  });

  // Background loops (single active writer, KTD10)
  startWorkerLoop(worker, 1000, logger);
  startReminderLoop(scheduler.processDue, config.REMINDER_SCAN_INTERVAL_MS, logger);

  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    logger.info("service listening", { port: info.port, env: config.NODE_ENV });
  });
}

boot();
