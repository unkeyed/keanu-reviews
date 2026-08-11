import { Hono } from "hono";
import type { Db } from "../db/client.ts";
import { markDeliverySeen } from "../db/repositories/deliveries.ts";
import { enqueueJob } from "../db/repositories/jobs.ts";
import { verifySignature } from "../github/verify.ts";
import type { Logger } from "../logger.ts";

export interface WebhookDeps {
  db: Db;
  logger: Logger;
  webhookSecret: string;
  /** Numeric installation ids allowed to reach this service (U3 allowlist). */
  allowedInstallationIds: string[];
}

/**
 * GitHub webhook receiver (U3). ACK-fast, process-async (KTD3): verify, authorize,
 * dedupe, persist a job, and return 2xx well within GitHub's ~10s window. A worker
 * (U4) processes the job later so slow Slack calls never trigger GitHub retries.
 */
export function createGithubWebhookRoute(deps: WebhookDeps): Hono {
  const app = new Hono();

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

    // Authorize: a valid signature proves authenticity, not that this is the
    // expected installation. Enforce the allowlist (KTD-driven, U3).
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

    // Dedupe: delivery is at-least-once; retries/redeliveries reuse the GUID (KTD4).
    const isNew = await markDeliverySeen(deps.db, deliveryId);
    if (!isNew) {
      deps.logger.info("duplicate delivery ignored", { deliveryId });
      return c.json({ ok: true, deduped: true }, 200);
    }

    await enqueueJob(deps.db, {
      deliveryId,
      event,
      action: payload.action ?? null,
      raw: payload,
    });

    return c.json({ ok: true }, 202);
  });

  return app;
}
