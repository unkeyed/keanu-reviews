import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "#config";
import { createTestDb } from "../db/testDb.ts";
import { findByGithubId } from "../identity/store.ts";
import { testContext } from "../testing/context.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
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
  const io = () => ({ stdout: vi.fn(), stderr: vi.fn() });
  const unopened = () => {
    throw new Error("the command opened the service context");
  };

  it("returns a nonzero status for an invalid invocation before loading configuration", async () => {
    const { stdout, stderr } = io();

    await expect(runIdentityImportCli([], { stdout, stderr }, unopened)).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(stdout).not.toHaveBeenCalled();
  });

  it("accepts pnpm's forwarded option separator", async () => {
    const { stdout, stderr } = io();

    await expect(
      runIdentityImportCli(["--", "--help"], { stdout, stderr }, unopened),
    ).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(stderr).not.toHaveBeenCalled();
  });

  it("reports aggregate results and closes the service context", async () => {
    const { stdout, stderr } = io();
    const testDb = await createTestDb();
    const dir = await mkdtemp(join(tmpdir(), "identity-import-"));
    try {
      const file = join(dir, "identities.json");
      await writeFile(
        file,
        JSON.stringify([
          { github_login: "octocat", slack_user_id: "U123" },
          { github_login: "ghost", slack_user_id: "U999" },
        ]),
      );
      const ctx = testContext(testDb.db, new FakeSlackGateway(), {
        fetchGithubUser: async (login) => (login === "octocat" ? { id: 1, login } : undefined),
      });

      await expect(runIdentityImportCli(["--", file], { stdout, stderr }, () => ctx)).resolves.toBe(
        0,
      );

      expect(JSON.parse(stdout.mock.calls[0]?.[0] as string)).toEqual({
        imported: 1,
        skipped: 1,
        skippedByReason: { "unknown github login": 1 },
      });
      expect(stderr).not.toHaveBeenCalled();
      expect(ctx.closed()).toBe(true);
      expect((await findByGithubId(testDb.db, 1))?.slackUserId).toBe("U123");
    } finally {
      await rm(dir, { recursive: true });
      await testDb.client.close();
    }
  });

  it("reads the rows before the configuration, and reports a configuration error", async () => {
    const { stdout, stderr } = io();
    const dir = await mkdtemp(join(tmpdir(), "identity-import-"));
    try {
      const file = join(dir, "identities.csv");
      await writeFile(file, "github_login,slack_user_id\noctocat,U123\n");

      await expect(
        runIdentityImportCli([file], { stdout, stderr }, () => {
          throw new ConfigError(["DATABASE_URL: Required"]);
        }),
      ).resolves.toBe(1);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringMatching(/^Identity import failed: [\s\S]*DATABASE_URL/),
      );

      await expect(
        runIdentityImportCli([join(dir, "missing.csv")], { stdout, stderr }, unopened),
      ).resolves.toBe(1);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
