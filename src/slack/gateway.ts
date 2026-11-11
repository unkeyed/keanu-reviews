import { ErrorCode, WebClient, type WebClientOptions } from "@slack/web-api";
import { type ClientMsgId, ttlCache } from "#lib";
import {
  type MessageImage,
  SLACK_SECTION_TEXT_LIMIT,
  type SlackBlock,
  sanitizeLinkLabel,
} from "./catalog.ts";
import { SlackApiError } from "./errors.ts";
import { type SleepFn, createPacer, withRateLimitRetry } from "./pacer.ts";

export const SLACK_METHODS = {
  bot: [
    "chat.delete",
    "chat.postMessage",
    "chat.update",
    "conversations.archive",
    "conversations.create",
    "conversations.info",
    "conversations.invite",
    "conversations.join",
    "conversations.list",
    "conversations.members",
    "conversations.rename",
    "conversations.setTopic",
    "conversations.unarchive",
    "users.info",
    "users.lookupByEmail",
  ],
  user: ["chat.delete", "chat.postMessage", "chat.update", "conversations.leave"],
  oauth: ["oauth.v2.access"],
} as const;

type BotMethod = (typeof SLACK_METHODS.bot)[number];
type UserMethod = (typeof SLACK_METHODS.user)[number];

export interface RenderedMessage {
  text: string;
  blocks?: SlackBlock[];
  images?: readonly MessageImage[];
}

export type Poster =
  | { kind: "bot" }
  | { kind: "bot-as"; username?: string; iconUrl?: string }
  | { kind: "user"; userId: string; token: string };

export const BOT: Poster = { kind: "bot" };

export interface SlackProfile {
  name?: string;
  iconUrl?: string;
}

export interface RefusedInvite {
  userId?: string;
  error: string;
}

export type LeaveOutcome = "left" | "already_out" | "invalid_token";

export interface SlackGateway {
  createChannel(name: string): Promise<string>;
  findChannelByName(name: string): Promise<string | undefined>;
  resolveChannel(idOrName: string): Promise<string | undefined>;
  rename(channel: string, name: string): Promise<void>;
  setTopic(channel: string, topic: string): Promise<void>;
  archive(channel: string): Promise<void>;
  unarchive(channel: string): Promise<void>;
  isArchived(channel: string): Promise<boolean | undefined>;
  invite(channel: string, users: readonly string[]): Promise<RefusedInvite[]>;
  members(channel: string): Promise<string[]>;
  leave(channel: string, userToken: string): Promise<LeaveOutcome>;
  post(
    channel: string,
    msg: RenderedMessage,
    opts: { poster: Poster; threadTs?: string; clientMsgId: ClientMsgId },
  ): Promise<string>;
  /** Slack only lets a message be edited or deleted with the token that posted it. */
  update(channel: string, ts: string, msg: RenderedMessage, userToken?: string): Promise<void>;
  remove(channel: string, ts: string, userToken?: string): Promise<void>;
  lookupByEmail(email: string): Promise<string | undefined>;
  profile(user: string): Promise<SlackProfile | undefined>;
}

export interface SlackWebApi {
  apiCall(method: string, options?: Record<string, unknown>): Promise<unknown>;
}

export interface SlackGatewayOptions {
  web?: SlackWebApi;
  webFactory?: (token: string, options: WebClientOptions) => SlackWebApi;
  userWebFactory?: (token: string) => SlackWebApi;
  sleep?: SleepFn;
  now?: () => number;
  onImageFallback?: (info: {
    channel: string;
    method: "chat.postMessage" | "chat.update";
    embeds: number;
  }) => void;
}

const REQUEST_TIMEOUT_MS = 10_000;
const LOOKUP_CACHE_MS = 5 * 60_000;
const LOOKUP_CACHE_ENTRIES = 5_000;
const MAX_RATE_LIMIT_RETRIES = 1;
const MAX_RATE_LIMIT_DELAY_MS = 5_000;

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

function refusedInvites(response: unknown): RefusedInvite[] {
  const errors = (response as { errors?: unknown })?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((entry) => {
    const { user, error } = entry as { user?: unknown; error?: unknown };
    if (typeof error !== "string" || error === "already_in_channel") return [];
    return [{ userId: typeof user === "string" ? user : undefined, error }];
  });
}

