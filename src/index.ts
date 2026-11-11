import { serve } from "@hono/node-server";
import { createDispatcher } from "#app";
import { type Config, ConfigError, SECRET_KEYS, loadConfig } from "#config";
import { createDb, createDbReadyCheck } from "#db";
import {
  createGithubOAuthClient,
  createInstallationAuth,
  createPullRequestSnapshotFetcher,
  octokitMintFn,
} from "#github";
import { createGithubOAuthRoute, createSlackCommandRoute } from "#identity";
import { createGithubWebhookRoute } from "#ingest";
import { createLogger, errMessage, registerSecrets } from "#lib";
import { createClosedPullRequestReconciliation } from "#pr";
import { pruneJobHistory } from "#queue";
import { createSlackGateway } from "#slack";
import { createServiceHandlers } from "./handlers/deps.ts";
import { DAILY_RECONCILE_HOUR_UTC, startDailyLoop } from "./scheduler/dailyLoop.ts";
import { startReminderLoop } from "./scheduler/loop.ts";
import { createReminderScheduler } from "./scheduler/reminders.ts";
import { createApp } from "./server.ts";
import { createWorker, startWorkerLoop } from "./worker/loop.ts";

// Most platforms send SIGKILL 30s after SIGTERM. Finish inside that window.
const SHUTDOWN_DEADLINE_MS = 20_000;
const JOB_RETENTION_MS = 14 * 24 * 60 * 60_000;

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

  registerSecrets({ keys: SECRET_KEYS, values: SECRET_KEYS.map((k) => config[k]) });
  const logger = createLogger(config.LOG_LEVEL, { service: "keanu-reviews" });

  // Infrastructure
  const { db, close: closeDb } = createDb(config.DATABASE_URL);
  const slack = createSlackGateway(config.SLACK_BOT_TOKEN, {
    onImageFallback: (info) =>
      logger.warn("slack refused embedded images; retrying with links", info),
  });
  const auth = createInstallationAuth(
    octokitMintFn(config.GITHUB_APP_ID, config.GITHUB_APP_PRIVATE_KEY),
  );
  const installationId = config.GITHUB_INSTALLATION_ID;
  const services = createServiceHandlers({ config, db, slack, logger, auth });

  // Scheduler + dispatcher + worker
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
    // Hold the 12h ping while CI is failing or still running.
    fetchCiReadiness: services.fetchCiReadiness,
  });
  const dispatch = createDispatcher({
    ...services.handler,
    fetchPrForSha: services.fetchPrForSha,
    onReviewRequested: scheduler.onReviewRequested,
    onReviewSubmitted: scheduler.onReviewSubmitted,
    onReviewRequestRemoved: scheduler.onReviewRequestRemoved,
    onReviewAlerted: scheduler.onReviewAlerted,
  });
  const worker = createWorker({ db, logger, dispatch });

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
      services.attachmentRoute,
      githubOauth,
      slackCommand,
      ...(services.slackOauthRoute ? [services.slackOauthRoute] : []),
    ],
  });

  // Background loops (single active writer, KTD10).
  // Missed merge/close webhooks are caught by a daily in-process timer. There
  // is no cron library or platform scheduler; the reminder loop is a short
  // interval scan, so reconciliation keeps its own once-a-day timer.
  const reconcileClosedPullRequests = createClosedPullRequestReconciliation(
    services.handler,
    createPullRequestSnapshotFetcher(auth, installationId, { logger }),
  );
  const workerLoop = startWorkerLoop(worker, 1000, logger);
  const reminderLoop = startReminderLoop(
    scheduler.processDue,
    config.REMINDER_SCAN_INTERVAL_MS,
    logger,
  );
  const pruneJobs = async () => {
    const pruned = await pruneJobHistory(db, new Date(Date.now() - JOB_RETENTION_MS));
    logger.info("pruned job history", pruned);
  };
  const isolated = (name: string, task: () => Promise<unknown>) =>
    task().catch((err) => {
      logger.error("daily task failed", {
        task: name,
        err: errMessage(err),
      });
    });
  const dailyLoop = startDailyLoop(
    () =>
      Promise.all([
        isolated("reconcile closed pull requests", reconcileClosedPullRequests),
        isolated("prune job history", pruneJobs),
      ]),
    DAILY_RECONCILE_HOUR_UTC,
    logger,
  );
  logger.info("closed pull request reconciliation scheduled", {
    hourUtc: DAILY_RECONCILE_HOUR_UTC,
  });

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    logger.info("service listening", { port: info.port, env: config.NODE_ENV });
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    dailyLoop.stop();
    const settled = Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      workerLoop.stop(),
      reminderLoop.stop(),
    ]).then(() => "drained" as const);
    const deadline = new Promise<"timeout">((resolve) => {
      setTimeout(resolve, SHUTDOWN_DEADLINE_MS, "timeout");
    });
    // Past the deadline an unfinished job keeps its lease and is reclaimed
    // after restart, so exiting cannot lose it.
    if ((await Promise.race([settled, deadline])) === "timeout") {
      logger.warn("shutdown deadline reached with work in flight", {
        deadlineMs: SHUTDOWN_DEADLINE_MS,
      });
    }
    try {
      await closeDb();
    } catch (err) {
      logger.error("database close failed", {
        err: errMessage(err),
      });
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

boot();
