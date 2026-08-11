import { Hono } from "hono";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import { health } from "./routes/health.ts";

export interface AppDeps {
  config: Config;
  logger: Logger;
  /** Feature routes composed in index.ts (GitHub webhook U3, Slack command U9). */
  mounts?: Hono[];
}

/** Build the Hono application: health plus whatever feature routes are mounted. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route("/", health);
  for (const m of deps.mounts ?? []) app.route("/", m);

  app.onError((err, c) => {
    deps.logger.error("unhandled request error", { err: err.message, path: c.req.path });
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
