import { describe, expect, it, vi } from "vitest";
import { SlackOAuthError, createSlackAuthorizeUrl, createSlackOAuthClient } from "./oauth.ts";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createSlackAuthorizeUrl", () => {
  it("requests the user leave scope and no bot scope", () => {
    const url = new URL(
      createSlackAuthorizeUrl({
        clientId: "cid",
        callbackUrl: "https://bot.example.com/oauth/slack/callback",
        state: "signed-state",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://bot.example.com/oauth/slack/callback",
    );
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("user_scope")).toBe("channels:write");
    expect(url.searchParams.get("scope")).toBe("");
  });
});

describe("createSlackOAuthClient.exchangeCode", () => {
  const client = (fetchFn: typeof globalThis.fetch) =>
    createSlackOAuthClient({ clientId: "cid", clientSecret: "secret", fetch: fetchFn });

  it("returns the authed user token, id, scope, and team", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        ok: true,
        authed_user: {
          id: "U7",
          access_token: "xoxp-user-token",
          scope: "channels:write",
          token_type: "user",
        },
        team: { id: "T123" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await client(fetchFn).exchangeCode({
      code: "code",
      callbackUrl: "https://bot.example.com/oauth/slack/callback",
    });
    expect(result).toEqual({
      authedUserId: "U7",
      accessToken: "xoxp-user-token",
      scope: "channels:write",
      teamId: "T123",
    });
  });

  it("throws with the Slack error code when ok is false", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ ok: false, error: "invalid_code" }),
    ) as unknown as typeof globalThis.fetch;
    await expect(
      client(fetchFn).exchangeCode({ code: "bad", callbackUrl: "https://x/cb" }),
    ).rejects.toMatchObject({ kind: "exchange", slackError: "invalid_code" });
  });

  it("rejects a response missing a user token or id", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ ok: true, authed_user: { id: "U7" }, team: { id: "T1" } }),
    ) as unknown as typeof globalThis.fetch;
    await expect(
      client(fetchFn).exchangeCode({ code: "c", callbackUrl: "https://x/cb" }),
    ).rejects.toBeInstanceOf(SlackOAuthError);
  });

  it("maps a network failure to a network error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("connreset");
    }) as unknown as typeof globalThis.fetch;
    await expect(
      client(fetchFn).exchangeCode({ code: "c", callbackUrl: "https://x/cb" }),
    ).rejects.toMatchObject({ kind: "network" });
  });
});
