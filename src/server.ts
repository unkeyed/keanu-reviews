import { Hono } from "hono";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import { health } from "./routes/health.ts";

export interface AppDeps {
  config: Config;
  logger: Logger;
}

/**
 * Build the Hono application. Routes for webhook ingestion (U3) and the Slack
 * slash command (U9) mount here as those units land; U1 wires only health.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.route("/", health);

  app.onError((err, c) => {
    deps.logger.error("unhandled request error", { err: err.message, path: c.req.path });
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
