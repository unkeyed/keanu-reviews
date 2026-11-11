import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "#lib";
import type { Db } from "../db/client.ts";
import { jobs } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { createGithubWebhookRoute } from "./webhook.ts";

const SECRET = "whsec_test";
const ALLOWED = ["42"];
const sign = (body: string): string =>
  `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createGithubWebhookRoute>;
let nudge: ReturnType<typeof vi.fn<() => void>>;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  nudge = vi.fn<() => void>();
  app = createGithubWebhookRoute({
    db,
    logger: createLogger("error"),
    webhookSecret: SECRET,
    allowedInstallationIds: ALLOWED,
    nudge,
  });
});
afterEach(() => close());

const post = (body: string, headers: Record<string, string>) =>
  app.request("/webhooks/github", { method: "POST", body, headers });

const jobCount = async (): Promise<number> => (await db.select().from(jobs)).length;

const body = (overrides: object = {}) =>
  JSON.stringify({ action: "opened", installation: { id: 42 }, number: 1, ...overrides });

describe("github webhook route", () => {
  it("rejects payloads larger than 1 MiB before signature verification or persistence", async () => {
    const oversized = "x".repeat(1024 * 1024 + 1);
    const res = await post(oversized, {
      "x-hub-signature-256": sign(oversized),
      "x-github-event": "pull_request",
      "x-github-delivery": "d-oversized",
      "content-type": "application/json",
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
    expect(await jobCount()).toBe(0);
  });

  it("accepts a valid, allowlisted delivery and enqueues exactly one job", async () => {
    const b = body();
    const res = await post(b, {
      "x-hub-signature-256": sign(b),
      "x-github-event": "pull_request",
      "x-github-delivery": "d-1",
    });
    expect(res.status).toBe(202);
    expect(await jobCount()).toBe(1);
    expect(nudge).toHaveBeenCalledOnce();
  });

  it("rejects a tampered body with 401 and writes no job", async () => {
    const b = body();
    const res = await post(`${b} `, {
      "x-hub-signature-256": sign(b),
      "x-github-event": "pull_request",
      "x-github-delivery": "d-2",
    });
    expect(res.status).toBe(401);
    expect(await jobCount()).toBe(0);
    expect(nudge).not.toHaveBeenCalled();
  });

  it("rejects a valid signature from a non-allowlisted installation (403, no job)", async () => {
    const b = body({ installation: { id: 999 } });
    const res = await post(b, {
      "x-hub-signature-256": sign(b),
      "x-github-event": "pull_request",
      "x-github-delivery": "d-3",
    });
    expect(res.status).toBe(403);
    expect(await jobCount()).toBe(0);
  });

  it("ACKs a duplicate delivery without creating a second job", async () => {
    const b = body();
    const headers = {
      "x-hub-signature-256": sign(b),
      "x-github-event": "pull_request",
      "x-github-delivery": "d-4",
    };
    await post(b, headers);
    const res = await post(b, headers);
    expect(res.status).toBe(200);
    expect(await jobCount()).toBe(1);
    expect(nudge).toHaveBeenCalledOnce();
  });
});
