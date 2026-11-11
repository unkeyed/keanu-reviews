import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Db } from "#db";
import { ignoredReason } from "#events";
import { verifySignature } from "#github";
import type { Logger } from "#lib";
import { enqueueDeliveryJob } from "#queue";

export interface WebhookDeps {
  db: Db;
  logger: Logger;
  webhookSecret: string;
  allowedInstallationIds: string[];
  nudge: () => void;
}

export function createGithubWebhookRoute(deps: WebhookDeps): Hono {
  const app = new Hono();

  app.use(
    "/webhooks/github",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
  );

  app.post("/webhooks/github", async (c) => {
    const raw = await c.req.text(); // exact bytes GitHub signed — do not parse-then-restringify
    const signature = c.req.header("x-hub-signature-256");

    if (!verifySignature(raw, signature, deps.webhookSecret)) {
      deps.logger.warn("webhook signature rejected");
      return c.json({ error: "invalid_signature" }, 401);
    }

    let payload: { action?: string; installation?: { id?: number } };
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const installationId = payload.installation?.id;
    if (
      installationId === undefined ||
      !deps.allowedInstallationIds.includes(String(installationId))
    ) {
      deps.logger.warn("webhook rejected: installation not allowlisted", { installationId });
      return c.json({ error: "installation_not_allowed" }, 403);
    }

    const deliveryId = c.req.header("x-github-delivery");
    const event = c.req.header("x-github-event");
    if (!deliveryId || !event) {
      return c.json({ error: "missing_headers" }, 400);
    }

    const ignored = ignoredReason(event, payload);
    if (ignored) {
      deps.logger.debug("webhook ignored", {
        deliveryId,
        event,
        action: payload.action,
        reason: ignored,
      });
      return c.json({ ok: true, ignored }, 200);
    }

    const accepted = await enqueueDeliveryJob(deps.db, {
      deliveryId,
      event,
      action: payload.action ?? null,
      raw: payload,
    });
    if (!accepted.isNew) {
      deps.logger.info("duplicate delivery ignored", { deliveryId });
      return c.json({ ok: true, deduped: true }, 200);
    }

    deps.nudge();
    return c.json({ ok: true }, 202);
  });

  return app;
}
