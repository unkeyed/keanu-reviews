import { describe, expect, it, vi } from "vitest";
import { createLogger } from "#lib";
import { createHealthRoutes } from "./health.ts";

describe("health route", () => {
  it("returns 200 with service status", async () => {
    const health = createHealthRoutes(async () => {}, createLogger("error"));
    const res = await health.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("keanu-reviews");
    expect(typeof body.version).toBe("string"); // build SHA (or "unknown") for deploy verification
  });

  it("returns ready after the dependency check succeeds", async () => {
    const health = createHealthRoutes(async () => {}, createLogger("error"));
    const res = await health.request("/ready");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", service: "keanu-reviews" });
  });

  it("returns 503 without leaking details when the dependency check fails, and logs why", async () => {
    const warn = vi.fn();
    const health = createHealthRoutes(
      async () => {
        throw new Error('column "merge_comment_posted_at" does not exist');
      },
      { ...createLogger("error"), warn },
    );
    const res = await health.request("/ready");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "unavailable",
      service: "keanu-reviews",
    });
    expect(warn).toHaveBeenCalledWith("readiness check failed", {
      err: 'column "merge_comment_posted_at" does not exist',
    });
  });

  it("logs nothing when the dependency check passes", async () => {
    const warn = vi.fn();
    const health = createHealthRoutes(async () => {}, { ...createLogger("error"), warn });
    expect((await health.request("/ready")).status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });
});
