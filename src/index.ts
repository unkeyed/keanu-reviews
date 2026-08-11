import { serve } from "@hono/node-server";
import { type Config, ConfigError, SECRET_KEYS, loadConfig } from "./config.ts";
import { createLogger, registerSecretValues } from "./logger.ts";
import { createApp } from "./server.ts";

function boot(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // No logger yet — config failed — but this must be loud and never partial.
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // Redact concrete secret values anywhere they appear in future log lines (KTD12).
  registerSecretValues(
    SECRET_KEYS.map((k) => config[k]).filter((v): v is string => typeof v === "string"),
  );

  const logger = createLogger(config.LOG_LEVEL, { service: "unkey-slack-pr-bot" });
  const app = createApp({ config, logger });

  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    logger.info("service listening", { port: info.port, env: config.NODE_ENV });
  });
}

boot();
