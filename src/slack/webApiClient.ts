import { ErrorCode, WebClient, type WebClientOptions } from "@slack/web-api";
import { SLACK_SECTION_TEXT_LIMIT, sanitizeLinkLabel } from "./blocks.ts";
import {
  DEAD_TOKEN_ERRORS,
  type LeaveChannelOutcome,
  type MessageImage,
  type SlackBlock,
  type SlackClient,
  type SlackMessage,
  type SlackMessageUpdate,
  type UninvitableUser,
  isSlackChannelAlreadyInState,
} from "./client.ts";
import { Pacer, RateLimitedError, type SleepFn, withRetry } from "./rateLimiter.ts";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_RETRIES = 1;
const MAX_RATE_LIMIT_DELAY_MS = 5_000;

interface SlackUserLookupApi {
  lookupByEmail(input: { email: string }): Promise<{ user?: { id?: string } }>;
  info(input: { user: string }): Promise<{
    user?: {
      name?: string;
      real_name?: string;
      profile?: {
        display_name?: string;
        real_name?: string;
        image_72?: string;
        image_48?: string;
      };
    };
  }>;
}

/**
 * The reviewer's Slack display name (what Slack shows in the client): their
 * chosen display name if set, otherwise their real name. Returns undefined for
 * an unknown user so callers can fall back to the GitHub login. Requires the
 * `users:read` scope (already implied by `users:read.email`).
 */
export async function lookupSlackUserName(
  users: Pick<SlackUserLookupApi, "info">,
  userId: string,
): Promise<string | undefined> {
  try {
    const result = await users.info({ user: userId });
    const profile = result.user?.profile;
    const name =
      profile?.display_name?.trim() ||
      profile?.real_name?.trim() ||
      result.user?.real_name?.trim() ||
      result.user?.name?.trim();
    return name || undefined;
  } catch (error) {
    if (slackErrorCode(error) === "user_not_found") return undefined;
    throw error;
  }
}

function slackErrorCode(error: unknown): string | undefined {
  return (error as { data?: { error?: string } })?.data?.error;
}

const UNINVITABLE_USER_ERRORS: ReadonlySet<string> = new Set([
  "cant_invite",
  "cant_invite_self",
  "user_not_found",
  "user_is_restricted",
  "user_is_ultra_restricted",
  "ura_max_channels",
  "org_user_not_in_team",
  "invitee_cant_see_channel",
  "no_external_invite_permission",
]);

/** Per-user failures in a `conversations.invite` response, minus users already present. */
function refusedInvites(response: unknown): UninvitableUser[] {
  const errors = (response as { errors?: unknown })?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((entry) => {
    const { user, error } = entry as { user?: unknown; error?: unknown };
    if (typeof error !== "string" || error === "already_in_channel") return [];
    return [{ userId: typeof user === "string" ? user : undefined, error }];
  });
}

/**
 * The user's display name + avatar for authoring a mirrored comment as them.
 * Returns undefined for an unknown user so callers fall back to bot authorship.
 */
export async function lookupSlackUserProfile(
  users: Pick<SlackUserLookupApi, "info">,
  userId: string,
): Promise<{ name?: string; iconUrl?: string } | undefined> {
  try {
    const result = await users.info({ user: userId });
    const profile = result.user?.profile;
    const name =
      profile?.display_name?.trim() ||
      profile?.real_name?.trim() ||
      result.user?.real_name?.trim() ||
      result.user?.name?.trim() ||
      undefined;
    const iconUrl = profile?.image_72?.trim() || profile?.image_48?.trim() || undefined;
    if (!name && !iconUrl) return undefined;
    return { name, iconUrl };
  } catch (error) {
    if (slackErrorCode(error) === "user_not_found") return undefined;
    throw error;
  }
}

interface SlackWebApi {
  conversations: {
    create(input: { name: string }): Promise<{ channel?: { id?: string } }>;
    join(input: { channel: string }): Promise<unknown>;
    rename(input: { channel: string; name: string }): Promise<unknown>;
    setTopic(input: { channel: string; topic: string }): Promise<unknown>;
    archive(input: { channel: string }): Promise<unknown>;
    unarchive(input: { channel: string }): Promise<unknown>;
    info(input: { channel: string }): Promise<{ channel?: { is_archived?: boolean } }>;
    invite(input: { channel: string; users: string; force?: boolean }): Promise<unknown>;
    members(input: { channel: string; cursor?: string; limit: number }): Promise<unknown>;
    leave(input: { channel: string }): Promise<unknown>;
    list(input: {
      cursor?: string;
      exclude_archived: boolean;
      limit: number;
      types: string;
    }): Promise<unknown>;
  };
  users: SlackUserLookupApi;
  apiCall(method: string, options?: Record<string, unknown>): Promise<unknown>;
}

