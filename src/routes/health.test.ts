import { describe, expect, it } from "vitest";
import { health } from "./health.ts";

describe("health route", () => {
  it("returns 200 with service status", async () => {
    const res = await health.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("unkey-slack-pr-bot");
  });
});
