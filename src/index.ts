import { serve } from "@hono/node-server";
import { createContext, createHttpApp, startBackground } from "#app";
import { type Config, ConfigError, loadConfig } from "#config";
import { errMessage } from "#lib";

// Most platforms send SIGKILL 30s after SIGTERM. Finish inside that window.
const SHUTDOWN_DEADLINE_MS = 20_000;

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

  const ctx = createContext(config);
  const { logger } = ctx;
  if (ctx.deps.authorPoster) {
    logger.info("quiet archiving + post-as-user enabled (Slack user OAuth configured)");
  }
  const background = startBackground(ctx);
  const server = serve(
    { fetch: createHttpApp(ctx, background.nudge).fetch, port: config.PORT },
    (info) => {
      logger.info("service listening", { port: info.port, env: config.NODE_ENV });
    },
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    const settled = Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      background.stop(),
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
      await ctx.close();
    } catch (err) {
      logger.error("database close failed", { err: errMessage(err) });
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

boot();
