import { z } from "zod";
import { normalizeBotName } from "./github/actors.ts";
import { createTokenCipher } from "./slack/tokenCipher.ts";

const PublicUrlSchema = z
  .string()
  .url("PUBLIC_URL must be a valid URL")
  .superRefine((value, context) => {
    const url = new URL(value);
    const isLoopback =
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "PUBLIC_URL must be an HTTPS origin (HTTP only for loopback) without credentials, path, query, or hash",
      });
    }
  })
  .transform((value) => new URL(value).origin);

/**
 * Typed service configuration, validated at boot (U1).
 *
 * Secrets (KTD12) are loaded from the environment, which on a managed host is
 * backed by the platform secret store. The keys enumerated in {@link SECRET_KEYS}
 * are never emitted by the logger (see `logger.ts`).
 */

const ConfigSchema = z
  .object({
    // Runtime
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    // GitHub App (U3)
    GITHUB_APP_ID: z.string().min(1, "GITHUB_APP_ID is required"),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1, "GITHUB_APP_PRIVATE_KEY is required"),
    GITHUB_WEBHOOK_SECRET: z.string().min(1, "GITHUB_WEBHOOK_SECRET is required"),
    GITHUB_OAUTH_CLIENT_ID: z.string().min(1, "GITHUB_OAUTH_CLIENT_ID is required"),
    GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1, "GITHUB_OAUTH_CLIENT_SECRET is required"),
    OAUTH_STATE_SECRET: z.string().min(32, "OAUTH_STATE_SECRET must be at least 32 characters"),
    PUBLIC_URL: PublicUrlSchema,
    // The first release deliberately supports exactly one GitHub installation.
    GITHUB_INSTALLATION_ID: z
      .string()
      .min(1, "GITHUB_INSTALLATION_ID is required")
      .transform((value) => value.trim())
      .refine((value) => !value.includes(","), "configure a single GitHub installation")
      .refine((value) => /^\d+$/.test(value), "installation id must be numeric"),

    // Slack (U4-U9)
    SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required"),
    SLACK_SIGNING_SECRET: z.string().min(1, "SLACK_SIGNING_SECRET is required"),
    SLACK_TEAM_ID: z
      .string()
      .regex(/^T[A-Z0-9]{2,}$/, "SLACK_TEAM_ID must be a Slack workspace ID beginning with T"),
    // Opt-in: quiet archiving. When these three are set, `/link-slack` collects a
    // per-user Slack token so the bot can make each participant *leave* a PR
    // channel before archiving it — avoiding Slack's "archived the channel"
    // notification. All three are required together (see the superRefine below).
    SLACK_OAUTH_CLIENT_ID: z.string().min(1).optional(),
    SLACK_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
    // 32-byte AES key (hex/base64/base64url) that encrypts stored user tokens.
    SLACK_USER_TOKEN_ENC_KEY: z
      .string()
      .min(1)
      .optional()
      .refine((value) => {
        if (value === undefined) return true;
        try {
          createTokenCipher(value);
          return true;
        } catch {
          return false;
        }
      }, "SLACK_USER_TOKEN_ENC_KEY must decode to 32 bytes (hex, base64, or base64url)"),
    // Opt-in: post the Slack channel URL as a comment on the PR when it merges.
    // This is the ONLY GitHub write path and is OFF by default — enabling it
    // requires granting the GitHub App write permission and reinstalling.
    GITHUB_COMMENT_ON_MERGE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // Optional channel that receives a "shipped" announcement when a PR is merged.
    // Accepts a channel ID (e.g. C0123ABC) or a name (e.g. shipped / #shipped).
    // Unset disables the feature.
    SLACK_SHIPPED_CHANNEL: z.string().trim().min(1).optional(),
    // When true (default), a reply within a GitHub review thread is mirrored as a
    // Slack threaded reply under the original comment's message (mirroring
    // GitHub's threads). Thread-starting comments and PR conversation comments
    // always post top-level in the channel. Set "false" to keep everything flat.
    THREAD_COMMENTS: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    // Comma-separated bot logins whose comments/reviews SHOULD be mirrored
    // (e.g. "pullfrog,dependabot"). All other bots stay filtered. The `[bot]`
    // suffix and case are ignored, so "Pullfrog" matches "pullfrog[bot]".
    ALLOWED_BOTS: z
      .string()
      .default("")
      .transform((value) => {
        const set = new Set<string>();
        for (const raw of value.split(",")) {
          const name = normalizeBotName(raw);
          if (name) set.add(name);
        }
        return set as ReadonlySet<string>;
      }),

    // Storage (U2)
    DATABASE_URL: z.string().url("DATABASE_URL must be a valid connection URL"),

    // Reminder scheduler (U8) — tunable, with plan defaults.
    REMINDER_HOURS: z.coerce.number().positive().default(12),
    REMINDER_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    // Reminders are only delivered during this daily window (in REMINDER_WINDOW_TZ).
    // Default 05:00–14:00 Eastern. Start is inclusive, end exclusive; a window that
    // wraps midnight (start > end) is allowed.
    REMINDER_WINDOW_START_HOUR: z.coerce.number().int().min(0).max(23).default(5),
    REMINDER_WINDOW_END_HOUR: z.coerce.number().int().min(0).max(23).default(14),
    REMINDER_WINDOW_TZ: z
      .string()
      .default("America/New_York")
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, "REMINDER_WINDOW_TZ must be a valid IANA time zone (e.g. America/New_York)"),
  })
  .superRefine((cfg, ctx) => {
    // Quiet archiving is all-or-nothing: partial config would half-enable a
    // security-sensitive token flow. Require the trio together or not at all.
    const quietKeys = [
      "SLACK_OAUTH_CLIENT_ID",
      "SLACK_OAUTH_CLIENT_SECRET",
      "SLACK_USER_TOKEN_ENC_KEY",
    ] as const;
    const set = quietKeys.filter((k) => cfg[k] !== undefined);
    if (set.length > 0 && set.length < quietKeys.length) {
      for (const key of quietKeys) {
        if (cfg[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required to enable quiet archiving (set all of ${quietKeys.join(", ")} or none)`,
          });
        }
      }
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

/** Env keys whose values must never be logged (KTD12). */
export const SECRET_KEYS = [
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "OAUTH_STATE_SECRET",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_OAUTH_CLIENT_SECRET",
  "SLACK_USER_TOKEN_ENC_KEY",
  "DATABASE_URL",
] as const;

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * Parse and validate configuration from a raw env record.
 * Throws {@link ConfigError} naming every missing/invalid variable — fail-fast,
 * so a misconfigured deploy never boots into a half-broken state.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const path = i.path.join(".");
      return path ? `${path}: ${i.message}` : i.message;
    });
    throw new ConfigError(issues);
  }
  return result.data;
}
