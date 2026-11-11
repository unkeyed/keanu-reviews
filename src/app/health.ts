import { Hono } from "hono";
import { serviceVersion } from "#config";
import type { ReadyCheck } from "#db";
import { type Logger, errMessage } from "#lib";

const startedAt = Date.now();
const version = serviceVersion();

/**
 * Liveness and readiness (U1). Liveness reports that the process is serving;
 * readiness also protects traffic from an unavailable or unmigrated database.
 */
export function createHealthRoutes(checkReady: ReadyCheck, logger: Logger): Hono {
  const health = new Hono();

  // Liveness deliberately has no external dependencies: it answers whether
  // this process can serve requests, even while a database incident is active.
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
