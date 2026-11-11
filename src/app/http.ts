import { Hono } from "hono";
import { createDbReadyCheck } from "#db";
import { createGithubWebhookRoute } from "#ingest";
import type { AppContext } from "./context.ts";
import { createHealthRoutes } from "./health.ts";

/** The service's HTTP surface: health, the GitHub webhook, then the context's routes. */
export function createHttpApp(ctx: AppContext, nudge: () => void): Hono {
  const { config, db, logger } = ctx;
  const app = new Hono();
  app.route("/", createHealthRoutes(createDbReadyCheck(db)));
  app.route(
    "/",
    createGithubWebhookRoute({
      db,
      logger,
      webhookSecret: config.GITHUB_WEBHOOK_SECRET,
      allowedInstallationIds: [config.GITHUB_INSTALLATION_ID],
      nudge,
    }),
  );
  for (const route of ctx.routes) app.route("/", route);

  app.onError((err, c) => {
    logger.error("unhandled request error", { err: err.message, path: c.req.path });
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