function toSlackApiError(method: string, e: unknown): SlackApiError {
  const err = e as {
    code?: string;
    retryAfter?: number;
    message?: unknown;
    data?: { error?: string; needed?: string; provided?: string };
  };
  if (err?.code === ErrorCode.RateLimitedError) {
    return new SlackApiError(method, "ratelimited", {
      retryAfterMs: (err.retryAfter ?? 1) * 1000,
      cause: e,
    });
  }
  const code = err?.data?.error;
  if (code) {
    const parts = [`Slack API error: ${code}`];
    if (err.data?.needed) parts.push(`needed scope: ${err.data.needed}`);
    if (err.data?.provided) parts.push(`provided scopes: ${err.data.provided}`);
    return new SlackApiError(method, code, {
      message: parts.join(" — "),
      neededScope: err.data?.needed,
      providedScopes: err.data?.provided,
      data: err.data,
      cause: e,
    });
  }
  return new SlackApiError(method, "no_response", {
    message: typeof err?.message === "string" ? err.message : String(e),
    cause: e,
  });
}

async function callApi(web: SlackWebApi, method: string, args: Record<string, unknown>) {
  try {
    return await web.apiCall(method, args);
  } catch (e) {
    throw toSlackApiError(method, e);
  }
}

async function tolerating<T>(code: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SlackApiError && error.code === code) return undefined;
    throw error;
  }
}

function requireNonEmptyString(value: unknown, method: string, description: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SlackApiError(method, "invalid_response", {
      message: `Slack ${description} response did not include a value`,
    });
  }
  return value;
}

type Page = { response_metadata?: { next_cursor?: unknown } };

function nextCursor(result: Page, method: string) {
  const next = result.response_metadata?.next_cursor;
  if (next !== undefined && typeof next !== "string") {
    throw new SlackApiError(method, "invalid_response", {
      message: `Slack ${method} response included an invalid cursor`,
    });
  }
  return next?.trim() || undefined;
}

async function paginate<R extends Page>(
  method: string,
  page: (cursor: string | undefined) => Promise<R>,
  onPage: (result: R) => boolean,
): Promise<void> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const result = await page(cursor);
    if (onPage(result)) return;
    cursor = nextCursor(result, method);
    if (cursor && seen.has(cursor)) {
      throw new SlackApiError(method, "invalid_response", {
        message: `Slack ${method} returned a repeated cursor`,
      });
    }
    if (cursor) seen.add(cursor);
  } while (cursor);
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
  channel: string,
  msg: RenderedMessage,
  method: "chat.postMessage" | "chat.update",
  send: (blocks: SlackBlock[] | undefined) => Promise<T>,
  onFallback: SlackGatewayOptions["onImageFallback"],
): Promise<T> {
  const images = msg.images ?? [];
  const embeds = images.filter((i) => i.kind === "embed").length;
  const render = (mode: "embed" | "links") =>
    images.length > 0 ? [...(msg.blocks ?? []), ...imageBlocks(images, mode)] : msg.blocks;
  try {
    return await send(render("embed"));
  } catch (error) {
    if (embeds === 0 || !(error instanceof SlackApiError) || error.code !== "invalid_blocks") {
      throw error;
    }
    onFallback?.({ channel, method, embeds });
    return send(render("links"));
  }
}

const looksLikeChannelId = (value: string): boolean => /^[CGD][A-Z0-9]{5,}$/.test(value);

