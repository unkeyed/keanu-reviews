import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyOAuthState } from "../github/oauth.ts";
import { createLogger } from "../logger.ts";
import { createSlackCommandRoute } from "./slackCommand.ts";

const SIGNING_SECRET = "signing_secret";
const STATE_SECRET = "oauth_state_secret_with_at_least_32_bytes";
const TEAM_ID = "T123";
const TS = String(Math.floor(Date.now() / 1000));
const sign = (body: string): string =>
  `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${TS}:${body}`, "utf8").digest("hex")}`;

function createApp(overrides: Partial<Parameters<typeof createSlackCommandRoute>[0]> = {}) {
  return createSlackCommandRoute({
    logger: createLogger("error"),
    signingSecret: SIGNING_SECRET,
    slackTeamId: TEAM_ID,
    oauthStateSecret: STATE_SECRET,
    githubOauthClientId: "Iv1.client-id",
    githubOauthCallbackUrl: "https://bot.example.com/oauth/github/callback",
    now: () => Number(TS) * 1000,
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
    const body = `user_id=U7&team_id=${TEAM_ID}&text=ignored-attacker-login`;
    const res = await post(createApp(), body);

    expect(res.status).toBe(200);
    const response = (await res.json()) as { response_type: string; text: string };
    expect(response.response_type).toBe("ephemeral");
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
    const app = createApp({ randomBytes: () => Buffer.from("no-external-io!!") });
    const body = `user_id=U7&team_id=${TEAM_ID}`;

    const res = await post(app, body);

    expect(res.status).toBe(200);
    expect(externalIo).not.toHaveBeenCalled();
    externalIo.mockRestore();
  });
});