export interface WebApiSlackClientOptions {
  /** Injected by offline adapter tests; production creates the official WebClient. */
  web?: SlackWebApi;
  webFactory?: (token: string, options: WebClientOptions) => SlackWebApi;
  /** Builds a Slack client bound to a *user* token (for silent leave). */
  userWebFactory?: (token: string) => SlackWebApi;
  sleep?: SleepFn;
  now?: () => number;
  onImageFallback?: (info: {
    channel: string;
    method: "chat.postMessage" | "chat.update";
    embeds: number;
  }) => void;
}

const SLACK_IMAGE_URL_LIMIT = 3_000;
const LINK_LABEL_LIMIT = 80;
const MORE_SUFFIX_RESERVE = " · +99 more".length;

const escapeSlackLinkUrl = (url: string) =>
  url.replace(/[|<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

function clipLabel(alt: string): string {
  const chars = Array.from(alt);
  return chars.length > LINK_LABEL_LIMIT
    ? `${chars.slice(0, LINK_LABEL_LIMIT - 1).join("")}…`
    : alt;
}

// Slack rejects the whole message when one text object passes its limit, so a
// link that would push the row over it is counted in "+N more" instead.
function linkRow(links: readonly MessageImage[]): string {
  let text = links.length > 1 ? "Images: " : "Image: ";
  let shown = 0;
  for (const img of links) {
    const link = `<${escapeSlackLinkUrl(img.sourceUrl)}|${sanitizeLinkLabel(clipLabel(img.alt))}>`;
    const next = shown === 0 ? link : ` · ${link}`;
    if (text.length + next.length + MORE_SUFFIX_RESERVE > SLACK_SECTION_TEXT_LIMIT) continue;
    text += next;
    shown++;
  }
  const more = links.length - shown;
  return more === 0 ? text : `${text}${shown > 0 ? " · " : ""}+${more} more`;
}

function imageBlocks(images: readonly MessageImage[], mode: "embed" | "links"): SlackBlock[] {
  const embeddable = (i: MessageImage): i is Extract<MessageImage, { kind: "embed" }> =>
    mode === "embed" && i.kind === "embed" && i.imageUrl.length <= SLACK_IMAGE_URL_LIMIT;
  const embeds = images.filter(embeddable);
  const links = images.filter((i) => !embeddable(i));
  const blocks: SlackBlock[] = embeds.map((img) => ({
    type: "image",
    image_url: img.imageUrl,
    alt_text: Array.from(img.alt).slice(0, 2000).join(""),
  }));
  if (links.length > 0) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: linkRow(links) }] });
  }
  return blocks;
}

// Slack fetches every image_url while accepting a message and rejects the whole
// message with `invalid_blocks` if one fails. The rejected attempt posted
// nothing, so sending again with links (same client_msg_id) is safe.
async function sendWithImageFallback<T>(
  msg: { channel: string; blocks?: SlackBlock[]; images?: readonly MessageImage[] },
  method: "chat.postMessage" | "chat.update",
  send: (blocks: SlackBlock[] | undefined) => Promise<T>,
  onFallback: WebApiSlackClientOptions["onImageFallback"],
): Promise<T> {
  const images = msg.images ?? [];
  const embeds = images.filter((i) => i.kind === "embed").length;
  const render = (mode: "embed" | "links") =>
    images.length > 0 ? [...(msg.blocks ?? []), ...imageBlocks(images, mode)] : msg.blocks;
  try {
    return await send(render("embed"));
  } catch (error) {
    if (embeds === 0 || slackErrorCode(error) !== "invalid_blocks") throw error;
    onFallback?.({ channel: msg.channel, method, embeds });
    return send(render("links"));
  }
}

