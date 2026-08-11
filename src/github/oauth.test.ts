import { describe, expect, it, vi } from "vitest";
import {
  GithubOAuthError,
  createGithubOAuthClient,
  createOAuthState,
  verifyOAuthState,
} from "./oauth.ts";

const SECRET = "oauth_state_secret_with_at_least_32_bytes";
const NOW = 1_800_000_000_000;

describe("GitHub OAuth state", () => {
  const makeState = () =>
    createOAuthState({
      secret: SECRET,
      slackUserId: "U123",
      slackTeamId: "T123",
      now: () => NOW,
      randomBytes: () => Buffer.alloc(16, 9),
    });

  it("round-trips a short-lived Slack-bound state", () => {
    expect(
      verifyOAuthState({
        state: makeState(),
        secret: SECRET,
        expectedSlackTeamId: "T123",
        now: () => NOW + 1,
      }),
    ).toMatchObject({
      version: 1,
      slackUserId: "U123",
      slackTeamId: "T123",
      expiresAt: NOW + 10 * 60_000,
    });
  });

  it("rejects tampering, expiry, and a different configured workspace", () => {
    const state = makeState();
    const last = state.at(-1) ?? "a";
    const tampered = `${state.slice(0, -1)}${last === "a" ? "b" : "a"}`;

    expect(
      verifyOAuthState({ state: tampered, secret: SECRET, expectedSlackTeamId: "T123" }),
    ).toBeUndefined();
    expect(
      verifyOAuthState({
        state,
        secret: SECRET,
        expectedSlackTeamId: "T123",
        now: () => NOW + 10 * 60_000 + 1,
      }),
    ).toBeUndefined();
    expect(
      verifyOAuthState({
        state,
        secret: SECRET,
        expectedSlackTeamId: "T-OTHER",
        now: () => NOW,
      }),
    ).toBeUndefined();
  });
});

describe("GitHub OAuth client", () => {
  it("exchanges the code and validates the authenticated immutable user identity", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "ghu_private_token", token_type: "bearer" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 583231, login: "octocat" }), { status: 200 }),
      );
    const client = createGithubOAuthClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: fetchFn,
      timeoutMs: 500,
    });

    await expect(
      client.authenticate({
        code: "one-time-code",
        callbackUrl: "https://bot.example.com/oauth/github/callback",
      }),
    ).resolves.toEqual({ id: 583231, login: "octocat" });

    const [exchangeUrl, exchangeInit] = fetchFn.mock.calls[0] ?? [];
    expect(exchangeUrl).toBe("https://github.com/login/oauth/access_token");
    expect(String(exchangeInit?.body)).toContain("code=one-time-code");
    expect(exchangeInit?.signal).toBeInstanceOf(AbortSignal);
    const [userUrl, userInit] = fetchFn.mock.calls[1] ?? [];
    expect(userUrl).toBe("https://api.github.com/user");
    expect((userInit?.headers as Record<string, string>).authorization).toBe(
      "Bearer ghu_private_token",
    );
  });

  it.each(["exchange", "user API"])(
    "classifies a failed %s without returning an identity",
    async (stage) => {
      const fetchFn = vi.fn<typeof fetch>();
      if (stage === "exchange") {
        fetchFn.mockResolvedValueOnce(new Response("no", { status: 400 }));
      } else {
        fetchFn
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ access_token: "ghu_private_token" }), { status: 200 }),
          )
          .mockResolvedValueOnce(new Response("no", { status: 503 }));
      }
      const client = createGithubOAuthClient({
        clientId: "client-id",
        clientSecret: "client-secret",
        fetch: fetchFn,
      });

      await expect(
        client.authenticate({
          code: "code",
          callbackUrl: "https://bot.example.com/oauth/github/callback",
        }),
      ).rejects.toBeInstanceOf(GithubOAuthError);
    },
  );

  it("bounds OAuth requests and classifies timeouts", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const client = createGithubOAuthClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: fetchFn,
      timeoutMs: 1,
    });

    await expect(
      client.authenticate({
        code: "code",
        callbackUrl: "https://bot.example.com/oauth/github/callback",
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });
});
