import { ConfigError } from "#config";
import { createClosedPullRequestReconciliation } from "#pr";
import { type CliIo, type OpenContext, runAsMain } from "./cli.ts";

const USAGE = `Usage: pnpm jobs:reconcile-closed-prs

Read GitHub for pull requests whose Slack channels are still open, and archive
channels for pull requests that have been merged or closed. Safe to re-run.
There is no HTTP trigger.`;

export async function runReconcileClosedPullRequestsCli(
  args: string[],
  io: CliIo,
  open: OpenContext,
): Promise<number> {
  // pnpm forwards the conventional option separator to this Node entrypoint.
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
    const ctx = open();
    close = ctx.close;
    const summary = await createClosedPullRequestReconciliation(ctx.deps, ctx.fetchSnapshot)();
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

await runAsMain(import.meta.url, runReconcileClosedPullRequestsCli);
