import { serve } from "@hono/node-server";
import { type Config, ConfigError, SECRET_KEYS, loadConfig } from "./config.ts";
import { createDb } from "./db/client.ts";
import { createDbReadyCheck } from "./db/readiness.ts";
import { createInstallationAuth } from "./github/auth.ts";
import { createGithubOAuthClient } from "./github/oauth.ts";
import { octokitMintFn } from "./github/octokitAuth.ts";
import { createPullRequestSnapshotFetcher } from "./github/pullRequestSnapshot.ts";
import { createServiceHandlers } from "./handlers/deps.ts";
import { createLogger, registerSecretValues } from "./logger.ts";
import { createGithubOAuthRoute } from "./routes/githubOAuth.ts";
import { createGithubWebhookRoute } from "./routes/githubWebhook.ts";
import { createSlackCommandRoute } from "./routes/slackCommand.ts";
import { DAILY_RECONCILE_HOUR_UTC, startDailyLoop } from "./scheduler/dailyLoop.ts";
import { startReminderLoop } from "./scheduler/loop.ts";
import { createClosedPullRequestReconciliation } from "./scheduler/reconcileClosedPullRequests.ts";
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
  const logger = createLogger(config.LOG_LEVEL, { service: "keanu-reviews" });

  // Infrastructure
  const { db } = createDb(config.DATABASE_URL);
  const slack = createWebApiSlackClient(config.SLACK_BOT_TOKEN);
  const auth = createInstallationAuth(
    octokitMintFn(config.GITHUB_APP_ID, config.GITHUB_APP_PRIVATE_KEY),
  );
  const installationId = config.GITHUB_INSTALLATION_ID;
  const services = createServiceHandlers({ config, db, slack, logger, auth });

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
    // Don't remind the channel or remaining reviewers once the PR is ready to
    // merge or has REMINDER_SUPPRESS_APPROVALS approvals (default 1).
    suppressApprovals: config.REMINDER_SUPPRESS_APPROVALS,
    fetchPullRequest: services.fetchPullRequest,
    fetchApprovalCount: services.fetchApprovalCount,
  });
  const router = createRouter({
    ...services.handler,
    onReviewRequested: scheduler.onReviewRequested,
    onReviewSubmitted: scheduler.onReviewSubmitted,
    onReviewRequestRemoved: scheduler.onReviewRequestRemoved,
  });
  const worker = createWorker({ db, logger, router });

  // Routes
  const githubOauthCallbackUrl = `${config.PUBLIC_URL}/oauth/github/callback`;
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
    slackOauthCallbackUrl: services.slackOauthRoute
      ? `${config.PUBLIC_URL}/oauth/slack/callback`
      : undefined,
  });

  const app = createApp({
    logger,
    checkReady: createDbReadyCheck(db),
    mounts: [
      githubWebhook,
      githubOauth,
      slackCommand,
      ...(services.slackOauthRoute ? [services.slackOauthRoute] : []),
    ],
  });

  // Background loops (single active writer, KTD10).
  // Missed merge/close webhooks are caught by a daily in-process timer. There
  // is no cron library or platform scheduler; the reminder loop is a short
  // interval scan, so reconciliation keeps its own once-a-day timer.
  const reconcileClosedPullRequests = createClosedPullRequestReconciliation({
    handler: services.handler,
    fetchSnapshot: createPullRequestSnapshotFetcher(auth, installationId, { logger }),
    logger,
  });
  startWorkerLoop(worker, 1000, logger);
  startReminderLoop(scheduler.processDue, config.REMINDER_SCAN_INTERVAL_MS, logger);
  startDailyLoop(() => reconcileClosedPullRequests(), DAILY_RECONCILE_HOUR_UTC, logger);
  logger.info("closed pull request reconciliation scheduled", {
    hourUtc: DAILY_RECONCILE_HOUR_UTC,
  });

  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    logger.info("service listening", { port: info.port, env: config.NODE_ENV });
  });
}

boot();
