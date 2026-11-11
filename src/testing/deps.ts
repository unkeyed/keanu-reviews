import type { HandlerDeps } from "#app";
import type { Db } from "#db";
import { createLogger, systemClock } from "#lib";
import type { FakeSlackGateway } from "./fakeSlack.ts";

export function handlerDeps(
  db: Db,
  slack: FakeSlackGateway,
  over: Partial<HandlerDeps> = {},
): HandlerDeps {
  return {
    db,
    slack,
    logger: createLogger("error"),
    clock: systemClock,
    fetchGithubEmail: async () => undefined,
    fetchCiReadiness: async () => "passing",
    fetchPullRequest: async () => ({
      mergeableState: "blocked",
      draft: false,
      requestedReviewers: [],
    }),
    fetchApprovalCount: async () => 0,
    fetchPrForSha: async () => [],
    reminderHours: 12,
    reminderWindow: { startHour: 0, endHour: 0, timeZone: "UTC" },
    suppressApprovals: 1,
    shippedChannel: undefined,
    postPrComment: undefined,
    slackTeamId: "T123",
    quietArchive: undefined,
    embedImages: async () => [],
    allowedBots: new Set(),
    threadComments: true,
    fetchSnapshot: async () => ({ snapshot: undefined, remaining: undefined }),
    authorPoster: undefined,
    ...over,
  };
}
