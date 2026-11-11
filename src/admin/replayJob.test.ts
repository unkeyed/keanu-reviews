import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "#config";
import type { Db } from "../db/client.ts";
import { jobs } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { testContext } from "../testing/context.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
import { enqueueTestJob } from "../testing/queue.ts";
import { runReplayJobCli } from "./replayJob.ts";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
});
afterEach(() => close());

const io = () => ({ stdout: vi.fn(), stderr: vi.fn() });

async function failedJob(id: string, raw: unknown = { kept: true }): Promise<void> {
  await enqueueTestJob(db, { deliveryId: id, event: "pull_request", action: "opened", raw });
  await db.update(jobs).set({ status: "failed", attempts: 8 }).where(eq(jobs.id, id));
}

describe("replay job CLI", () => {
  it("puts a failed job back in the queue and prints it", async () => {
    await failedJob("job-1");
    const { stdout, stderr } = io();
    const ctx = testContext(db, new FakeSlackGateway());

    await expect(runReplayJobCli(["job-1"], { stdout, stderr }, () => ctx)).resolves.toBe(0);

    expect(stdout).toHaveBeenCalledWith(JSON.stringify({ ok: true, jobId: "job-1" }));
    expect(stderr).not.toHaveBeenCalled();
    expect((await db.select().from(jobs).where(eq(jobs.id, "job-1")))[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      raw: { kept: true },
    });
    expect(ctx.closed()).toBe(true);
  });

  it("exits 1 for a job that is not failed or kept no payload", async () => {
    await enqueueTestJob(db, {
      deliveryId: "pending-1",
      event: "pull_request",
      action: null,
      raw: {},
    });
    await failedJob("purged-1");
    await db.update(jobs).set({ raw: null }).where(eq(jobs.id, "purged-1"));
    const ctx = testContext(db, new FakeSlackGateway());

    for (const id of ["pending-1", "purged-1", "missing-1"]) {
      const { stdout, stderr } = io();
      await expect(runReplayJobCli([id], { stdout, stderr }, () => ctx)).resolves.toBe(1);
      expect(stderr).toHaveBeenCalledWith(
        `Job ${id} is not failed or has no retained replay payload`,
      );
      expect(stdout).not.toHaveBeenCalled();
    }
  });

  it("exits 1 with usage when no job id is given, before opening the context", async () => {
    const { stdout, stderr } = io();
    const open = vi.fn();
    await expect(runReplayJobCli([], { stdout, stderr }, open)).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith("Usage: pnpm jobs:replay <failed-job-id>");
    expect(open).not.toHaveBeenCalled();
  });

  it("exits 1 with the configuration error", async () => {
    const { stdout, stderr } = io();
    const open = () => {
      throw new ConfigError(["DATABASE_URL: Required"]);
    };
    await expect(runReplayJobCli(["job-1"], { stdout, stderr }, open)).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("DATABASE_URL"));
  });
});
