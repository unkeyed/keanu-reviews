import { pathToFileURL } from "node:url";
import { ConfigError, SECRET_KEYS, loadConfig } from "../config.ts";
import { createDb } from "../db/client.ts";
import { createInstallationAuth } from "../github/auth.ts";
import { octokitMintFn } from "../github/octokitAuth.ts";
import { createPullRequestSnapshotFetcher } from "../github/pullRequestSnapshot.ts";
import { createServiceHandlers } from "../handlers/deps.ts";
import { createLogger, registerSecretValues } from "../logger.ts";
import { createClosedPullRequestReconciliation } from "../scheduler/reconcileClosedPullRequests.ts";
import { createWebApiSlackClient } from "../slack/webApiClient.ts";

const USAGE = `Usage: pnpm jobs:reconcile-closed-prs

Read GitHub for pull requests whose Slack channels are still open, and archive
channels for pull requests that have been merged or closed. Safe to re-run.
There is no HTTP trigger.`;

export async function runReconcileClosedPullRequestsCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: { stdout: (message: string) => void; stderr: (message: string) => void } = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  },
): Promise<number> {
  const positional = args[0] === "--" ? args.slice(1) : args;
  if (positional.length === 1 && (positional[0] === "--help" || positional[0] === "-h")) {
    io.stdout(USAGE);
    return 0;
  }
  if (positional.length !== 0) {
    io.stderr(USAGE);
    return 2;
  }

  let close: (() => Promise<void>) | undefined;
  try {
    const config = loadConfig(env);
    registerSecretValues(
      SECRET_KEYS.map((key) => config[key]).filter(
        (value): value is string => typeof value === "string",
      ),
    );
    const logger = createLogger(config.LOG_LEVEL, { service: "keanu-reviews" });
    const auth = createInstallationAuth(
      octokitMintFn(config.GITHUB_APP_ID, config.GITHUB_APP_PRIVATE_KEY),
    );
    const slack = createWebApiSlackClient(config.SLACK_BOT_TOKEN);
    // Open the pool last so a failure while building clients cannot strand it.
    const database = createDb(config.DATABASE_URL);
    close = database.close;
    const services = createServiceHandlers({ config, db: database.db, slack, logger, auth });
    const run = createClosedPullRequestReconciliation({
      handler: services.handler,
      fetchSnapshot: createPullRequestSnapshotFetcher(auth, config.GITHUB_INSTALLATION_ID, {
        logger,
      }),
      logger,
    });
    const summary = await run();
    io.stdout(JSON.stringify(summary));
    return summary.failed > 0 ? 1 : 0;
  } catch (error) {
    io.stderr(
      error instanceof ConfigError
        ? error.message
        : "pull request reconciliation failed; see logs for the pull requests that did not finish",
    );
    return 1;
  } finally {
    await close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runReconcileClosedPullRequestsCli(process.argv.slice(2));
}
