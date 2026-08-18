import { describe, expect, it } from "vitest";
import { createHealthRoutes } from "./health.ts";

describe("health route", () => {
  it("returns 200 with service status", async () => {
    const health = createHealthRoutes(async () => {});
    const res = await health.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("keanu-reviews");
  });

  it("returns ready after the dependency check succeeds", async () => {
    const health = createHealthRoutes(async () => {});
    const res = await health.request("/ready");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", service: "keanu-reviews" });
  });

  it("returns 503 without leaking details when the dependency check fails", async () => {
    const health = createHealthRoutes(async () => {
      throw new Error("password=do-not-return");
    });
    const res = await health.request("/ready");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "unavailable",
      service: "keanu-reviews",
    });
  });
});
