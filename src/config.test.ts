import { describe, expect, it } from "vitest";
import { ConfigError, SECRET_KEYS, loadConfig } from "./config.ts";

const validEnv = (): NodeJS.ProcessEnv => ({
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
  GITHUB_WEBHOOK_SECRET: "whsec_test_secret",
  GITHUB_INSTALLATION_ID: "42",
  GITHUB_OAUTH_CLIENT_ID: "Iv1.client-id",
  GITHUB_OAUTH_CLIENT_SECRET: "github_oauth_client_secret",
  OAUTH_STATE_SECRET: "oauth_state_secret_with_at_least_32_bytes",
  PUBLIC_URL: "https://bot.example.com/",
  SLACK_BOT_TOKEN: "xoxb-test-token",
  SLACK_SIGNING_SECRET: "slack_signing_secret",
  SLACK_TEAM_ID: "T123",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
});

describe("loadConfig", () => {
  it("loads and validates when all required env vars are present", () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.GITHUB_APP_ID).toBe("123456");
    expect(cfg.GITHUB_INSTALLATION_ID).toBe("42");
    expect(cfg.PUBLIC_URL).toBe("https://bot.example.com");
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
    env.GITHUB_INSTALLATION_ID = "not-a-number";
    expect(() => loadConfig(env)).toThrowError(ConfigError);
  });

  it("rejects multiple GitHub installations for the single-installation release", () => {
    const env = validEnv();
    env.GITHUB_INSTALLATION_ID = "42,43";
    expect(() => loadConfig(env)).toThrowError(/single GitHub installation/i);
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
    expect(SECRET_KEYS).toContain("GITHUB_OAUTH_CLIENT_SECRET");
    expect(SECRET_KEYS).toContain("OAUTH_STATE_SECRET");
    expect(SECRET_KEYS).toContain("SLACK_OAUTH_CLIENT_SECRET");
    expect(SECRET_KEYS).toContain("SLACK_USER_TOKEN_ENC_KEY");
  });

  const ENC_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

  it("leaves quiet archiving disabled when none of its vars are set", () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.SLACK_OAUTH_CLIENT_ID).toBeUndefined();
    expect(cfg.SLACK_USER_TOKEN_ENC_KEY).toBeUndefined();
  });

  it("enables quiet archiving when all three vars are set", () => {
    const cfg = loadConfig({
      ...validEnv(),
      SLACK_OAUTH_CLIENT_ID: "1234.5678",
      SLACK_OAUTH_CLIENT_SECRET: "slack-oauth-secret",
      SLACK_USER_TOKEN_ENC_KEY: ENC_KEY,
    });
    expect(cfg.SLACK_OAUTH_CLIENT_ID).toBe("1234.5678");
  });

  it("rejects a partial quiet-archiving configuration naming the missing var", () => {
    const env = {
      ...validEnv(),
      SLACK_OAUTH_CLIENT_ID: "1234.5678",
      SLACK_OAUTH_CLIENT_SECRET: "slack-oauth-secret",
    };
    expect(() => loadConfig(env)).toThrowError(/SLACK_USER_TOKEN_ENC_KEY/);
  });

  it("rejects a token encryption key that is not 32 bytes", () => {
    const env = {
      ...validEnv(),
      SLACK_OAUTH_CLIENT_ID: "1234.5678",
      SLACK_OAUTH_CLIENT_SECRET: "slack-oauth-secret",
      SLACK_USER_TOKEN_ENC_KEY: "too-short",
    };
    expect(() => loadConfig(env)).toThrowError(/SLACK_USER_TOKEN_ENC_KEY/);
  });

  it.each([
    "ftp://bot.example.com",
    "http://bot.example.com",
    "https://user:password@bot.example.com",
    "https://bot.example.com/base-path",
    "https://bot.example.com/?query=not-allowed",
  ])("rejects a PUBLIC_URL that is not an HTTP(S) origin: %s", (publicUrl) => {
    const env = validEnv();
    env.PUBLIC_URL = publicUrl;
    expect(() => loadConfig(env)).toThrowError(/PUBLIC_URL/);
  });

  it.each(["http://localhost:3000/", "http://127.0.0.1:3000/", "http://[::1]:3000/"])(
    "allows an HTTP loopback origin for local development: %s",
    (publicUrl) => {
      const env = validEnv();
      env.PUBLIC_URL = publicUrl;
      expect(loadConfig(env).PUBLIC_URL).toBe(new URL(publicUrl).origin);
    },
  );

  it.each(["workspace-name", "E123", "T-123"])("rejects an invalid SLACK_TEAM_ID: %s", (teamId) => {
    const env = validEnv();
    env.SLACK_TEAM_ID = teamId;
    expect(() => loadConfig(env)).toThrowError(/SLACK_TEAM_ID/);
  });
});
