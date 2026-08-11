import type { Db } from "../db/client.ts";
import { recordMessage } from "../db/repositories/messages.ts";
import {
  findByRepoNumber,
  setChannel,
  updateState,
  upsertPullRequest,
} from "../db/repositories/pullRequests.ts";
import { cancelForPr } from "../db/repositories/reminders.ts";
import { type PrState, computeTargetState, isTerminal } from "../domain/prState.ts";
import type { Logger } from "../logger.ts";
import type { SlackClient } from "../slack/client.ts";
import { channelName } from "../slack/naming.ts";

export interface PullRequestPayload {
  action: string;
  pull_request: {
    number: number;
    id: number;
    draft?: boolean;
    merged?: boolean;
    title: string;
    html_url: string;
    user: { login: string };
    head: { sha: string };
  };
  repository: { full_name: string };
}

export interface PrHandlerDeps {
  db: Db;
  slack: SlackClient;
  logger: Logger;
}

/**
 * PR lifecycle -> channel management (U4). Idempotent and state-derived (KTD4):
 * reconciles the channel to the target state, renames before archiving (KTD8),
 * unarchives on reopen, and creates the channel only when none is stored yet.
 */
export async function handlePullRequest(
  deps: PrHandlerDeps,
  payload: PullRequestPayload,
): Promise<void> {
  const { db, slack, logger } = deps;
  const repoFullName = payload.repository.full_name;
  const pr = payload.pull_request;
  const target = computeTargetState(payload.action, {
    draft: pr.draft ?? false,
    merged: pr.merged ?? false,
  });

  const existing = await findByRepoNumber(db, repoFullName, pr.number);
  const state: PrState = target ?? existing?.currentState ?? (pr.draft ? "draft" : "pr");

  const row = await upsertPullRequest(db, {
    repoFullName,
    number: pr.number,
    githubPrId: pr.id,
    currentState: state,
    headSha: pr.head.sha, // refreshed on opened/synchronize (U7 mapping)
  });

  // Create the channel exactly once (idempotent on the stored mapping).
  if (!row.channelId) {
    const name = channelName(state, repoFullName, pr.number);
    const { channelId } = await slack.createChannel(name);
    const root = await slack.postMessage({
      channel: channelId,
      text: `PR #${pr.number}: ${pr.title}`,
      blocks: lifecycleBlocks(pr, state),
    });
    await setChannel(db, row.id, channelId, root.ts);
    await recordMessage(db, { prId: row.id, kind: "root", githubEventRef: null, slackTs: root.ts });
    logger.info("channel created", { prId: row.id, channelId, state });
    return;
  }

  const channelId = row.channelId;
  const prevState = existing?.currentState;

  if (target && target !== prevState) {
    const name = channelName(target, repoFullName, pr.number);
    if (payload.action === "reopened" && prevState && isTerminal(prevState)) {
      await slack.unarchiveChannel(channelId);
    }
    await slack.renameChannel(channelId, name); // rename first, always (KTD8)
    await updateState(db, row.id, target);

    if (isTerminal(target)) {
      await slack.archiveChannel(channelId); // ...then archive
      await cancelForPr(db, row.id); // stop pending reminders on close/merge
    }
    logger.info("channel state reconciled", { prId: row.id, from: prevState, to: target });
  }

  // Thread a lifecycle note under the root for notable transitions.
  if (target && row.rootMessageTs) {
    await slack.postMessage({
      channel: channelId,
      text: `PR #${pr.number} ${payload.action}`,
      threadTs: row.rootMessageTs,
      blocks: lifecycleBlocks(pr, state),
    });
  }
}

function lifecycleBlocks(pr: PullRequestPayload["pull_request"], state: PrState): unknown[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${pr.html_url}|#${pr.number} ${pr.title}>* — \`${state}\` · by ${pr.user.login}`,
      },
    },
  ];
}
