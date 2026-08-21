import { Hono } from "hono";
import type { Db } from "../db/client.ts";
import { completeSlackTokenAuthorization } from "../db/repositories/slackUserTokens.ts";
import { verifyOAuthState } from "../github/oauth.ts";
import type { Logger } from "../logger.ts";
import {
  SLACK_LEAVE_USER_SCOPE,
  type SlackOAuthClient,
  SlackOAuthError,
  hasScope,
} from "../slack/oauth.ts";
import type { TokenCipher } from "../slack/tokenCipher.ts";

export interface SlackOAuthRouteDeps {
  db: Db;
  logger: Logger;
  oauthClient: SlackOAuthClient;
  oauthStateSecret: string;
  slackTeamId: string;
  callbackUrl: string;
  cipher: TokenCipher;
  now?: () => number;
}

function page(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Slack quiet-archive setup</title></head><body><main><p>${message}</p></main></body></html>`;
}

export function createSlackOAuthRoute(deps: SlackOAuthRouteDeps): Hono {
  const app = new Hono();

  app.use("/oauth/slack/callback", async (c, next) => {
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

  app.get("/oauth/slack/callback", async (c) => {
    const state = verifyOAuthState({
      state: c.req.query("state") ?? "",
      secret: deps.oauthStateSecret,
      expectedSlackTeamId: deps.slackTeamId,
      now: deps.now,
    });
    if (!state) return c.html(page("This authorization request is invalid or expired."), 400);

    const code = c.req.query("code");
    if (!code || code.length > 1024) {
      return c.html(page("Slack did not provide a valid authorization code."), 400);
    }

    let result: Awaited<ReturnType<SlackOAuthClient["exchangeCode"]>>;
    try {
      result = await deps.oauthClient.exchangeCode({ code, callbackUrl: deps.callbackUrl });
    } catch (error) {
      deps.logger.warn("slack oauth exchange failed", {
        kind: error instanceof SlackOAuthError ? error.kind : "unexpected",
        slackError: error instanceof SlackOAuthError ? error.slackError : undefined,
      });
      return c.html(page("Slack authorization failed. Please return to Slack and try again."), 502);
    }

    // The user who authorized must be the one who started the flow, in this
    // workspace, and must have granted the scope we need to make them leave.
    if (result.authedUserId !== state.slackUserId || result.teamId !== state.slackTeamId) {
      deps.logger.warn("slack oauth identity mismatch");
      return c.html(page("This authorization did not match the request. Please try again."), 400);
    }
    if (!hasScope(result.scope, SLACK_LEAVE_USER_SCOPE)) {
      return c.html(
        page(
          `Missing the required permission (<code>${SLACK_LEAVE_USER_SCOPE}</code>). Please approve it and try again.`,
        ),
        400,
      );
    }

    const stored = await completeSlackTokenAuthorization(deps.db, {
      nonce: state.nonce,
      stateExpiresAt: new Date(state.expiresAt),
      slackUserId: state.slackUserId,
      slackTeamId: state.slackTeamId,
      encryptedToken: deps.cipher.encrypt(result.accessToken),
      scopes: result.scope,
      now: new Date((deps.now ?? Date.now)()),
    });
    if (stored.outcome === "state_replayed") {
      return c.html(page("This authorization request has already been used."), 409);
    }
    if (stored.outcome === "state_expired") {
      return c.html(
        page("This authorization request expired. Please start again from Slack."),
        400,
      );
    }

    return c.html(
      page("Thanks! PR channels you're in will now be archived quietly, with no notification."),
    );
  });

  return app;
}
