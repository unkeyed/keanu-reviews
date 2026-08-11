import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type LinkDeps, linkIdentity } from "../identity/link.ts";
import type { Logger } from "../logger.ts";
import { verifySlackSignature } from "../slack/verify.ts";

export interface SlackCommandDeps extends LinkDeps {
  logger: Logger;
  signingSecret: string;
}

/**
 * Slack slash-command endpoint (U9). `/link-github <login>` links the invoking
 * Slack user to a GitHub account. Verifies the Slack signature before acting —
 * this is a public inbound endpoint. Reads only; never writes to GitHub.
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
    const ok = verifySlackSignature({
      signingSecret: deps.signingSecret,
      timestamp: c.req.header("x-slack-request-timestamp"),
      signature: c.req.header("x-slack-signature"),
      rawBody,
    });
    if (!ok) {
      deps.logger.warn("slack command signature rejected");
      return c.json({ error: "invalid_signature" }, 401);
    }

    const params = new URLSearchParams(rawBody);
    const slackUserId = params.get("user_id");
    const githubLogin = params.get("text")?.trim();
    if (!slackUserId) return c.json({ error: "missing_user" }, 400);
    if (!githubLogin) {
      return c.json({
        response_type: "ephemeral",
        text: "Usage: `/link-github <github-username>`",
      });
    }

    const result = await linkIdentity(deps, { slackUserId, githubLogin });
    return c.json({ response_type: "ephemeral", text: result.message });
  });

  return app;
}
