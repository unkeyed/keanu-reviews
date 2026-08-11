import type { PrForShaFetcher } from "../ci/status.ts";
import type { Db } from "../db/client.ts";
import type { JobRow } from "../db/schema.ts";
import { handleCheckRun } from "../handlers/checks.ts";
import { handlePullRequest } from "../handlers/pullRequest.ts";
import { handleIssueComment, handleReview } from "../handlers/review.ts";
import { handleReviewComment } from "../handlers/reviewComment.ts";
import { handleReviewRequest } from "../handlers/reviewRequest.ts";
import type { GithubEmailFetcher } from "../identity/resolve.ts";
import type { Logger } from "../logger.ts";
import type { SlackClient } from "../slack/client.ts";

export interface RouterDeps {
  db: Db;
  slack: SlackClient;
  logger: Logger;
  reminderHours: number;
  fetchGithubEmail?: GithubEmailFetcher;
  onReviewRequested?: (prId: string, reviewerGithubId: number) => Promise<void>;
  onReviewRequestRemoved?: (prId: string, reviewerGithubId: number) => Promise<void>;
  onReviewSubmitted?: (prId: string, reviewerGithubId: number) => Promise<void>;
  fetchPrForSha?: PrForShaFetcher;
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
        // review_requested / review_request_removed arrive as pull_request actions.
        if (job.action === "review_requested" || job.action === "review_request_removed") {
          await handleReviewRequest(deps, payload);
        }
        return;
      case "pull_request_review_comment":
        await handleReviewComment(deps, payload);
        return;
      case "pull_request_review":
        await handleReview(deps, payload);
        return;
      case "issue_comment":
        await handleIssueComment(deps, payload);
        return;
      case "check_run":
        await handleCheckRun(deps, payload);
        return;
      default:
        deps.logger.debug("unhandled event", { event: job.event, action: job.action });
    }
  };
}
