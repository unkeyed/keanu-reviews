import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { createGithubLinkConfirmation } from "../db/repositories/githubLinks.ts";
import { findByGithubId } from "../db/repositories/identities.ts";
import { githubLinkConfirmations } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { verifyOAuthState } from "../github/oauth.ts";
import { createLogger } from "../logger.ts";
import { createSlackCommandRoute } from "./slackCommand.ts";

const SIGNING_SECRET = "signing_secret";
const STATE_SECRET = "oauth_state_secret_with_at_least_32_bytes";
const TEAM_ID = "T123";
const TS = String(Math.floor(Date.now() / 1000));
const NOW = Number(TS) * 1000;
const CONFIRMATION_CODE = Buffer.alloc(24, 5).toString("base64url");
const sign = (body: string): string =>
  `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${TS}:${body}`, "utf8").digest("hex")}`;

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  close = () => testDb.client.close();
});

afterEach(() => close());

function createApp(overrides: Partial<Parameters<typeof createSlackCommandRoute>[0]> = {}) {
  return createSlackCommandRoute({
    db,
    logger: createLogger("error"),
    signingSecret: SIGNING_SECRET,
    slackTeamId: TEAM_ID,
    oauthStateSecret: STATE_SECRET,
    githubOauthClientId: "Iv1.client-id",
    githubOauthCallbackUrl: "https://bot.example.com/oauth/github/callback",
    now: () => NOW,
    randomBytes: () => Buffer.alloc(16, 7),
    ...overrides,
  });
}

const post = (app: ReturnType<typeof createSlackCommandRoute>, body: string, sig = sign(body)) =>
  app.request("/slack/commands", {
    method: "POST",
    body,
    headers: {
      "x-slack-request-timestamp": TS,
      "x-slack-signature": sig,
      "content-type": "application/x-www-form-urlencoded",
    },
  });

const createPending = (over: Partial<Parameters<typeof createGithubLinkConfirmation>[1]> = {}) =>
  createGithubLinkConfirmation(db, {
    nonce: "route-state-nonce",
    stateExpiresAt: new Date(NOW + 10 * 60_000),
    code: CONFIRMATION_CODE,
    slackTeamId: TEAM_ID,
    slackUserId: "U7",
    githubUserId: 583231,
    githubLogin: "octocat",
    now: new Date(NOW),
    ...over,
  });

describe("slash command /link-github (U9)", () => {
  it("rejects request bodies larger than 64 KiB before command processing", async () => {
    const oversized = `user_id=U7&team_id=${TEAM_ID}&text=${"x".repeat(64 * 1024)}`;
    const res = await post(createApp(), oversized);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });

  it("rejects an invalid signature", async () => {
    const body = `user_id=U7&team_id=${TEAM_ID}`;
    const res = await post(createApp(), body, "v0=deadbeef");

    expect(res.status).toBe(401);
  });

  it.each([
    ["missing", "user_id=U7"],
    ["wrong", "user_id=U7&team_id=T-ATTACKER"],
  ])("rejects a %s Slack workspace", async (_case, body) => {
    const res = await post(createApp(), body);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "workspace_not_allowed" });
  });

  it("returns an ephemeral authorize URL whose state binds the Slack identity", async () => {
    const body = `user_id=U7&team_id=${TEAM_ID}`;
    const res = await post(createApp(), body);

    expect(res.status).toBe(200);
    const response = (await res.json()) as { response_type: string; text: string };
    expect(response.response_type).toBe("ephemeral");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const encodedUrl = response.text.match(/<(https:\/\/[^|]+)\|/)?.[1];
    expect(encodedUrl).toBeDefined();
    const authorizeUrl = new URL(encodedUrl as string);
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe("Iv1.client-id");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://bot.example.com/oauth/github/callback",
    );
    const state = verifyOAuthState({
      state: authorizeUrl.searchParams.get("state") ?? "",
      secret: STATE_SECRET,
      expectedSlackTeamId: TEAM_ID,
      now: () => Number(TS) * 1000,
    });
    expect(state).toMatchObject({ slackUserId: "U7", slackTeamId: TEAM_ID, version: 1 });
  });

  it("acknowledges without calling a database or network dependency", async () => {
    const externalIo = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected I/O"));
    const noDb = new Proxy(
      {},
      {
        get() {
          throw new Error("unexpected database I/O");
        },
      },
    ) as Db;
    const app = createApp({ db: noDb, randomBytes: () => Buffer.from("no-external-io!!") });
    const body = `user_id=U7&team_id=${TEAM_ID}`;

    const res = await post(app, body);

    expect(res.status).toBe(200);
    expect(externalIo).not.toHaveBeenCalled();
    externalIo.mockRestore();
  });

  it("rejects unknown command text without starting OAuth", async () => {
    const body = `user_id=U7&team_id=${TEAM_ID}&text=octocat`;
    const res = await post(createApp(), body);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      response_type: "ephemeral",
      text: expect.stringContaining("Usage"),
    });
  });

  it("confirms the verified GitHub account once for the bound Slack user", async () => {
    await createPending();
    const body = new URLSearchParams({
      user_id: "U7",
      team_id: TEAM_ID,
      text: `confirm ${CONFIRMATION_CODE}`,
    }).toString();

    const confirmed = await post(createApp(), body);
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get("cache-control")).toBe("no-store");
    expect(await confirmed.json()).toMatchObject({
      response_type: "ephemeral",
      text: expect.stringContaining("octocat"),
    });
    expect(await findByGithubId(db, 583231)).toMatchObject({ slackUserId: "U7" });

    const replay = await post(createApp(), body);
    expect(await replay.json()).toMatchObject({ text: expect.stringContaining("invalid") });
  });

  it("does not consume a confirmation presented by the wrong Slack user", async () => {
    await createPending();
    const attackerBody = new URLSearchParams({
      user_id: "U8",
      team_id: TEAM_ID,
      text: `confirm ${CONFIRMATION_CODE}`,
    }).toString();
    const ownerBody = new URLSearchParams({
      user_id: "U7",
      team_id: TEAM_ID,
      text: `confirm ${CONFIRMATION_CODE}`,
    }).toString();

    expect(await (await post(createApp(), attackerBody)).json()).toMatchObject({
      text: expect.stringContaining("invalid"),
    });
    expect(await db.select().from(githubLinkConfirmations)).toHaveLength(1);
    expect(await (await post(createApp(), ownerBody)).json()).toMatchObject({
      text: expect.stringContaining("octocat"),
    });
  });

  it("rejects and cleans up an expired confirmation", async () => {
    await createPending({ stateExpiresAt: new Date(NOW + 1_000) });
    const body = new URLSearchParams({
      user_id: "U7",
      team_id: TEAM_ID,
      text: `confirm ${CONFIRMATION_CODE}`,
    }).toString();

    const res = await post(createApp({ now: () => NOW + 1_000 }), body);
    expect(await res.json()).toMatchObject({ text: expect.stringContaining("expired") });
    expect(await db.select().from(githubLinkConfirmations)).toHaveLength(0);
    expect(await findByGithubId(db, 583231)).toBeUndefined();
  });
});

describe("slash command /link-slack (quiet archive)", () => {
  const slackDeps = {
    slackOauthClientId: "1234.5678",
    slackOauthCallbackUrl: "https://bot.example.com/oauth/slack/callback",
  };
  const body = new URLSearchParams({
    command: "/link-slack",
    user_id: "U7",
    team_id: TEAM_ID,
  }).toString();

  it("returns a signed Slack authorize URL for the requesting user", async () => {
    const res = await post(createApp(slackDeps), body);
    const json = (await res.json()) as { text: string };
    const match = /<(https:\/\/slack\.com\/oauth\/v2\/authorize[^|]+)\|/.exec(json.text);
    expect(match?.[1]).toBeTruthy();
    const url = new URL(match?.[1] ?? "");
    expect(url.searchParams.get("client_id")).toBe("1234.5678");
    expect(url.searchParams.get("user_scope")).toBe("channels:write");
    // State must verify and carry the requesting Slack user.
    const verified = verifyOAuthState({
      state: url.searchParams.get("state") ?? "",
      secret: STATE_SECRET,
      expectedSlackTeamId: TEAM_ID,
      now: () => NOW,
    });
    expect(verified?.slackUserId).toBe("U7");
  });

  it("reports not-configured when Slack OAuth is disabled", async () => {
    const res = await post(createApp(), body);
    expect(await res.json()).toMatchObject({ text: expect.stringContaining("isn't configured") });
  });
});
