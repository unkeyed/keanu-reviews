import type { GithubActor } from "#events";
import type { ImageEmbedder } from "#github";
import { resolveSlackUser } from "#identity";
import { errMessage } from "#lib";
import type { PrDeps, PrSession } from "#pr";
import {
  BOT,
  type EffectKey,
  type MessageImage,
  type Outgoing,
  type Poster,
  SlackApiError,
  type SlackProfile,
  extractEmbeddedImages,
} from "#slack";

export interface MirrorDeps extends PrDeps {
  embedImages: ImageEmbedder;
  /** Bot logins (normalized) whose comments/reviews should be mirrored anyway. */
  allowedBots: ReadonlySet<string>;
  /**
   * When true, a reply within a GitHub review thread is posted as a Slack
   * threaded reply under the original comment's message. When false, every
   * comment posts top-level (flat). Thread-starting comments and PR conversation
   * comments are always top-level regardless.
   */
  threadComments: boolean;
  /**
   * Post-as-user, when Slack user OAuth is configured (undefined otherwise):
   * mirrored comments/reviews are authored with the linked user's own token
   * instead of the bot. `getUserToken` returns a decrypted token ONLY when the
   * user granted `chat:write`; `onInvalidToken` drops a token Slack reports dead.
   */
  authorPoster:
    | {
        getUserToken: (slackUserId: string) => Promise<string | undefined>;
        onInvalidToken: (slackUserId: string) => Promise<void>;
      }
    | undefined;
}

/**
 * Who wrote a mirrored GitHub item, as Slack sees them: a linked user whose
 * own token can post (`user`), a linked user the bot posts for (`linked`), or
 * nobody Slack knows (`unlinked`).
 */
export type Author =
  | {
      kind: "user";
      login: string;
      slackUserId: string;
      token: string;
      profile: SlackProfile | undefined;
    }
  | { kind: "linked"; login: string; slackUserId: string; profile: SlackProfile | undefined }
  | { kind: "unlinked"; login: string };

type UserAuthor = Extract<Author, { kind: "user" }>;

export interface Presentation {
  poster: Poster;
  /** "by <label>" under the message; undefined when the post already shows who wrote it. */
  label: string | undefined;
}

export async function authorFor(deps: MirrorDeps, actor: GithubActor): Promise<Author> {
  const { login } = actor;
  const slackUserId = await resolveSlackUser(deps, { githubId: actor.id, login });
  if (!slackUserId) {
    deps.logger.debug("message author not linked; posting as bot", {
      login,
      githubId: actor.id,
      authorPosterWired: Boolean(deps.authorPoster),
    });
    return { kind: "unlinked", login };
  }
  const profile = await deps.slack.profile(slackUserId);
  const token = deps.authorPoster ? await deps.authorPoster.getUserToken(slackUserId) : undefined;
  // hasUserToken=false means the token lookup missed (no chat:write scope,
  // team mismatch, or no token row for this Slack user), so the bot posts.
  deps.logger.debug("resolved message author", {
    login,
    githubId: actor.id,
    slackUserId,
    hasProfileName: Boolean(profile?.name),
    authorPosterWired: Boolean(deps.authorPoster),
    hasUserToken: Boolean(token),
  });
  return token
    ? { kind: "user", login, slackUserId, token, profile }
    : { kind: "linked", login, slackUserId, profile };
}

const userPoster = (author: UserAuthor): Poster => ({
  kind: "user",
  userId: author.slackUserId,
  token: author.token,
});

/**
 * A comment posts as its author: with their own token, else as the bot
 * wearing their Slack name and avatar. The label depends only on the profile
 * name, so a user-token post by someone without one still reads "by <login>".
 */
export function commentPresentation(author: Author): Presentation {
  const label = author.kind !== "unlinked" && author.profile?.name ? undefined : author.login;
  switch (author.kind) {
    case "user":
      return { poster: userPoster(author), label };
    case "linked":
      return {
        poster: {
          kind: "bot-as",
          username: author.profile?.name,
          iconUrl: author.profile?.iconUrl,
        },
        label,
      };
    case "unlinked":
      return { poster: BOT, label };
  }
}

