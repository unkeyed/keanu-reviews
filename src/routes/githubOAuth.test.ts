import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { findByGithubId } from "../db/repositories/identities.ts";
import { githubLinkConfirmations, oauthStateNonces } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { createOAuthState } from "../github/oauth.ts";
import { createLogger } from "../logger.ts";
import { createGithubOAuthRoute } from "./githubOAuth.ts";

const STATE_SECRET = "oauth_state_secret_with_at_least_32_bytes";
const TEAM_ID = "T123";
const CALLBACK_URL = "https://bot.example.com/oauth/github/callback";
const NOW = 1_800_000_000_000;
const CONFIRMATION_CODE = Buffer.alloc(24, 9).toString("base64url");

let db: Db;
let close: () => Promise<void>;
const authenticate = vi.fn(async () => ({ id: 583231, login: "octocat" }));

beforeEach(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  close = () => testDb.client.close();
  authenticate.mockReset();
  authenticate.mockResolvedValue({ id: 583231, login: "octocat" });
});

afterEach(() => close());

function state(teamId = TEAM_ID): string {
  return createOAuthState({
    secret: STATE_SECRET,
    slackUserId: "U7",
    slackTeamId: teamId,
    now: () => NOW,
    randomBytes: () => Buffer.alloc(16, 3),
  });
}

function app() {
  return createGithubOAuthRoute({
    db,
    logger: createLogger("error"),
    oauthClient: { authenticate },
    oauthStateSecret: STATE_SECRET,
    slackTeamId: TEAM_ID,
    callbackUrl: CALLBACK_URL,
    now: () => NOW,
    randomBytes: () => Buffer.alloc(24, 9),
  });
}

function callback(oauthState: string, code = "one-time-code") {
  const query = new URLSearchParams({ code, state: oauthState });
  return app().request(`/oauth/github/callback?${query}`);
}

describe("GitHub OAuth callback", () => {
  it.each([
    ["malformed", "not-a-state"],
    ["tampered", `${state()}x`],
    ["wrong-team", state("T-OTHER")],
  ])("rejects %s state before exchanging the code", async (_case, oauthState) => {
    const res = await callback(oauthState);

    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("rejects expired state before exchanging the code", async () => {
    const route = createGithubOAuthRoute({
      db,
      logger: createLogger("error"),
      oauthClient: { authenticate },
      oauthStateSecret: STATE_SECRET,
      slackTeamId: TEAM_ID,
      callbackUrl: CALLBACK_URL,
      now: () => NOW + 10 * 60_000 + 1,
    });

    const res = await route.request(
      `/oauth/github/callback?${new URLSearchParams({ code: "code", state: state() })}`,
    );
    expect(res.status).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("creates a Slack confirmation after GET /user without linking directly", async () => {
    const res = await callback(state());

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(authenticate).toHaveBeenCalledWith({ code: "one-time-code", callbackUrl: CALLBACK_URL });
    expect(await findByGithubId(db, 583231)).toBeUndefined();
    expect(await res.text()).toContain(`/link-github confirm ${CONFIRMATION_CODE}`);
    expect(await db.select().from(githubLinkConfirmations)).toHaveLength(1);
    expect(await db.select().from(oauthStateNonces)).toHaveLength(1);
  });

  it("does not persist an identity when exchange or user lookup fails", async () => {
    authenticate.mockRejectedValueOnce(new Error("oauth failed with secret details"));

    const res = await callback(state());

    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret details");
    expect(await findByGithubId(db, 583231)).toBeUndefined();
    expect(await db.select().from(githubLinkConfirmations)).toHaveLength(0);
    expect(await db.select().from(oauthStateNonces)).toHaveLength(0);
  });

  it("rejects replay of a signed state nonce after GitHub authentication", async () => {
    expect((await callback(state())).status).toBe(200);
    const replay = await callback(state(), "another-code");

    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain("already been used");
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(await db.select().from(githubLinkConfirmations)).toHaveLength(1);
    expect(await findByGithubId(db, 583231)).toBeUndefined();
  });
});
