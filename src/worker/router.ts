import type { PrForShaFetcher } from "../ci/status.ts";
import type { JobRow } from "../db/schema.ts";
import { handleCheckRun } from "../handlers/checks.ts";
import { type PrHandlerDeps, handlePullRequest } from "../handlers/pullRequest.ts";
import { handleIssueComment, handleReview } from "../handlers/review.ts";
import { handleReviewComment } from "../handlers/reviewComment.ts";
import { handleReadyForReview, handleReviewRequest } from "../handlers/reviewRequest.ts";
import type { GithubEmailFetcher } from "../identity/resolve.ts";

export interface RouterDeps extends PrHandlerDeps {
  fetchGithubEmail?: GithubEmailFetcher;
  onReviewRequested?: (
    prId: string,
    reviewerGithubId: number,
    sourceUpdatedAt?: Date,
    sourceVersion?: string,
  ) => Promise<void>;
  onReviewRequestRemoved?: (
    prId: string,
    reviewerGithubId: number,
    sourceUpdatedAt?: Date,
    sourceVersion?: string,
  ) => Promise<void>;
  onReviewSubmitted?: (
    prId: string,
    reviewerGithubId: number,
    sourceUpdatedAt?: Date,
    sourceVersion?: string,
  ) => Promise<void>;
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
    const sourceArrivalKey = `${job.createdAt.toISOString()}:${job.id}`;
    switch (job.event) {
      case "pull_request":
        await handlePullRequest(deps, payload, { sourceArrivalKey });
        // review_requested / review_request_removed arrive as pull_request actions.
        if (job.action === "review_requested" || job.action === "review_request_removed") {
          await handleReviewRequest(deps, payload, job.deliveryId, sourceArrivalKey);
        } else if (job.action === "ready_for_review") {
          // Invite reviewers who were assigned while the PR was still a draft.
          await handleReadyForReview(deps, payload, job.deliveryId, sourceArrivalKey);
        }
        return;
      case "pull_request_review_comment":
        await handleReviewComment(deps, payload);
        return;
      case "pull_request_review":
        await handleReview(deps, payload, sourceArrivalKey);
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