/**
 * A review never wears its author's face: it posts with their own token, or as
 * the bot labelled with their plain Slack name, never a ping.
 */
export function reviewPresentation(author: Author): Presentation {
  switch (author.kind) {
    case "user":
      return { poster: userPoster(author), label: undefined };
    case "linked":
      return { poster: BOT, label: author.profile?.name ?? author.login };
    case "unlinked":
      return { poster: BOT, label: author.login };
  }
}

/** Images a comment embeds, mirrored through the attachment proxy. Bot comments show none. */
export async function commentImages(
  deps: { embedImages: ImageEmbedder },
  body: string,
  author: { isBot: boolean },
): Promise<MessageImage[]> {
  if (author.isBot) return [];
  return deps.embedImages(extractEmbeddedImages(body));
}

export interface AuthoredItem {
  key: EffectKey;
  action: "created" | "edited";
  author: GithubActor;
  body: string;
}

type Present = (author: Author, images: readonly MessageImage[]) => Outgoing | null;

/**
 * Post a mirrored item as its author, or apply an edit to the message already
 * posted for it. The author and images are resolved only when something will
 * be written. A dead user token is dropped and the item posts as the bot under
 * the same key and client_msg_id. An edit is best-effort: one Slack cannot
 * apply (authorship changed, message gone) leaves the original standing.
 */
export async function upsertAuthored(
  deps: MirrorDeps,
  s: PrSession,
  item: AuthoredItem,
  present: Present,
): Promise<void> {
  let enriched: Promise<{ author: Author; images: MessageImage[] }> | undefined;
  const enrich = () => {
    enriched ??= (async () => {
      const author = await authorFor(deps, item.author);
      return { author, images: await commentImages(deps, item.body, item.author) };
    })();
    return enriched;
  };

  const sentTs = item.action === "edited" ? await s.sentTs(item.key) : undefined;
  if (sentTs) {
    const { author, images } = await enrich();
    const out = present(author, images);
    if (!out) return;
    const channel = await s.channel();
    try {
      await channel.update(sentTs, out.message, author.kind === "user" ? author.token : undefined);
    } catch (error) {
      deps.logger.warn("failed to sync comment edit to Slack", {
        channel: channel.channel,
        ts: sentTs,
        err: errMessage(error),
      });
    }
    return;
  }

  let triedUser: UserAuthor | undefined;
  try {
    await s.deliver(item.key, async () => {
      const { author, images } = await enrich();
      const out = present(author, images);
      if (out && author.kind === "user") triedUser = author;
      return out;
    });
  } catch (error) {
    const dead = error instanceof SlackApiError && error.deadToken;
    if (!triedUser || !deps.authorPoster || !dead) throw error;
    const { login, slackUserId, profile } = triedUser;
    await deps.authorPoster.onInvalidToken(slackUserId);
    const { images } = await enrich();
    await s.deliver(item.key, async () =>
      present({ kind: "linked", login, slackUserId, profile }, images),
    );
  }
}

/**
 * Delete a mirrored item's Slack message, if it was posted, with the token
 * that would post as its author now. One not yet posted is tombstoned, so a
 * retried or late create never posts it. The Slack delete is best-effort: a
 * failure (already gone, authorship changed, transient) is logged, not thrown.
 */
export async function removeMirror(
  deps: MirrorDeps,
  s: PrSession,
  key: EffectKey,
  actor: GithubActor,
): Promise<void> {
  const ts = await s.tombstone(key);
  if (!ts) return;
  const slackUserId = await resolveSlackUser(deps, { githubId: actor.id, login: actor.login });
  const token =
    slackUserId && deps.authorPoster
      ? await deps.authorPoster.getUserToken(slackUserId)
      : undefined;
  const channel = await s.channel();
  try {
    await channel.remove(ts, token);
  } catch (error) {
    deps.logger.warn("failed to sync comment deletion to Slack", {
      channel: channel.channel,
      ts,
      err: errMessage(error),
    });
  }
}
