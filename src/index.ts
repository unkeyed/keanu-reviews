import { serve } from "@hono/node-server";
import { type Config, ConfigError, SECRET_KEYS, loadConfig } from "./config.ts";
import { createDb } from "./db/client.ts";
import { createDbReadyCheck } from "./db/readiness.ts";
import { createInstallationAuth } from "./github/auth.ts";
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
import { startReminderLoop } from "./scheduler/loop.ts";
import { createReminderScheduler } from "./scheduler/reminders.ts";
import { createApp } from "./server.ts";
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
  const logger = createLogger(config.LOG_LEVEL, { service: "unkey-slack-pr-bot" });

  // Infrastructure
  const { db } = createDb(config.DATABASE_URL);
  const slack = createWebApiSlackClient(config.SLACK_BOT_TOKEN);
  const auth = createInstallationAuth(
    octokitMintFn(config.GITHUB_APP_ID, config.GITHUB_APP_PRIVATE_KEY),
  );
  const installationId = config.GITHUB_INSTALLATION_ID;

  // Scheduler + router + worker
  const scheduler = createReminderScheduler({
    db,
    slack,
    logger,
    reminderHours: config.REMINDER_HOURS,
  });
  const router = createRouter({
    db,
    slack,
    logger,
    fetchGithubEmail: createGithubEmailFetcher(auth, installationId),
    fetchPrForSha: createPrForShaFetcher(auth, installationId),
    fetchPullRequest: createPullRequestFetcher(auth, installationId),
    onReviewRequested: scheduler.onReviewRequested,
    onReviewSubmitted: scheduler.onReviewSubmitted,
    onReviewRequestRemoved: scheduler.onReviewRequestRemoved,
  });
  const worker = createWorker({ db, logger, router });

  // Routes
  const githubWebhook = createGithubWebhookRoute({
    db,
    logger,
    webhookSecret: config.GITHUB_WEBHOOK_SECRET,
    allowedInstallationIds: [installationId],
  });
  const githubOauthCallbackUrl = `${config.PUBLIC_URL}/oauth/github/callback`;
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
  });

  const app = createApp({
    logger,
    checkReady: createDbReadyCheck(db),
    mounts: [githubWebhook, githubOauth, slackCommand],
  });

  // Background loops (single active writer, KTD10)
  startWorkerLoop(worker, 1000, logger);
  startReminderLoop(scheduler.processDue, config.REMINDER_SCAN_INTERVAL_MS, logger);

  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    logger.info("service listening", { port: info.port, env: config.NODE_ENV });
  });
}

boot();
