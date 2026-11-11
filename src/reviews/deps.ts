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
  fetchCiReadiness: CiReadinessFetcher;
  fetchPullRequest: PullRequestFetcher;
  fetchApprovalCount: ReviewApprovalFetcher;
  fetchPrForSha: PrForShaFetcher;
  reminderHours: number;
  reminderWindow: ReminderWindow;
  suppressApprovals: number;
}
