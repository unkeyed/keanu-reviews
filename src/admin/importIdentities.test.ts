import { describe, expect, it, vi } from "vitest";
import type { LinkDeps } from "../identity/link.ts";
import {
  IdentityImportInputError,
  parseIdentityImport,
  runIdentityImportCli,
} from "./importIdentities.ts";

describe("identity import input", () => {
  it("parses and normalizes JSON rows", () => {
    expect(
      parseIdentityImport(
        JSON.stringify([
          { github_login: " octocat ", slack_user_id: " U123 " },
          { github_login: "hubot", slack_email: "hubot@example.com" },
        ]),
        ".json",
      ),
    ).toEqual([
      { github_login: "octocat", slack_user_id: "U123" },
      { github_login: "hubot", slack_email: "hubot@example.com" },
    ]);
  });

  it("parses CSV quoting without treating embedded commas as columns", () => {
    expect(
      parseIdentityImport(
        'github_login,slack_email,slack_user_id\n"octo,cat",octo@example.com,\nhubot,,U234\n',
        ".csv",
      ),
    ).toEqual([
      { github_login: "octo,cat", slack_email: "octo@example.com" },
      { github_login: "hubot", slack_user_id: "U234" },
    ]);
  });

  it("rejects unknown fields and malformed CSV", () => {
    expect(() => parseIdentityImport('[{"github_login":"octocat","admin":true}]', ".json")).toThrow(
      IdentityImportInputError,
    );
    expect(() => parseIdentityImport('github_login,slack_user_id\n"octocat,U1', ".csv")).toThrow(
      /unterminated/i,
    );
  });
});

describe("identity import CLI", () => {
  it("returns a nonzero status for an invalid invocation before loading configuration", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();

    await expect(runIdentityImportCli([], {}, { stdout, stderr })).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(stdout).not.toHaveBeenCalled();
  });

  it("accepts pnpm's forwarded option separator", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();

    await expect(runIdentityImportCli(["--", "--help"], {}, { stdout, stderr })).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(stderr).not.toHaveBeenCalled();
  });

  it("reports aggregate results and closes the production database dependency", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const close = vi.fn(async () => {});
    const env = {
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "not-used-by-test",
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
      OAUTH_STATE_SECRET: "a-secure-state-secret-of-32-characters",
      PUBLIC_URL: "http://localhost:3000",
      GITHUB_INSTALLATION_ID: "42",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "slack-secret",
      SLACK_TEAM_ID: "T123",
      DATABASE_URL: "postgres://user:pass@localhost/database",
    };

    await expect(
      runIdentityImportCli(
        ["identities.json"],
        env,
        { stdout, stderr },
        {
          loadRows: async () => [{ github_login: "octocat", slack_user_id: "U123" }],
          createRuntime: () => ({ deps: {} as LinkDeps, close }),
          importRows: async () => ({
            imported: 1,
            skipped: [
              {
                row: { github_login: "ghost", slack_user_id: "U999" },
                reason: "unknown github login",
              },
            ],
          }),
        },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(stdout.mock.calls[0]?.[0] as string)).toEqual({
      imported: 1,
      skipped: 1,
      skippedByReason: { "unknown github login": 1 },
    });
    expect(stderr).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
