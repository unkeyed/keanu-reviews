import { Hono } from "hono";
import type { Db } from "../db/client.ts";
import { linkSelfIdentity } from "../db/repositories/identities.ts";
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

    const linked = await linkSelfIdentity(deps.db, {
      githubUserId: user.id,
      githubLogin: user.login,
      slackUserId: state.slackUserId,
    });
    if (linked.outcome === "conflict") {
      deps.logger.warn("github identity link rejected because it already has an owner", {
        githubUserId: user.id,
      });
      return c.html(page("That GitHub account is already linked to another Slack user."), 409);
    }

    return c.html(page("Your verified GitHub account is now linked. You can close this window."));
  });

  return app;
}
