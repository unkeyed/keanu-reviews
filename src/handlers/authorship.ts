import type { MessageEffectInput } from "../db/repositories/messages.ts";
import { resolveSlackUser } from "../identity/resolve.ts";
import { type SlackMessage, isDeadUserTokenError } from "../slack/client.ts";
import { type DeliveredSlackMessage, deliverSlackMessage } from "../slack/deliver.ts";
import type { PrHandlerDeps } from "./pullRequest.ts";

/**
 * Everything needed to attribute a mirrored message to its GitHub author:
 * - `slackUserId` / `name` / `iconUrl`: the linked Slack identity, if any.
 * - `userToken`: the author's own OAuth token, present ONLY when they granted
 *   `chat:write` — the signal to post genuinely AS them rather than as the bot.
 */
export interface MessageAuthor {
  slackUserId?: string;
  name?: string;
  iconUrl?: string;
  userToken?: string;
}

/** Resolve the linked Slack identity + (when authorized) the post-as-user token. */
export async function resolveMessageAuthor(
  deps: PrHandlerDeps,
  user: { id: number; login: string },
): Promise<MessageAuthor> {
  const slackUserId = await resolveSlackUser(deps, { githubId: user.id, login: user.login });
  if (!slackUserId) {
    // No identity-map row for this GitHub id → we can't post as them (bot post).
    deps.logger.debug("message author not linked; posting as bot", {
      login: user.login,
      githubId: user.id,
      authorPosterWired: Boolean(deps.authorPoster),
    });
    return {};
  }
  const profile = await deps.slack.lookupUserProfile(slackUserId);
  const userToken = deps.authorPoster
    ? await deps.authorPoster.getUserToken(slackUserId)
    : undefined;
  // hasUserToken=false here means the token lookup missed (no chat:write scope,
  // team mismatch, or no token row for this Slack user) → falls back to bot.
  deps.logger.debug("resolved message author", {
    login: user.login,
    githubId: user.id,
    slackUserId,
    hasProfileName: Boolean(profile?.name),
    authorPosterWired: Boolean(deps.authorPoster),
    hasUserToken: Boolean(userToken),
  });
  return { slackUserId, name: profile?.name, iconUrl: profile?.iconUrl, userToken };
}

/**
 * Deliver a mirrored message, authored as the real user when we hold a usable
 * token. `render(mode)` builds the message body: "user" mode omits the redundant
 * author label (the post IS from them); "bot" mode is today's behavior (name +
 * avatar spoof for comments, or a plain name label for reviews). If the user's
 * token turns out dead at post time, it's dropped and the "bot" render is
 * delivered instead — reusing the same message-effect claim (idempotent retry).
 */
export async function deliverAuthoredMessage(
  deps: PrHandlerDeps,
  effect: MessageEffectInput,
  author: MessageAuthor,
  render: (mode: "user" | "bot") => SlackMessage,
): Promise<DeliveredSlackMessage> {
  if (author.userToken && author.slackUserId && deps.authorPoster) {
    try {
      return await deliverSlackMessage(deps.db, deps.slack, effect, {
        ...render("user"),
        authorUserToken: author.userToken,
        authorUserId: author.slackUserId,
      });
    } catch (error) {
      if (!isDeadUserTokenError(error)) throw error;
      // The token was revoked/expired: drop it so we don't retry it, then fall
      // through to a bot-authored post under the released effect claim.
      await deps.authorPoster.onInvalidToken(author.slackUserId);
    }
  }
  return deliverSlackMessage(deps.db, deps.slack, effect, render("bot"));
}
