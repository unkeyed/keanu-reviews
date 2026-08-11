import type { Db } from "../db/client.ts";
import {
  applyPullRequestSource,
  findByGithubPrId,
  findByRepoNumber,
  markSlackStateApplied,
  setChannel,
} from "../db/repositories/pullRequests.ts";
import { cancelForPr } from "../db/repositories/reminders.ts";
import { type PrState, computeTargetState, isTerminal } from "../domain/prState.ts";
import type { Logger } from "../logger.ts";
import { sanitizeLinkLabel, sanitizeMrkdwn } from "../slack/blocks.ts";
import type { SlackBlock, SlackClient } from "../slack/client.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";
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
    updated_at: string;
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

  const sourceUpdatedAt = new Date(pr.updated_at);
  if (Number.isNaN(sourceUpdatedAt.getTime())) {
    throw new Error(`Invalid pull_request.updated_at for GitHub PR ${pr.id}`);
  }

  const existing = await findByGithubPrId(db, pr.id);
  const state: PrState = target ?? existing?.currentState ?? (pr.draft ? "draft" : "pr");

  const source = await applyPullRequestSource(db, {
    repoFullName,
    number: pr.number,
    githubPrId: pr.id,
    currentState: state,
    headSha: pr.head.sha, // refreshed on opened/synchronize (U7 mapping)
    sourceUpdatedAt,
  });
  if (!source.sourceAccepted) {
    logger.info("stale PR lifecycle event ignored", {
      githubPrId: pr.id,
      incomingUpdatedAt: pr.updated_at,
      storedUpdatedAt: source.row.sourceUpdatedAt?.toISOString(),
    });
    return;
  }
  const row = source.row;

  let current = row;
  let channelCreated = false;
  let rootReconciled = false;
  // Persist the channel immediately so a root-post failure cannot orphan it.
  if (!row.channelId) {
    const name = channelName(row.currentState, row.repoFullName, row.number);
    const { channelId } = await slack.createChannel(name);
    await setChannel(db, row.id, channelId, null);
    current = { ...row, channelId, rootMessageTs: null };
    channelCreated = true;
    logger.info("channel created", { prId: row.id, channelId, state: row.currentState });
  }

  const channelId = current.channelId;
  if (!channelId) throw new Error(`PR channel mapping is missing for ${current.id}`);

  if (!current.rootMessageTs) {
    rootReconciled = true;
    const root = await deliverSlackMessage(
      db,
      slack,
      { prId: current.id, kind: "root", githubEventRef: "root" },
      {
        channel: channelId,
        text: sanitizeMrkdwn(`PR #${pr.number}: ${pr.title}`),
        blocks: lifecycleBlocks(pr, row.currentState),
      },
    );
    await setChannel(db, current.id, channelId, root.slackTs);
    current = { ...current, rootMessageTs: root.slackTs };
  }

  const desiredState = current.currentState;
  const desiredChannelName = channelName(desiredState, current.repoFullName, current.number);
  const needsSlackReconciliation =
    current.appliedState !== desiredState || current.appliedChannelName !== desiredChannelName;

  if (needsSlackReconciliation) {
    // Either side being terminal can mean the real channel is archived after a
    // partial prior attempt. Make it writable before the idempotent rename.
    if (isTerminal(desiredState) || (current.appliedState && isTerminal(current.appliedState))) {
      await slack.unarchiveChannel(channelId);
    }
    await slack.renameChannel(channelId, desiredChannelName); // rename first, always (KTD8)

    if (isTerminal(desiredState)) {
      await slack.archiveChannel(channelId); // ...then archive
      await cancelForPr(db, current.id); // stop pending reminders on close/merge
    }
    await markSlackStateApplied(db, current.id, desiredState, desiredChannelName);
    logger.info("channel state reconciled", {
      prId: current.id,
      from: current.appliedState,
      to: desiredState,
      channelName: desiredChannelName,
    });
  }

  // Thread a lifecycle note under the root for notable transitions.
  if (!channelCreated && !rootReconciled && target && current.rootMessageTs) {
    await deliverSlackMessage(
      db,
      slack,
      {
        prId: current.id,
        kind: "lifecycle",
        githubEventRef: `${payload.action}:${desiredState}:${pr.head.sha}:${pr.updated_at}`,
      },
      {
        channel: channelId,
        text: sanitizeMrkdwn(`PR #${pr.number} ${payload.action}`),
        threadTs: current.rootMessageTs,
        blocks: lifecycleBlocks(pr, desiredState),
      },
    );
  }
}

export async function ensurePullRequestChannel(
  deps: PrHandlerDeps,
  repository: { full_name: string },
  pullRequest: PullRequestPayload["pull_request"],
) {
  let row = await findByRepoNumber(deps.db, repository.full_name, pullRequest.number);
  if (!row?.channelId || !row.rootMessageTs) {
    await handlePullRequest(deps, {
      action: "synchronize",
      repository,
      pull_request: pullRequest,
    });
    row = await findByRepoNumber(deps.db, repository.full_name, pullRequest.number);
  }
  if (!row?.channelId || !row.rootMessageTs) {
    throw new Error(`PR channel is not ready for ${repository.full_name}#${pullRequest.number}`);
  }
  return row;
}

function lifecycleBlocks(pr: PullRequestPayload["pull_request"], state: PrState): SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${pr.html_url}|#${pr.number} ${sanitizeLinkLabel(pr.title)}>* — \`${state}\` · by ${sanitizeMrkdwn(pr.user.login)}`,
      },
    },
  ];
}
