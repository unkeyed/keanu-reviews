import type { ImageEmbedder } from "#github";
import { resolveSlackUser } from "#identity";
import { type PrId, errMessage } from "#lib";
import { findByRepoNumber } from "#pr";
import {
  type Delivered,
  type EffectKey,
  type Message,
  type MessageImage,
  type Outgoing,
  SlackApiError,
  channelSink,
  createLedger,
  extractEmbeddedImages,
  render,
} from "#slack";
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
  const profile = await deps.slack.profile(slackUserId);
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

const postsAsUser = (deps: PrHandlerDeps, author: MessageAuthor) =>
  Boolean(author.userToken && author.slackUserId && deps.authorPoster);

/**
 * Deliver a mirrored message, authored as the real user when we hold a usable
 * token. `build` runs only if the message was not already sent; it resolves
 * the author and returns `outgoing(mode)`. "user" mode omits the redundant
 * author label (the post IS from them); "bot" mode is the bot post, spoofing
 * the author's name and avatar for comments. If the user's token turns out dead
 * at post time, it's dropped and the "bot" message is delivered instead under
 * the same key and client_msg_id.
 */
export async function deliverAuthored(
  deps: PrHandlerDeps,
  key: EffectKey,
  channelId: string,
  build: () => Promise<{
    author: MessageAuthor;
    outgoing: (mode: "user" | "bot") => Outgoing | null;
  }>,
): Promise<Delivered> {
  const ledger = createLedger(deps.db);
  const sink = channelSink(deps.slack, channelId);
  let built: Awaited<ReturnType<typeof build>> | undefined;
  const once = async () => {
    built ??= await build();
    return built;
  };
  let triedUser: string | undefined;
  try {
    return await ledger.deliver(key, sink, async () => {
      const { author, outgoing } = await once();
      const { slackUserId: userId, userToken: token } = author;
      if (!deps.authorPoster || !userId || !token) return outgoing("bot");
      const out = outgoing("user");
      if (!out) return null;
      triedUser = userId;
      return { ...out, poster: { kind: "user", userId, token } };
    });
  } catch (error) {
    if (!triedUser || !deps.authorPoster) throw error;
    if (!(error instanceof SlackApiError && error.deadToken)) throw error;
    // The token was revoked/expired: drop it so we don't retry it, then post
    // as the bot under the released claim.
    await deps.authorPoster.onInvalidToken(triedUser);
    return ledger.deliver(key, sink, async () => (await once()).outgoing("bot"));
  }
}

/**
 * Sync a GitHub comment edit onto its already-mirrored Slack message via
 * chat.update, with the token that posted it (Slack requires the editing token
 * to match the author).
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
  message: (mode: "user" | "bot") => Message,
): Promise<void> {
  const asUser = postsAsUser(deps, author);
  try {
    await deps.slack.update(
      channel,
      slackTs,
      render(message(asUser ? "user" : "bot")),
      asUser ? author.userToken : undefined,
    );
  } catch (error) {
    deps.logger.warn("failed to sync comment edit to Slack", {
      channel,
      ts: slackTs,
      err: errMessage(error),
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
    key: (prId: PrId) => EffectKey;
    user: { id: number; login: string };
  },
): Promise<void> {
  const row = await findByRepoNumber(deps.db, opts.repoFullName, opts.number);
  if (!row?.channelId) return; // PR never tracked / no channel → nothing mirrored
  const slackTs = await createLedger(deps.db).sentTs(opts.key(row.id));
  if (!slackTs) return; // never mirrored (or still in flight)

  const author = await resolveMessageAuthor(deps, opts.user);
  try {
    await deps.slack.remove(
      row.channelId,
      slackTs,
      postsAsUser(deps, author) ? author.userToken : undefined,
    );
  } catch (error) {
    deps.logger.warn("failed to sync comment deletion to Slack", {
      channel: row.channelId,
      ts: slackTs,
      err: errMessage(error),
    });
  }
}

/** Images a comment embeds, mirrored when a mirror is wired. Bot comments show none. */
export async function commentImages(
  deps: { embedImages?: ImageEmbedder },
  body: string,
  author: { isBot: boolean },
): Promise<MessageImage[]> {
  if (author.isBot) return [];
  return deps.embedImages ? deps.embedImages(extractEmbeddedImages(body)) : [];
}
