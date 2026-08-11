import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, registerSecretValues } from "./logger.ts";

afterEach(() => vi.restoreAllMocks());

describe("logger redaction (KTD12)", () => {
  it("redacts fields whose key is a known secret", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    createLogger("info").info("test", {
      GITHUB_APP_PRIVATE_KEY: "topsecret",
      ok: "visible",
    });
    const out = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(out).toMatchObject({ GITHUB_APP_PRIVATE_KEY: "[redacted]", ok: "visible" });
  });

  it("redacts a registered secret value even when nested under an innocent key", () => {
    registerSecretValues(["xoxb-super-secret-token"]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    createLogger("info").info("test", { payload: { token: "xoxb-super-secret-token" } });
    const out = JSON.parse(String(spy.mock.calls[0]?.[0])) as { payload: { token: string } };
    expect(out.payload.token).toBe("[redacted]");
  });

  it("does not emit below the configured level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("warn");
    log.info("should not appear");
    expect(spy).not.toHaveBeenCalled();
  });

  it("serializes a redacted line at or above the threshold", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger("info");
    log.error("boom", { SLACK_BOT_TOKEN: "xoxb-leak" });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain("[redacted]");
    expect(spy.mock.calls[0]?.[0]).not.toContain("xoxb-leak");
  });
});
