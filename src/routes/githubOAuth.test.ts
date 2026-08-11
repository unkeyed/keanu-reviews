import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { findByGithubId, upsertIdentity } from "../db/repositories/identities.ts";
import { createTestDb } from "../db/testDb.ts";
import { createOAuthState } from "../github/oauth.ts";
import { createLogger } from "../logger.ts";
import { createGithubOAuthRoute } from "./githubOAuth.ts";

const STATE_SECRET = "oauth_state_secret_with_at_least_32_bytes";
const TEAM_ID = "T123";
const CALLBACK_URL = "https://bot.example.com/oauth/github/callback";
const NOW = 1_800_000_000_000;

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

  it("persists only the identity returned by authenticated GET /user", async () => {
    const res = await callback(state());

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(authenticate).toHaveBeenCalledWith({ code: "one-time-code", callbackUrl: CALLBACK_URL });
    expect(await findByGithubId(db, 583231)).toMatchObject({
      githubLogin: "octocat",
      slackUserId: "U7",
      source: "self-link",
    });
  });

  it("does not persist an identity when exchange or user lookup fails", async () => {
    authenticate.mockRejectedValueOnce(new Error("oauth failed with secret details"));

    const res = await callback(state());

    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret details");
    expect(await findByGithubId(db, 583231)).toBeUndefined();
  });

  it("rejects takeover of a GitHub identity already mapped to another Slack user", async () => {
    await upsertIdentity(db, {
      githubUserId: 583231,
      githubLogin: "old-login",
      slackUserId: "U-OWNER",
      source: "admin-import",
    });

    const res = await callback(state());

    expect(res.status).toBe(409);
    expect(await findByGithubId(db, 583231)).toMatchObject({
      githubLogin: "old-login",
      slackUserId: "U-OWNER",
      source: "admin-import",
    });
  });

  it("allows the same Slack owner to reauthenticate and refresh the login", async () => {
    await upsertIdentity(db, {
      githubUserId: 583231,
      githubLogin: "old-login",
      slackUserId: "U7",
      source: "self-link",
    });

    const res = await callback(state());

    expect(res.status).toBe(200);
    expect(await findByGithubId(db, 583231)).toMatchObject({
      githubLogin: "octocat",
      slackUserId: "U7",
    });
  });
});
