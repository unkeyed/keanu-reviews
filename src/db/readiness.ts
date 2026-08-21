import { sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import {
  githubLinkConfirmations,
  identities,
  installations,
  jobs,
  messages,
  oauthStateNonces,
  processedDeliveries,
  pullRequestLifecycleClaims,
  pullRequests,
  reminders,
} from "./schema.ts";

export type ReadyCheck = () => Promise<void>;

/**
 * Build a readiness probe that checks both database reachability and every
 * table/column the running service requires. `limit 0` keeps the probe cheap
 * while PostgreSQL still resolves the full schema at parse time.
 */
export function createDbReadyCheck(db: Db): ReadyCheck {
  return async () => {
    await db.execute(sql`
      select
        (select row(
          ${installations.installationId}, ${installations.account}, ${installations.createdAt}
        )::text from ${installations} limit 0) as installations,
        (select row(
          ${pullRequests.id}, ${pullRequests.repoFullName}, ${pullRequests.number},
          ${pullRequests.githubPrId}, ${pullRequests.channelId}, ${pullRequests.currentState},
          ${pullRequests.appliedState}, ${pullRequests.appliedChannelName},
          ${pullRequests.channelNameVersion},
          ${pullRequests.sourceUpdatedAt}, ${pullRequests.sourceArrivalKey}, ${pullRequests.headSha},
          ${pullRequests.rootMessageTs}, ${pullRequests.createdAt}, ${pullRequests.updatedAt}
        )::text from ${pullRequests} limit 0) as pull_requests,
        (select row(
          ${pullRequestLifecycleClaims.githubPrId}, ${pullRequestLifecycleClaims.claimToken},
          ${pullRequestLifecycleClaims.claimedAt}
        )::text from ${pullRequestLifecycleClaims} limit 0) as pull_request_lifecycle_claims,
        (select row(
          ${messages.id}, ${messages.naturalKey}, ${messages.prId},
          ${messages.githubEventRef}, ${messages.slackTs}, ${messages.kind}, ${messages.status},
          ${messages.clientMsgId}, ${messages.claimedAt}, ${messages.createdAt}
        )::text from ${messages} limit 0) as messages,
        (select row(
          ${identities.githubUserId}, ${identities.githubLogin}, ${identities.slackUserId},
          ${identities.source}, ${identities.updatedAt}
        )::text from ${identities} limit 0) as identities,
        (select row(
          ${oauthStateNonces.nonceHash}, ${oauthStateNonces.expiresAt},
          ${oauthStateNonces.consumedAt}
        )::text from ${oauthStateNonces} limit 0) as oauth_state_nonces,
        (select row(
          ${githubLinkConfirmations.codeHash}, ${githubLinkConfirmations.slackTeamId},
          ${githubLinkConfirmations.slackUserId}, ${githubLinkConfirmations.githubUserId},
          ${githubLinkConfirmations.githubLogin}, ${githubLinkConfirmations.expiresAt},
          ${githubLinkConfirmations.createdAt}
        )::text from ${githubLinkConfirmations} limit 0) as github_link_confirmations,
        (select row(
          ${reminders.id}, ${reminders.prId}, ${reminders.reviewerGithubId},
          ${reminders.dueAt}, ${reminders.availableAt}, ${reminders.sourceUpdatedAt},
          ${reminders.sourceVersion}, ${reminders.generation}, ${reminders.attempts},
          ${reminders.status}, ${reminders.claimedAt},
          ${reminders.createdAt}
        )::text from ${reminders} limit 0) as reminders,
        (select row(
          ${jobs.id}, ${jobs.deliveryId}, ${jobs.event}, ${jobs.action}, ${jobs.raw},
          ${jobs.status}, ${jobs.attempts}, ${jobs.claimedAt}, ${jobs.availableAt},
          ${jobs.createdAt}
        )::text from ${jobs} limit 0) as jobs,
        (select row(
          ${processedDeliveries.deliveryId}, ${processedDeliveries.seenAt}
        )::text from ${processedDeliveries} limit 0) as processed_deliveries
    `);
  };
}
