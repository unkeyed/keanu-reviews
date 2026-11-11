import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "#config";
import type { Db } from "../db/client.ts";
import { createTestDb } from "../db/testDb.ts";
import { testContext } from "../testing/context.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
import { runReconcileClosedPullRequestsCli } from "./reconcileClosedPullRequests.ts";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
});
afterEach(() => close());

const io = () => ({ stdout: vi.fn(), stderr: vi.fn() });
const unopened = () => {
  throw new Error("the command opened the service context");
};

describe("reconcile closed pull requests CLI", () => {
  it.each([["--help"], ["-h"], ["--", "--help"]])(
    "prints usage for %s and exits 0",
    async (...args) => {
      const { stdout, stderr } = io();
      await expect(
        runReconcileClosedPullRequestsCli(args, { stdout, stderr }, unopened),
      ).resolves.toBe(0);
      expect(stdout).toHaveBeenCalledWith(
        expect.stringContaining("Usage: pnpm jobs:reconcile-closed-prs"),
      );
      expect(stderr).not.toHaveBeenCalled();
    },
  );

  it("rejects a positional argument with exit 2", async () => {
    const { stdout, stderr } = io();
    await expect(
      runReconcileClosedPullRequestsCli(["now"], { stdout, stderr }, unopened),
    ).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(stdout).not.toHaveBeenCalled();
  });

  it("prints a configuration error and exits 1", async () => {
    const { stdout, stderr } = io();
    const open = () => {
      throw new ConfigError(["SLACK_BOT_TOKEN: Required"]);
    };
    await expect(runReconcileClosedPullRequestsCli([], { stdout, stderr }, open)).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("SLACK_BOT_TOKEN"));
    expect(stdout).not.toHaveBeenCalled();
  });

  it("prints the run's summary, exits 0 and closes the service context", async () => {
    const { stdout, stderr } = io();
    const ctx = testContext(db, new FakeSlackGateway());

    await expect(
      runReconcileClosedPullRequestsCli(["--"], { stdout, stderr }, () => ctx),
    ).resolves.toBe(0);

    expect(JSON.parse(stdout.mock.calls[0]?.[0] as string)).toMatchObject({
      checked: 0,
      failed: 0,
      overlapped: false,
    });
    expect(stderr).not.toHaveBeenCalled();
    expect(ctx.closed()).toBe(true);
  });

  it("exits 1 with a generic message when the run throws", async () => {
    const { stdout, stderr } = io();
    const ctx = testContext(db, new FakeSlackGateway());
    await close();
    close = async () => {};

    await expect(
      runReconcileClosedPullRequestsCli([], { stdout, stderr }, () => ctx),
    ).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "pull request reconciliation failed; see logs for the pull requests that did not finish",
    );
    expect(ctx.closed()).toBe(true);
  });
});
