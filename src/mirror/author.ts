import type { GithubActor } from "#events";
import type { ImageEmbedder, PullRequestSnapshotFetcher } from "#github";
import { profileOrNone, resolveSlackUser } from "#identity";
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
  allowedBots: ReadonlySet<string>;
  threadComments: boolean;
  fetchSnapshot: PullRequestSnapshotFetcher;
  authorPoster:
    | {
        getUserToken: (slackUserId: string) => Promise<string | undefined>;
        onInvalidToken: (slackUserId: string) => Promise<void>;
      }
    | undefined;
}

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
  label: string | undefined;
}

async function authorFor(deps: MirrorDeps, actor: GithubActor): Promise<Author> {
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
  const profile = await profileOrNone(deps, slackUserId);
  const token = deps.authorPoster ? await deps.authorPoster.getUserToken(slackUserId) : undefined;
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
    if (!triedUser || !(error instanceof SlackApiError) || error.transient) throw error;
    const { login, slackUserId, profile } = triedUser;
    if (error.deadToken) await deps.authorPoster?.onInvalidToken(slackUserId);
    else {
      deps.logger.warn("Slack refused the author's token; posting as the bot", {
        slackUserId,
        slackError: error.code,
      });
    }
    const { images } = await enrich();
    await s.deliver(item.key, async () =>
      present({ kind: "linked", login, slackUserId, profile }, images),
    );
  }
}

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
