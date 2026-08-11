import type { Db } from "../db/client.ts";
import type { JobRow } from "../db/schema.ts";
import { handlePullRequest } from "../handlers/pullRequest.ts";
import type { Logger } from "../logger.ts";
import type { SlackClient } from "../slack/client.ts";

export interface RouterDeps {
  db: Db;
  slack: SlackClient;
  logger: Logger;
  reminderHours: number;
}

export type Router = (job: JobRow) => Promise<void>;

/**
 * Dispatch a persisted job by GitHub event (U4+). Each unit wires its handler
 * here; unknown events are logged and dropped, not errored.
 */
export function createRouter(deps: RouterDeps): Router {
  return async (job) => {
    // biome-ignore lint/suspicious/noExplicitAny: raw webhook payload, shaped per handler.
    const payload = job.raw as any;
    switch (job.event) {
      case "pull_request":
        await handlePullRequest(deps, payload);
        return;
      default:
        deps.logger.debug("unhandled event", { event: job.event, action: job.action });
    }
  };
}
