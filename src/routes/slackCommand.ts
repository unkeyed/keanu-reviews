import type { Buffer } from "node:buffer";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createGithubAuthorizeUrl, createOAuthState } from "../github/oauth.ts";
import type { Logger } from "../logger.ts";
import { verifySlackSignature } from "../slack/verify.ts";

export interface SlackCommandDeps {
  logger: Logger;
  signingSecret: string;
  slackTeamId: string;
  oauthStateSecret: string;
  githubOauthClientId: string;
  githubOauthCallbackUrl: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

/**
 * Start proof-of-ownership linking for `/link-github`. After local signature
 * and workspace checks this returns immediately; GitHub and DB I/O happen only
 * in the browser callback, outside Slack's acknowledgement window.
 */
export function createSlackCommandRoute(deps: SlackCommandDeps): Hono {
  const app = new Hono();

  app.use(
    "/slack/commands",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
  );

  app.post("/slack/commands", async (c) => {
    const rawBody = await c.req.text();
    if (
      !verifySlackSignature({
        signingSecret: deps.signingSecret,
        timestamp: c.req.header("x-slack-request-timestamp"),
        signature: c.req.header("x-slack-signature"),
        rawBody,
        now: deps.now,
      })
    ) {
      deps.logger.warn("slack command signature rejected");
      return c.json({ error: "invalid_signature" }, 401);
    }

    const params = new URLSearchParams(rawBody);
    if (params.get("team_id") !== deps.slackTeamId) {
      deps.logger.warn("slack command workspace rejected");
      return c.json({ error: "workspace_not_allowed" }, 403);
    }
    const slackUserId = params.get("user_id");
    if (!slackUserId) return c.json({ error: "missing_user" }, 400);

    const state = createOAuthState({
      secret: deps.oauthStateSecret,
      slackUserId,
      slackTeamId: deps.slackTeamId,
      now: deps.now,
      randomBytes: deps.randomBytes,
    });
    const authorizeUrl = createGithubAuthorizeUrl({
      clientId: deps.githubOauthClientId,
      callbackUrl: deps.githubOauthCallbackUrl,
      state,
    });
    return c.json({
      response_type: "ephemeral",
      text: `Verify ownership to link your account: <${authorizeUrl}|Continue with GitHub>`,
    });
  });

  return app;
}
