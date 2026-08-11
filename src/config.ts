import { z } from "zod";

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

  // Storage (U2)
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid connection URL"),

  // Reminder scheduler (U8) — tunable, with plan defaults.
  REMINDER_HOURS: z.coerce.number().positive().default(12),
  REMINDER_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Env keys whose values must never be logged (KTD12). */
export const SECRET_KEYS = [
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
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
