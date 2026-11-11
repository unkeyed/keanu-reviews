import { Hono } from "hono";
import { serviceVersion } from "#config";
import type { ReadyCheck } from "#db";
import { type Logger, errMessage } from "#lib";

const startedAt = Date.now();
const version = serviceVersion();

export function createHealthRoutes(checkReady: ReadyCheck, logger: Logger): Hono {
  const health = new Hono();

  health.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "keanu-reviews",
      version,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }),
  );

  health.get("/ready", async (c) => {
    try {
      await checkReady();
      return c.json({ status: "ready", service: "keanu-reviews" });
    } catch (err) {
      logger.warn("readiness check failed", { err: errMessage(err) });
      return c.json({ status: "unavailable", service: "keanu-reviews" }, 503);
    }
  });

  return health;
}
