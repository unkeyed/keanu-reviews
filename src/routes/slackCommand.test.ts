import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { findByGithubId } from "../db/repositories/identities.ts";
import { createTestDb } from "../db/testDb.ts";
import { createLogger } from "../logger.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import { createSlackCommandRoute } from "./slackCommand.ts";

const SECRET = "signing_secret";
const TS = String(Math.floor(Date.now() / 1000));
const sign = (body: string): string =>
  `v0=${createHmac("sha256", SECRET).update(`v0:${TS}:${body}`, "utf8").digest("hex")}`;

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createSlackCommandRoute>;
const fetchGithubUser = vi.fn(async (login: string) =>
  login === "octocat" ? { id: 583231, login: "octocat" } : undefined,
);

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  fetchGithubUser.mockClear();
  app = createSlackCommandRoute({
    db,
    slack: new FakeSlackClient(),
    fetchGithubUser,
    logger: createLogger("error"),
    signingSecret: SECRET,
  });
});
afterEach(() => close());

const post = (body: string, sig: string) =>
  app.request("/slack/commands", {
    method: "POST",
    body,
    headers: {
      "x-slack-request-timestamp": TS,
      "x-slack-signature": sig,
      "content-type": "application/x-www-form-urlencoded",
    },
  });

describe("slash command /link-github (U9)", () => {
  it("rejects request bodies larger than 64 KiB before command processing", async () => {
    const oversized = `user_id=U7&text=${"x".repeat(64 * 1024)}`;
    const res = await post(oversized, sign(oversized));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
    expect(fetchGithubUser).not.toHaveBeenCalled();
  });

  it("links the invoking Slack user to a resolved GitHub login", async () => {
    const body = "user_id=U7&text=octocat";
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    const row = await findByGithubId(db, 583231);
    expect(row?.slackUserId).toBe("U7");
    expect(row?.source).toBe("self-link");
  });

  it("rejects an invalid signature (401, no upsert)", async () => {
    const body = "user_id=U7&text=octocat";
    const res = await post(body, "v0=deadbeef");
    expect(res.status).toBe(401);
    expect(await findByGithubId(db, 583231)).toBeUndefined();
  });

  it("responds with an error for an unknown login without crashing", async () => {
    const body = "user_id=U7&text=ghost";
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { text: string };
    expect(json.text).toContain("No GitHub user");
  });
});
