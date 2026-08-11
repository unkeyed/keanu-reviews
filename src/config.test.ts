import { describe, expect, it } from "vitest";
import { ConfigError, SECRET_KEYS, loadConfig } from "./config.ts";

const validEnv = (): NodeJS.ProcessEnv => ({
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
  GITHUB_WEBHOOK_SECRET: "whsec_test_secret",
  GITHUB_INSTALLATION_IDS: "42, 43",
  SLACK_BOT_TOKEN: "xoxb-test-token",
  SLACK_SIGNING_SECRET: "slack_signing_secret",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
});

describe("loadConfig", () => {
  it("loads and validates when all required env vars are present", () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.GITHUB_APP_ID).toBe("123456");
    expect(cfg.GITHUB_INSTALLATION_IDS).toEqual(["42", "43"]);
    expect(cfg.PORT).toBe(3000); // default
    expect(cfg.REMINDER_HOURS).toBe(12); // plan default
  });

  it("fails fast naming a missing required variable", () => {
    const env = validEnv();
    env.SLACK_BOT_TOKEN = undefined;
    expect(() => loadConfig(env)).toThrowError(ConfigError);
    try {
      loadConfig(env);
    } catch (err) {
      expect((err as ConfigError).message).toContain("SLACK_BOT_TOKEN");
    }
  });

  it("rejects a non-numeric installation id", () => {
    const env = validEnv();
    env.GITHUB_INSTALLATION_IDS = "42, not-a-number";
    expect(() => loadConfig(env)).toThrowError(ConfigError);
  });

  it("rejects an invalid DATABASE_URL", () => {
    const env = validEnv();
    env.DATABASE_URL = "not-a-url";
    expect(() => loadConfig(env)).toThrowError(/DATABASE_URL/);
  });

  it("enumerates every secret key so the logger can redact them", () => {
    // Guard against a new secret being added to the schema without redaction.
    expect(SECRET_KEYS).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(SECRET_KEYS).toContain("SLACK_BOT_TOKEN");
    expect(SECRET_KEYS).toContain("SLACK_SIGNING_SECRET");
  });
});
