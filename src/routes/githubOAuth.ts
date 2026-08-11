import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { Hono } from "hono";
import type { Db } from "../db/client.ts";
import { createGithubLinkConfirmation } from "../db/repositories/githubLinks.ts";
import { type GithubOAuthClient, GithubOAuthError, verifyOAuthState } from "../github/oauth.ts";
import type { Logger } from "../logger.ts";

export interface GithubOAuthRouteDeps {
  db: Db;
  logger: Logger;
  oauthClient: GithubOAuthClient;
  oauthStateSecret: string;
  slackTeamId: string;
  callbackUrl: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

function page(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub account link</title></head><body><main><p>${message}</p></main></body></html>`;
}

export function createGithubOAuthRoute(deps: GithubOAuthRouteDeps): Hono {
  const app = new Hono();

  app.use("/oauth/github/callback", async (c, next) => {
    c.header("cache-control", "no-store");
    c.header("pragma", "no-cache");
    c.header("referrer-policy", "no-referrer");
    c.header(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    c.header("x-content-type-options", "nosniff");
    c.header("x-frame-options", "DENY");
    await next();
  });

  app.get("/oauth/github/callback", async (c) => {
    const oauthState = c.req.query("state") ?? "";
    const state = verifyOAuthState({
      state: oauthState,
      secret: deps.oauthStateSecret,
      expectedSlackTeamId: deps.slackTeamId,
      now: deps.now,
    });
    if (!state) return c.html(page("This account-link request is invalid or expired."), 400);

    const code = c.req.query("code");
    if (!code || code.length > 512) {
      return c.html(page("GitHub did not provide a valid authorization code."), 400);
    }

    let user: { id: number; login: string };
    try {
      user = await deps.oauthClient.authenticate({ code, callbackUrl: deps.callbackUrl });
    } catch (error) {
      deps.logger.warn("github oauth authentication failed", {
        kind: error instanceof GithubOAuthError ? error.kind : "unexpected",
        status: error instanceof GithubOAuthError ? error.status : undefined,
      });
      return c.html(
        page("GitHub authentication failed. Please return to Slack and try again."),
        502,
      );
    }

    const confirmationCode = (deps.randomBytes ?? cryptoRandomBytes)(24).toString("base64url");
    const pending = await createGithubLinkConfirmation(deps.db, {
      nonce: state.nonce,
      stateExpiresAt: new Date(state.expiresAt),
      code: confirmationCode,
      slackTeamId: state.slackTeamId,
      slackUserId: state.slackUserId,
      githubUserId: user.id,
      githubLogin: user.login,
      now: new Date((deps.now ?? Date.now)()),
    });
    if (pending.outcome === "state_replayed") {
      return c.html(page("This account-link request has already been used."), 409);
    }
    if (pending.outcome === "state_expired") {
      return c.html(
        page("This account-link request expired while GitHub was authenticating."),
        400,
      );
    }

    return c.html(
      page(
        `GitHub verified. Return to Slack and run <code>/link-github confirm ${confirmationCode}</code>. This one-time code expires shortly.`,
      ),
    );
  });

  return app;
}
