import { Hono } from "hono";
import type { ReadyCheck } from "./db/readiness.ts";
import type { Logger } from "./logger.ts";
import { createHealthRoutes } from "./routes/health.ts";

export interface AppDeps {
  logger: Logger;
  checkReady: ReadyCheck;
  /** Feature routes composed in index.ts (GitHub webhook U3, Slack command U9). */
  mounts?: Hono[];
}

/** Build the Hono application: health plus whatever feature routes are mounted. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route("/", createHealthRoutes(deps.checkReady));
  for (const m of deps.mounts ?? []) app.route("/", m);

  app.onError((err, c) => {
    deps.logger.error("unhandled request error", { err: err.message, path: c.req.path });
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
