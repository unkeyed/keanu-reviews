import type {
  CiReadinessFetcher,
  PrForShaFetcher,
  PullRequestFetcher,
  ReviewApprovalFetcher,
} from "#github";
import type { Clock } from "#lib";
import type { PrDeps } from "#pr";
import type { ReminderWindow } from "./window.ts";

export interface ReviewDeps extends PrDeps {
  clock: Clock;
  /** Aggregate check-run state of a commit; alerts wait for it to pass. */
  fetchCiReadiness: CiReadinessFetcher;
  /** Mergeability, draft and requested reviewers of a PR. */
  fetchPullRequest: PullRequestFetcher;
  fetchApprovalCount: ReviewApprovalFetcher;
  /** The PRs a commit heads, for a check run that lists none. */
  fetchPrForSha: PrForShaFetcher;
  /** A reminder comes due this many hours after its review alert. */
  reminderHours: number;
  /** Reminders post only inside this weekday window. */
  reminderWindow: ReminderWindow;
  /** Approvals at which a PR's reminders stop. */
  suppressApprovals: number;
}
