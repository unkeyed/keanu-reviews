import { ConfigError } from "#config";
import { errMessage } from "#lib";
import { resetFailedJob } from "#queue";
import { type CliIo, type OpenContext, runAsMain } from "./cli.ts";

const USAGE = "Usage: pnpm jobs:replay <failed-job-id>";

export async function runReplayJobCli(
  args: string[],
  io: CliIo,
  open: OpenContext,
): Promise<number> {
  // pnpm forwards the conventional option separator to this Node entrypoint.
  const jobId = args[0] === "--" ? args[1] : args[0];
  if (!jobId) {
    io.stderr(USAGE);
    return 1;
  }
  let close: (() => Promise<void>) | undefined;
  try {
    const ctx = open();
    close = ctx.close;
    if (!(await resetFailedJob(ctx.db, jobId))) {
      io.stderr(`Job ${jobId} is not failed or has no retained replay payload`);
      return 1;
    }
    io.stdout(JSON.stringify({ ok: true, jobId }));
    return 0;
  } catch (error) {
    io.stderr(error instanceof ConfigError ? error.message : errMessage(error));
    return 1;
  } finally {
    await close?.();
  }
}

await runAsMain(import.meta.url, runReplayJobCli);
