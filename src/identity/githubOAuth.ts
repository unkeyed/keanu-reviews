import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { Hono } from "hono";
import type { Db } from "#db";
import { type GithubOAuthClient, GithubOAuthError, verifyOAuthState } from "#github";
import type { Logger } from "#lib";
import { callbackHeaders, callbackPage } from "./callbackPage.ts";
import { createGithubLinkConfirmation } from "./store.ts";

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

const page = callbackPage("GitHub account link");

export function createGithubOAuthRoute(deps: GithubOAuthRouteDeps): Hono {
  const app = new Hono();

  app.use("/oauth/github/callback", callbackHeaders);

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
