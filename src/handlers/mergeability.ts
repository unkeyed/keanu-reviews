import type { Db } from "../db/client.ts";
import { setMergeableState } from "../db/repositories/pullRequests.ts";
import type { PullRequestRow } from "../db/schema.ts";
import type { Logger } from "../logger.ts";
import { sanitizeMrkdwn } from "../slack/blocks.ts";
import type { SlackClient } from "../slack/client.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";
import { RetryableError } from "../worker/retryable.ts";

export interface PullRequestMergeability {
  mergeable: boolean | null;
  mergeableState: string;
  draft: boolean;
}

/** Read a PR's current mergeability (a GitHub read; within the one-way boundary). */
export type PullRequestFetcher = (
  repoFullName: string,
  number: number,
) => Promise<PullRequestMergeability | undefined>;

export interface MergeabilityDeps {
  db: Db;
  slack: SlackClient;
  logger: Logger;
  fetchPullRequest?: PullRequestFetcher;
}

/**
 * Friendly channel message per GitHub `mergeable_state`. `behind` is
 * deliberately absent: "update the branch before merging" is a noisy nudge the
 * author acts on in GitHub, not something the channel needs announced.
 */
const LABEL: Record<string, string> = {
  clean: "✅ Ready to merge",
  has_hooks: "✅ Ready to merge",
  unstable: "⚠️ Mergeable, but some checks are failing",
  blocked: "⛔ Blocked — required reviews or checks are not satisfied",
  dirty: "❌ Merge conflicts — this branch needs a rebase or merge",
};

/** States we intentionally never announce (no channel message, no log noise). */
const SILENT_STATES = new Set(["behind"]);

/**
 * Report a PR's mergeability into its channel (replaces per-check CI messages).
 * GitHub computes `mergeable_state` asynchronously, so an `unknown`/null result
 * is retried (RetryableError) until it settles. Posts only when the state
 * changed since the last announcement, so a stable PR stays quiet.
 */
export async function reportMergeability(
  deps: MergeabilityDeps,
  row: PullRequestRow,
  sourceEventId: string,
): Promise<void> {
  if (!deps.fetchPullRequest) return;
  if (!row.channelId) {
    throw new RetryableError(`PR channel is not ready for ${row.repoFullName}#${row.number}`);
  }

  const pr = await deps.fetchPullRequest(row.repoFullName, row.number);
  if (!pr || pr.draft) return; // draft PRs already show `draft` in the channel name

  if (pr.mergeableState === "unknown" || pr.mergeable === null) {
    // GitHub hasn't finished computing it yet — retry with backoff.
    throw new RetryableError(
      `mergeability not computed yet for ${row.repoFullName}#${row.number}`,
      { mergeableState: pr.mergeableState },
    );
  }

  const label = LABEL[pr.mergeableState];
  if (!label) {
    if (!SILENT_STATES.has(pr.mergeableState)) {
      deps.logger.debug("unmapped mergeable_state", { state: pr.mergeableState });
    }
    return;
  }

  if (row.lastMergeableState === pr.mergeableState) return; // no change — stay quiet

  // Post before persisting the new state: a retry re-posts under the same
  // effect key (deduped) rather than skipping and losing the message.
  await deliverSlackMessage(
    deps.db,
    deps.slack,
    { prId: row.id, kind: "mergeability", githubEventRef: sourceEventId },
    {
      channel: row.channelId,
      text: sanitizeMrkdwn(label),
      blocks: [{ type: "section", text: { type: "mrkdwn", text: label } }],
    },
  );
  await setMergeableState(deps.db, row.id, pr.mergeableState);
}
