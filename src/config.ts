import { z } from "zod";

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
 * Secrets (KTD12) are loaded from the environment, which on Unkey Deploy is
 * backed by the platform secret store. The keys enumerated in {@link SECRET_KEYS}
 * are never emitted by the logger (see `logger.ts`).
 */

const ConfigSchema = z.object({
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
