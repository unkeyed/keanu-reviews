import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { getSlackUserTokenRow } from "../db/repositories/slackUserTokens.ts";
import { oauthStateNonces, slackUserTokens } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { createOAuthState } from "../github/oauth.ts";
import { createLogger } from "../logger.ts";
import { createTokenCipher } from "../slack/tokenCipher.ts";
import { createSlackOAuthRoute } from "./slackOAuth.ts";

const STATE_SECRET = "oauth_state_secret_with_at_least_32_bytes";
const TEAM_ID = "T123";
const CALLBACK_URL = "https://bot.example.com/oauth/slack/callback";
const ENC_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const NOW = 1_800_000_000_000;
const cipher = createTokenCipher(ENC_KEY);

let db: Db;
let close: () => Promise<void>;
const exchangeCode = vi.fn();

beforeEach(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  close = () => testDb.client.close();
  exchangeCode.mockReset();
  exchangeCode.mockResolvedValue({
    authedUserId: "U7",
    accessToken: "xoxp-user-token",
    scope: "channels:write",
    teamId: TEAM_ID,
  });
});

afterEach(() => close());

function state(over: { slackUserId?: string; teamId?: string } = {}): string {
  return createOAuthState({
    secret: STATE_SECRET,
    slackUserId: over.slackUserId ?? "U7",
    slackTeamId: over.teamId ?? TEAM_ID,
    now: () => NOW,
    randomBytes: () => Buffer.alloc(16, 3),
  });
}

function app(now = NOW) {
  return createSlackOAuthRoute({
    db,
    logger: createLogger("error"),
    oauthClient: { exchangeCode },
    oauthStateSecret: STATE_SECRET,
    slackTeamId: TEAM_ID,
    callbackUrl: CALLBACK_URL,
    cipher,
    now: () => now,
  });
}

const callback = (oauthState: string, code = "one-time-code", now = NOW) =>
  app(now).request(`/oauth/slack/callback?${new URLSearchParams({ code, state: oauthState })}`);

describe("Slack OAuth callback", () => {
  it("stores an encrypted, decryptable token and consumes the state nonce", async () => {
    const res = await callback(state());

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(exchangeCode).toHaveBeenCalledWith({ code: "one-time-code", callbackUrl: CALLBACK_URL });

    const [row] = await db.select().from(slackUserTokens);
    expect(row?.slackUserId).toBe("U7");
    expect(row?.encryptedToken).not.toContain("xoxp-user-token"); // encrypted at rest
    expect(cipher.decrypt(row?.encryptedToken ?? "")).toBe("xoxp-user-token");
    expect(await db.select().from(oauthStateNonces)).toHaveLength(1);
  });

  it.each([
    ["malformed", "not-a-state"],
    ["tampered", `${state()}x`],
  ])("rejects %s state before exchanging the code", async (_case, oauthState) => {
    const res = await callback(oauthState);
    expect(res.status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(await db.select().from(slackUserTokens)).toHaveLength(0);
  });

  it("rejects when the authorizing user differs from the request initiator", async () => {
    exchangeCode.mockResolvedValueOnce({
      authedUserId: "U_OTHER",
      accessToken: "xoxp-user-token",
      scope: "channels:write",
      teamId: TEAM_ID,
    });
    const res = await callback(state());
    expect(res.status).toBe(400);
    expect(await db.select().from(slackUserTokens)).toHaveLength(0);
  });

  it("rejects when the required leave scope was not granted", async () => {
    exchangeCode.mockResolvedValueOnce({
      authedUserId: "U7",
      accessToken: "xoxp-user-token",
      scope: "chat:write",
      teamId: TEAM_ID,
    });
    const res = await callback(state());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("channels:write");
    expect(await db.select().from(slackUserTokens)).toHaveLength(0);
  });

  it("does not store a token when the exchange fails", async () => {
    exchangeCode.mockRejectedValueOnce(new Error("boom with secret detail"));
    const res = await callback(state());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret detail");
    expect(await db.select().from(slackUserTokens)).toHaveLength(0);
    expect(await db.select().from(oauthStateNonces)).toHaveLength(0);
  });

  it("rejects a replayed state nonce", async () => {
    expect((await callback(state())).status).toBe(200);
    const replay = await callback(state(), "another-code");
    expect(replay.status).toBe(409);
    expect(await getSlackUserTokenRow(db, TEAM_ID, "U7")).toBeTruthy();
    expect(await db.select().from(slackUserTokens)).toHaveLength(1);
  });
});
