import { Hono } from "hono";
import type { ReadyCheck } from "../db/readiness.ts";

/**
 * Liveness and readiness endpoints (U1). Liveness reports that the process is
 * serving; readiness additionally protects traffic from an unavailable or
 * unmigrated database.
 */
const startedAt = Date.now();

/**
 * The git commit this build was deployed from, so `/health` can confirm which
 * code is actually live (a redeploy that didn't restart still shows the old
 * SHA). Reads a generic override first, then common platform-provided vars.
 */
const version =
  process.env.UNKEY_GIT_COMMIT_SHA ||
  process.env.GIT_SHA ||
  process.env.RENDER_GIT_COMMIT ||
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.SOURCE_VERSION ||
  "unknown";

export function createHealthRoutes(checkReady: ReadyCheck): Hono {
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
    } catch {
      return c.json({ status: "unavailable", service: "keanu-reviews" }, 503);
    }
  });

  return health;
}
