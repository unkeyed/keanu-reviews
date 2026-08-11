import { Hono } from "hono";

/**
 * Health endpoint (U1). Returns 200 with basic service status so Unkey Deploy
 * (and local smoke checks) can confirm the process is up.
 */
export const health = new Hono();

const startedAt = Date.now();

health.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "unkey-slack-pr-bot",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }),
);
