import { serve } from "@hono/node-server";
import { createContext, createHttpApp, startBackground } from "#app";
import { type Config, ConfigError, loadConfig } from "#config";
import { errMessage } from "#lib";

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
  const shutdown = async (signal: string, exitCode: number) => {
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
    process.exit(exitCode);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  const fatal = (kind: string) => (err: unknown) => {
    logger.error(kind, {
      err: errMessage(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    void shutdown(kind, 1);
  };
  process.on("unhandledRejection", fatal("unhandled rejection"));
  process.on("uncaughtException", fatal("uncaught exception"));
}

boot();
