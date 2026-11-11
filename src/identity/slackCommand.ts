import type { Buffer } from "node:buffer";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Db } from "#db";
import { createGithubAuthorizeUrl, createOAuthState } from "#github";
import type { Logger } from "#lib";
import { createSlackAuthorizeUrl, verifySlackSignature } from "#slack";
import { confirmGithubLink } from "./store.ts";

export interface SlackCommandDeps {
  db: Db;
  logger: Logger;
  signingSecret: string;
  slackTeamId: string;
  oauthStateSecret: string;
  githubOauthClientId: string;
  githubOauthCallbackUrl: string;
  slackOauthClientId?: string;
  slackOauthCallbackUrl?: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

export function createSlackCommandRoute(deps: SlackCommandDeps): Hono {
  const app = new Hono();

  app.use("/slack/commands", async (c, next) => {
    c.header("cache-control", "no-store");
    c.header("pragma", "no-cache");
    await next();
  });

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
    const oauthState = () =>
      createOAuthState({
        secret: deps.oauthStateSecret,
        slackUserId,
        slackTeamId: deps.slackTeamId,
        now: deps.now,
        randomBytes: deps.randomBytes,
      });

    if ((params.get("command") ?? "").trim() === "/link-slack") {
      if (!deps.slackOauthClientId || !deps.slackOauthCallbackUrl) {
        return c.json({
          response_type: "ephemeral",
          text: "Quiet archiving isn't configured on this workspace.",
        });
      }
      const slackAuthorizeUrl = createSlackAuthorizeUrl({
        clientId: deps.slackOauthClientId,
        callbackUrl: deps.slackOauthCallbackUrl,
        state: oauthState(),
      });
      return c.json({
        response_type: "ephemeral",
        text: `Post your PR comments as yourself and enable quiet archiving: <${slackAuthorizeUrl}|Authorize with Slack>`,
      });
    }

    const commandText = (params.get("text") ?? "").trim();
    if (commandText) {
      const match = /^confirm\s+([A-Za-z0-9_-]{32})$/.exec(commandText);
      if (!match?.[1]) {
        return c.json({
          response_type: "ephemeral",
          text: "Usage: `/link-github` or `/link-github confirm <code>`.",
        });
      }

      const result = await confirmGithubLink(deps.db, {
        code: match[1],
        slackTeamId: deps.slackTeamId,
        slackUserId,
        now: new Date((deps.now ?? Date.now)()),
      });
      if (result.outcome === "linked" || result.outcome === "refreshed") {
        return c.json({
          response_type: "ephemeral",
          text: `GitHub account \`${result.identity.githubLogin}\` is now linked to your Slack user.`,
        });
      }
      if (result.outcome === "conflict") {
        return c.json({
          response_type: "ephemeral",
          text: "That GitHub account is already linked to another Slack user. Start again or contact an administrator.",
        });
      }
      return c.json({
        response_type: "ephemeral",
        text: "That confirmation code is invalid, expired, already used, or belongs to another Slack user.",
      });
    }

    const authorizeUrl = createGithubAuthorizeUrl({
      clientId: deps.githubOauthClientId,
      callbackUrl: deps.githubOauthCallbackUrl,
      state: oauthState(),
    });
    return c.json({
      response_type: "ephemeral",
      text: `Verify ownership to link your account: <${authorizeUrl}|Continue with GitHub>`,
    });
  });

  return app;
}
