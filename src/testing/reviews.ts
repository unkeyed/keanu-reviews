import type { Db } from "#db";
import { createLogger, systemClock } from "#lib";
import type { ReviewDeps } from "#reviews";
import type { FakeSlackGateway } from "./fakeSlack.ts";

/**
 * Review deps whose GitHub reads say: CI passing, the PR blocked with no
 * requested reviewers, no approvals. The window is open every weekday.
 */
export function reviewDeps(
  db: Db,
  slack: FakeSlackGateway,
  over: Partial<ReviewDeps> = {},
): ReviewDeps {
  return {
    db,
    slack,
    logger: createLogger("error"),
    clock: systemClock,
    fetchCiReadiness: async () => "passing",
    fetchPullRequest: async () => ({
      mergeableState: "blocked",
      draft: false,
      requestedReviewers: [],
    }),
    fetchApprovalCount: async () => 0,
    reminderHours: 12,
    reminderWindow: { startHour: 0, endHour: 0, timeZone: "UTC" },
    suppressApprovals: 1,
    ...over,
  };
}