export function createSlackGateway(token: string, options: SlackGatewayOptions = {}): SlackGateway {
  const clientOptions: WebClientOptions = {
    // SDK defaults can otherwise retry for roughly 30 minutes, far beyond the
    // worker and message-effect leases.
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: REQUEST_TIMEOUT_MS,
  };
  const webFactory = options.webFactory ?? ((apiToken, config) => new WebClient(apiToken, config));
  const web = options.web ?? webFactory(token, clientOptions);
  const userWebFactory =
    options.userWebFactory ?? ((userToken: string) => webFactory(userToken, clientOptions));
  const postPacer = createPacer(1000, options.sleep, options.now);
  const createChannelPacer = createPacer(3000, options.sleep, options.now);
  const resolvedChannels = new Map<string, string>();
  const cached = { ttlMs: LOOKUP_CACHE_MS, maxEntries: LOOKUP_CACHE_ENTRIES, now: options.now };
  const channelLookups = ttlCache<string, string | undefined>(cached);
  const emailLookups = ttlCache<string, string | undefined>(cached);
  const profiles = ttlCache<string, SlackProfile | undefined>(cached);

  const bot = (method: BotMethod, args: Record<string, unknown>) => callApi(web, method, args);
  const asUser = (userToken: string, method: UserMethod, args: Record<string, unknown>) =>
    callApi(userWebFactory(userToken), method, args);
  const call = <T>(fn: () => Promise<T>): Promise<T> =>
    withRateLimitRetry(fn, {
      maxRetries: MAX_RATE_LIMIT_RETRIES,
      maxRetryDelayMs: MAX_RATE_LIMIT_DELAY_MS,
      sleep: options.sleep,
    });

  const withWritableChannel = async <T>(
    channel: string,
    op: () => Promise<T>,
    rejoin: () => Promise<unknown> = () => bot("conversations.join", { channel }),
  ): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await op();
      } catch (error) {
        const code = error instanceof SlackApiError ? error.code : undefined;
        if (attempt < 2 && code === "not_in_channel") {
          await rejoin();
          continue;
        }
        if (attempt < 2 && code === "is_archived") {
          await bot("conversations.unarchive", { channel });
          continue;
        }
        throw error;
      }
    }
  };

  const ts = (result: unknown) =>
    requireNonEmptyString(
      (result as { ts?: unknown })?.ts,
      "chat.postMessage",
      "chat.postMessage timestamp",
    );

  type PostArgs = Record<string, unknown> & { channel: string };

  const postAsBot = async (
    poster: Extract<Poster, { kind: "bot" | "bot-as" }>,
    args: PostArgs,
  ): Promise<unknown> => {
    const username = poster.kind === "bot-as" ? poster.username : undefined;
    const iconUrl = poster.kind === "bot-as" ? poster.iconUrl : undefined;
    const customize = Boolean(username || iconUrl);
    const post = (withAuthor: boolean) =>
      withWritableChannel(args.channel, () =>
        bot("chat.postMessage", {
          ...args,
          username: withAuthor ? username : undefined,
          icon_url: withAuthor ? iconUrl : undefined,
        }),
      );
    try {
      return await post(customize);
    } catch (error) {
      if (customize && error instanceof SlackApiError && error.code === "missing_scope") {
        return post(false);
      }
      throw error;
    }
  };

  const postAsUser = (poster: Extract<Poster, { kind: "user" }>, args: PostArgs) => {
    const { channel } = args;
    const inviteUser = () =>
      tolerating("already_in_channel", () =>
        bot("conversations.invite", { channel, users: poster.userId }),
      );
    return withWritableChannel(
      channel,
      () => asUser(poster.token, "chat.postMessage", args),
      inviteUser,
    );
  };

  const findChannelByName = async (name: string): Promise<string | undefined> => {
    let found: string | undefined;
    await paginate(
      "conversations.list",
      (cursor) =>
        call(() =>
          bot("conversations.list", {
            cursor,
            exclude_archived: false,
            limit: 999,
            types: "public_channel",
          }),
        ) as Promise<Page & { channels?: unknown }>,
      (result) => {
        if (!Array.isArray(result.channels)) {
          throw new SlackApiError("conversations.list", "invalid_response", {
            message: "Slack conversations.list response did not include a channels array",
          });
        }
        for (const channel of result.channels) {
          const candidate = channel as { id?: unknown; name?: unknown };
          if (candidate.name === name) {
            found = requireNonEmptyString(
              candidate.id,
              "conversations.list",
              "conversations.list channel ID",
            );
            return true;
          }
        }
        return false;
      },
    );
    return found;
  };

  return {
    createChannel: (name) =>
      createChannelPacer.run("create", () =>
        call(async () => {
          const res = (await bot("conversations.create", { name })) as {
            channel?: { id?: unknown };
          };
          return requireNonEmptyString(
            res?.channel?.id,
            "conversations.create",
            "conversations.create channel ID",
          );
        }),
      ),
    findChannelByName,
    resolveChannel: async (idOrName) => {
      if (looksLikeChannelId(idOrName)) return idOrName;
      const cached = resolvedChannels.get(idOrName);
      if (cached) return cached;
      const channelId = await channelLookups.get(idOrName, () =>
        findChannelByName(idOrName.replace(/^#/, "")),
      );
      if (channelId) resolvedChannels.set(idOrName, channelId);
      return channelId;
    },
    rename: (channel, name) =>
      call(async () => {
        await withWritableChannel(channel, () => bot("conversations.rename", { channel, name }));
      }),
    setTopic: (channel, topic) =>
      call(async () => {
        await withWritableChannel(channel, () => bot("conversations.setTopic", { channel, topic }));
      }),
    archive: (channel) =>
      call(async () => {
        await tolerating("already_archived", () =>
          withWritableChannel(channel, () => bot("conversations.archive", { channel })),
        );
      }),
    unarchive: (channel) =>
      call(async () => {
        await tolerating("not_archived", () =>
          withWritableChannel(channel, () => bot("conversations.unarchive", { channel })),
        );
      }),
    isArchived: (channel) =>
      call(() =>
        tolerating("channel_not_found", async () => {
          const res = (await bot("conversations.info", { channel })) as {
            channel?: { is_archived?: unknown };
          };
          const archived = res?.channel?.is_archived;
          return typeof archived === "boolean" ? archived : undefined;
        }),
      ),
    invite: (channel, users) =>
      call(async () => {
        if (users.length === 0) return [];
        try {
          const result = await withWritableChannel(channel, () =>
            bot("conversations.invite", { channel, users: users.join(","), force: true }),
          );
          return refusedInvites(result);
        } catch (error) {
          if (!(error instanceof SlackApiError)) throw error;
          if (error.code === "already_in_channel") return refusedInvites(error.data);
          if (!UNINVITABLE_USER_ERRORS.has(error.code)) throw error;
          const refused = refusedInvites(error.data);
          return refused.length > 0
            ? refused
            : users.map((userId) => ({ userId, error: error.code }));
        }
      }),
    members: async (channel) => {
      const members: string[] = [];
      await paginate(
        "conversations.members",
        (cursor) =>
          call(() =>
            withWritableChannel(channel, () =>
              bot("conversations.members", { channel, cursor, limit: 200 }),
            ),
          ) as Promise<Page & { members?: unknown }>,
        (result) => {
          if (
            !Array.isArray(result.members) ||
            !result.members.every((member) => typeof member === "string")
          ) {
            throw new SlackApiError("conversations.members", "invalid_response", {
              message: "Slack conversations.members response did not include a members array",
            });
          }
          members.push(...(result.members as string[]));
          return false;
        },
      );
      return members;
    },
    leave: (channel, userToken) =>
      call(async (): Promise<LeaveOutcome> => {
        try {
          await asUser(userToken, "conversations.leave", { channel });
          return "left";
        } catch (error) {
          if (!(error instanceof SlackApiError)) throw error;
          if (error.code === "not_in_channel") return "already_out";
          if (error.deadToken) return "invalid_token";
          throw error;
        }
      }),
    post: (channel, msg, opts) =>
      postPacer.run(channel, () =>
        call(async () => {
          const { poster } = opts;
          const result = await sendWithImageFallback(
            channel,
            msg,
            "chat.postMessage",
            (blocks) => {
              const args = {
                channel,
                text: msg.text,
                blocks,
                thread_ts: opts.threadTs,
                client_msg_id: opts.clientMsgId,
                unfurl_links: false,
                unfurl_media: false,
              };
              return poster.kind === "user" ? postAsUser(poster, args) : postAsBot(poster, args);
            },
            options.onImageFallback,
          );
          return ts(result);
        }),
      ),
    update: (channel, messageTs, msg, userToken) =>
      postPacer.run(channel, () =>
        call(async () => {
          await sendWithImageFallback(
            channel,
            msg,
            "chat.update",
            (blocks) => {
              const args = { channel, ts: messageTs, text: msg.text, blocks };
              return userToken
                ? asUser(userToken, "chat.update", args)
                : withWritableChannel(channel, () => bot("chat.update", args));
            },
            options.onImageFallback,
          );
        }),
      ),
    remove: (channel, messageTs, userToken) =>
      postPacer.run(channel, () =>
        call(async () => {
          const args = { channel, ts: messageTs };
          if (userToken) await asUser(userToken, "chat.delete", args);
          else await withWritableChannel(channel, () => bot("chat.delete", args));
        }),
      ),
    lookupByEmail: (email) =>
      emailLookups.get(email, () =>
        call(() =>
          tolerating("users_not_found", async () => {
            const result = (await bot("users.lookupByEmail", { email })) as {
              user?: { id?: unknown };
            };
            return requireNonEmptyString(
              result?.user?.id,
              "users.lookupByEmail",
              "users.lookupByEmail user ID",
            );
          }),
        ),
      ),
    profile: (user) =>
      profiles.get(user, () =>
        call(() =>
          tolerating("user_not_found", async () => {
            const result = (await bot("users.info", { user })) as {
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
            };
            const p = result?.user?.profile;
            const name =
              p?.display_name?.trim() ||
              p?.real_name?.trim() ||
              result?.user?.real_name?.trim() ||
              result?.user?.name?.trim() ||
              undefined;
            const iconUrl = p?.image_72?.trim() || p?.image_48?.trim() || undefined;
            if (!name && !iconUrl) return undefined;
            return { name, iconUrl };
          }),
        ),
      ),
  };
}