function requireNonEmptyString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Slack ${description} response did not include a value`);
  }
  return value;
}

/** Slack uses `users_not_found` for a legitimate lookup miss; all other errors are operational. */
export async function lookupSlackUserByEmail(
  users: Pick<SlackUserLookupApi, "lookupByEmail">,
  email: string,
): Promise<string | undefined> {
  try {
    const result = await users.lookupByEmail({ email });
    return requireNonEmptyString(result.user?.id, "users.lookupByEmail user ID");
  } catch (error) {
    if ((error as { data?: { error?: string } })?.data?.error === "users_not_found") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Real Slack client (KTD9). Wraps @slack/web-api, retries on 429 honoring
 * Retry-After, and paces posts to ~1/sec per channel. Channel creation is
 * serialized under one key so a PR flood queues within the Tier-2 limit.
 */
export function createWebApiSlackClient(
  token: string,
  options: WebApiSlackClientOptions = {},
): SlackClient {
  const webFactory = options.webFactory ?? ((apiToken, config) => new WebClient(apiToken, config));
  const web: SlackWebApi =
    options.web ??
    webFactory(token, {
      // Durable jobs own retries. SDK defaults can otherwise retry for roughly
      // 30 minutes, far beyond the worker and message-effect leases.
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: REQUEST_TIMEOUT_MS,
    });
  const userWebFactory =
    options.userWebFactory ??
    ((userToken: string) =>
      webFactory(userToken, {
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        timeout: REQUEST_TIMEOUT_MS,
      }));
  const postPacer = new Pacer(1000, options.sleep, options.now);
  const createPacer = new Pacer(3000, options.sleep, options.now); // ~20/min Tier-2 headroom

  const normalizeSlackError = (e: unknown): unknown => {
    const err = e as {
      code?: string;
      retryAfter?: number;
      data?: { error?: string; needed?: string; provided?: string };
    };
    if (err?.code === ErrorCode.RateLimitedError) {
      return new RateLimitedError(err.retryAfter ?? 1);
    }
    // Slack platform errors carry actionable detail (which scope is missing,
    // which channel, etc.) on `data`. The default `.message` drops it, so lift
    // `needed`/`provided` into the message the worker logs.
    const slackCode = err?.data?.error;
    if (slackCode) {
      const parts = [`Slack API error: ${slackCode}`];
      if (err.data?.needed) parts.push(`needed scope: ${err.data.needed}`);
      if (err.data?.provided) parts.push(`provided scopes: ${err.data.provided}`);
      const enriched = new Error(parts.join(" — "), { cause: e });
      Object.assign(enriched, {
        slackError: slackCode,
        neededScope: err.data?.needed,
        providedScopes: err.data?.provided,
      });
      return enriched;
    }
    return e;
  };
  const call = <T>(fn: () => Promise<T>): Promise<T> =>
    withRetry(
      () =>
        fn().catch((e) => {
          throw normalizeSlackError(e);
        }),
      {
        maxRetries: MAX_RATE_LIMIT_RETRIES,
        maxRetryDelayMs: MAX_RATE_LIMIT_DELAY_MS,
        sleep: options.sleep,
      },
    );

  // Make a channel writable before an op that must succeed. Two recoverable
  // states, each fixed once then retried:
  //   • `not_in_channel` — the bot was removed or recovered a channel by name;
  //     rejoin it (needs `channels:join`).
  //   • `is_archived` — the channel was archived (a prior terminal event, an
  //     out-of-order merge, or a manual archive). Any write/rename to it fails,
  //     which otherwise poisons every future job for that PR. Unarchive and retry
  //     (needs `channels:manage`). This can leave a merged PR's channel open if a
  //     late write (CI/comment/review) lands after archive; the daily reconcile's
  //     re-archive sweep closes such drift back up.
  // Bounded to two recoveries so a channel that is both archived AND left can be
  // healed in one call without risking an infinite loop.
  const withWritableChannel = async <T>(channel: string, op: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await op();
      } catch (error) {
        const code = slackErrorCode(error);
        if (attempt < 2 && code === "not_in_channel") {
          await web.conversations.join({ channel });
          continue;
        }
        if (attempt < 2 && code === "is_archived") {
          await web.conversations.unarchive({ channel });
          continue;
        }
        throw error;
      }
    }
  };

  // Post through the bot, optionally spoofing the author's name/avatar. The
  // `username`/`icon_url` overrides need `chat:write.customize`; if that scope is
  // missing, fall back to a plain bot post rather than poisoning the job.
  const postAsBot = async (msg: SlackMessage): Promise<unknown> => {
    const customize = Boolean(msg.username || msg.iconUrl);
    const post = (withAuthor: boolean) =>
      withWritableChannel(msg.channel, () =>
        web.apiCall("chat.postMessage", {
          channel: msg.channel,
          text: msg.text,
          blocks: msg.blocks,
          thread_ts: msg.threadTs,
          client_msg_id: msg.clientMsgId,
          username: withAuthor ? msg.username : undefined,
          icon_url: withAuthor ? msg.iconUrl : undefined,
          // Never unfurl the GitHub links we mirror — the block already links out,
          // and a preview card is noise (and would be re-added by the GitHub app).
          unfurl_links: false,
          unfurl_media: false,
        }),
      );
    try {
      return ((await post(customize)) as { ts?: unknown }).ts;
    } catch (error) {
      if (customize && slackErrorCode(error) === "missing_scope") {
        return ((await post(false)) as { ts?: unknown }).ts;
      }
      throw error;
    }
  };

  // Post genuinely AS the user via their own token. Posting as a user requires
  // channel membership, so on `not_in_channel` the bot invites them once and
  // retries. A dead token (or any other error) propagates; the caller drops the
  // token and re-posts as the bot.
  const postAsUser = async (msg: SlackMessage): Promise<unknown> => {
    const userWeb = userWebFactory(msg.authorUserToken as string);
    const post = () =>
      userWeb.apiCall("chat.postMessage", {
        channel: msg.channel,
        text: msg.text,
        blocks: msg.blocks,
        thread_ts: msg.threadTs,
        client_msg_id: msg.clientMsgId,
        // User-token posts default unfurl_links to true — the reason the GitHub
        // link preview started appearing. Suppress it to match the bot posts.
        unfurl_links: false,
        unfurl_media: false,
      });
    try {
      return ((await post()) as { ts?: unknown }).ts;
    } catch (error) {
      if (msg.authorUserId && slackErrorCode(error) === "not_in_channel") {
        try {
          await web.conversations.invite({ channel: msg.channel, users: msg.authorUserId });
        } catch (inviteError) {
          if (slackErrorCode(inviteError) !== "already_in_channel") throw inviteError;
        }
        return ((await post()) as { ts?: unknown }).ts;
      }
      throw error;
    }
  };

  return {
    createChannel: (name) =>
      createPacer.run("create", () =>
        call(async () => {
          const res = await web.conversations.create({ name });
          return {
            channelId: requireNonEmptyString(res.channel?.id, "conversations.create channel ID"),
          };
        }),
      ),
    findChannelByName: async (name) => {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        const result = (await call(() =>
          web.conversations.list({
            cursor,
            exclude_archived: false,
            limit: 999,
            // This service creates public channels, so recovery needs only the
            // channels:read scope and never enumerates private conversations.
            types: "public_channel",
          }),
        )) as {
          channels?: unknown;
          response_metadata?: { next_cursor?: unknown };
        };
        if (!Array.isArray(result.channels)) {
          throw new Error("Slack conversations.list response did not include a channels array");
        }
        for (const channel of result.channels) {
          const candidate = channel as { id?: unknown; name?: unknown };
          if (candidate.name === name) {
            return requireNonEmptyString(candidate.id, "conversations.list channel ID");
          }
        }
        const nextCursor = result.response_metadata?.next_cursor;
        if (nextCursor !== undefined && typeof nextCursor !== "string") {
          throw new Error("Slack conversations.list response included an invalid cursor");
        }
        cursor = nextCursor?.trim() || undefined;
        if (cursor && seenCursors.has(cursor)) {
          throw new Error("Slack conversations.list returned a repeated cursor");
        }
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      return undefined;
    },
    renameChannel: (channelId, name) =>
      call(() =>
        withWritableChannel(channelId, async () => {
          await web.conversations.rename({ channel: channelId, name });
        }),
      ),
    setTopic: (channelId, topic) =>
      call(() =>
        withWritableChannel(channelId, async () => {
          await web.conversations.setTopic({ channel: channelId, topic });
        }),
      ),
    archiveChannel: (channelId) =>
      call(async () => {
        try {
          await withWritableChannel(channelId, () =>
            web.conversations.archive({ channel: channelId }),
          );
        } catch (error) {
          if (!isSlackChannelAlreadyInState(error, "already_archived")) throw error;
        }
      }),
    unarchiveChannel: (channelId) =>
      call(async () => {
        try {
          await withWritableChannel(channelId, () =>
            web.conversations.unarchive({ channel: channelId }),
          );
        } catch (error) {
          if (!isSlackChannelAlreadyInState(error, "not_archived")) throw error;
        }
      }),
    isChannelArchived: (channelId) =>
      call(async () => {
        try {
          const res = (await web.conversations.info({ channel: channelId })) as {
            channel?: { is_archived?: unknown };
          };
          const archived = res.channel?.is_archived;
          return typeof archived === "boolean" ? archived : undefined;
        } catch (error) {
          // A missing/invalid channel can't be read — report "unknown", not a crash.
          if (slackErrorCode(error) === "channel_not_found") return undefined;
          throw error;
        }
      }),
    inviteUsers: (channelId, userIds) =>
      call(async () => {
        if (userIds.length === 0) return [];
        try {
          // `force` keeps inviting the valid users when another one in the list
          // is already present or cannot be invited.
          const result = await withWritableChannel(channelId, () =>
            web.conversations.invite({ channel: channelId, users: userIds.join(","), force: true }),
          );
          return refusedInvites(result);
        } catch (error) {
          const code = slackErrorCode(error);
          const data = (error as { data?: unknown }).data;
          // An ambiguous earlier invite may have succeeded. Treat Slack's
          // already-present response as the idempotent success it represents.
          if (code === "already_in_channel") return refusedInvites(data);
          if (!code || !UNINVITABLE_USER_ERRORS.has(code)) throw error;
          const refused = refusedInvites(data);
          return refused.length > 0 ? refused : userIds.map((userId) => ({ userId, error: code }));
        }
      }),
    listChannelMembers: async (channelId) => {
      const members: string[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        const result = (await call(() =>
          withWritableChannel(channelId, () =>
            web.conversations.members({ channel: channelId, cursor, limit: 200 }),
          ),
        )) as { members?: unknown; response_metadata?: { next_cursor?: unknown } };
        if (
          !Array.isArray(result.members) ||
          !result.members.every((member) => typeof member === "string")
        ) {
          throw new Error("Slack conversations.members response did not include a members array");
        }
        members.push(...(result.members as string[]));
        const nextCursor = result.response_metadata?.next_cursor;
        if (nextCursor !== undefined && typeof nextCursor !== "string") {
          throw new Error("Slack conversations.members response included an invalid cursor");
        }
        cursor = nextCursor?.trim() || undefined;
        if (cursor && seenCursors.has(cursor)) {
          throw new Error("Slack conversations.members returned a repeated cursor");
        }
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      return members;
    },
    leaveChannelAsUser: (channelId, userToken): Promise<LeaveChannelOutcome> =>
      call(async () => {
        const userWeb = userWebFactory(userToken);
        try {
          await userWeb.conversations.leave({ channel: channelId });
          return "left";
        } catch (error) {
          const code = slackErrorCode(error);
          // Already gone is an idempotent success; a dead token is reported so
          // the caller can drop it. Anything else is transient — let it retry.
          if (code === "not_in_channel") return "already_out";
          if (code && DEAD_TOKEN_ERRORS.has(code)) return "invalid_token";
          throw error;
        }
      }),
    postMessage: (msg: SlackMessage) =>
      postPacer.run(msg.channel, () =>
        call(async () => {
          // Author as the real user via their token when provided, else post as
          // the bot (optionally spoofing name/avatar). See postAsUser/postAsBot.
          const ts = await sendWithImageFallback(
            msg,
            "chat.postMessage",
            (blocks) =>
              msg.authorUserToken ? postAsUser({ ...msg, blocks }) : postAsBot({ ...msg, blocks }),
            options.onImageFallback,
          );
          return { ts: requireNonEmptyString(ts, "chat.postMessage timestamp") };
        }),
      ),
    updateMessage: (update: SlackMessageUpdate) =>
      postPacer.run(update.channel, () =>
        call(async () => {
          await sendWithImageFallback(
            update,
            "chat.update",
            (blocks) => {
              const args = { channel: update.channel, ts: update.ts, text: update.text, blocks };
              // A message posted with a user token can only be edited with that same
              // token; a bot-posted one is edited with the bot token (and may need the
              // channel made writable first).
              return update.authorUserToken
                ? userWebFactory(update.authorUserToken).apiCall("chat.update", args)
                : withWritableChannel(update.channel, () => web.apiCall("chat.update", args));
            },
            options.onImageFallback,
          );
        }),
      ),
    deleteMessage: (channel: string, ts: string, authorUserToken?: string) =>
      postPacer.run(channel, () =>
        call(async () => {
          const args = { channel, ts };
          // A user-posted message can only be deleted with that user's token; a
          // bot-posted one with the bot token (channel made writable first).
          if (authorUserToken) {
            await userWebFactory(authorUserToken).apiCall("chat.delete", args);
          } else {
            await withWritableChannel(channel, () => web.apiCall("chat.delete", args));
          }
        }),
      ),
    lookupUserByEmail: (email) =>
      call(async () => {
        return lookupSlackUserByEmail(web.users, email);
      }),
    lookupUserName: (userId) =>
      call(async () => {
        return lookupSlackUserName(web.users, userId);
      }),
    lookupUserProfile: (userId) =>
      call(async () => {
        return lookupSlackUserProfile(web.users, userId);
      }),
  };
}
