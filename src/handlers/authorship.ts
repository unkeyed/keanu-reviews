import { type MessageEffectInput, findMessageEffect } from "../db/repositories/messages.ts";
import { findByRepoNumber } from "../db/repositories/pullRequests.ts";
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

/**
 * Sync a GitHub comment edit onto its already-mirrored Slack message via
 * chat.update. Re-resolves authorship the same way the original post did, so a
 * user-authored message is edited with the user's token and a bot-authored one
 * with the bot token (Slack requires the editing token to match the author).
 *
 * Best-effort: an edit that can't be applied — authorship changed since the
 * original post, the message was deleted, or a transient Slack failure — must
 * not poison the job; the original mirrored message simply stands.
 */
export async function updateAuthoredMessage(
  deps: PrHandlerDeps,
  slackTs: string,
  channel: string,
  author: MessageAuthor,
  render: (mode: "user" | "bot") => SlackMessage,
): Promise<void> {
  const asUser = Boolean(author.userToken && author.slackUserId && deps.authorPoster);
  const content = render(asUser ? "user" : "bot");
  try {
    await deps.slack.updateMessage({
      channel,
      ts: slackTs,
      text: content.text,
      blocks: content.blocks,
      authorUserToken: asUser ? author.userToken : undefined,
    });
  } catch (error) {
    deps.logger.warn("failed to sync comment edit to Slack", {
      channel,
      ts: slackTs,
      err: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Sync a GitHub comment deletion by removing its mirrored Slack message. Resolves
 * the PR without creating a channel (a deletion must never spin one up) and only
 * acts when the message was actually mirrored. Deletes with the same token that
 * authored the message. Best-effort: a failure (already gone, authorship changed,
 * transient) is logged, not thrown.
 */
export async function deleteMirroredComment(
  deps: PrHandlerDeps,
  opts: {
    repoFullName: string;
    number: number;
    kind: string;
    commentId: number;
    user: { id: number; login: string };
  },
): Promise<void> {
  const row = await findByRepoNumber(deps.db, opts.repoFullName, opts.number);
  if (!row?.channelId) return; // PR never tracked / no channel → nothing mirrored
  const existing = await findMessageEffect(deps.db, {
    prId: row.id,
    kind: opts.kind,
    githubEventRef: String(opts.commentId),
  });
  if (existing?.status !== "sent" || !existing.slackTs) return; // never mirrored (or still in flight)

  const author = await resolveMessageAuthor(deps, opts.user);
  const asUser = Boolean(author.userToken && author.slackUserId && deps.authorPoster);
  try {
    await deps.slack.deleteMessage(
      row.channelId,
      existing.slackTs,
      asUser ? author.userToken : undefined,
    );
  } catch (error) {
    deps.logger.warn("failed to sync comment deletion to Slack", {
      channel: row.channelId,
      ts: existing.slackTs,
      err: error instanceof Error ? error.message : String(error),
    });
  }
}
