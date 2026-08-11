import type { Db } from "../db/client.ts";
import {
  findByRepoNumber,
  setChannel,
  updateState,
  upsertPullRequest,
} from "../db/repositories/pullRequests.ts";
import { cancelForPr } from "../db/repositories/reminders.ts";
import { type PrState, computeTargetState, isTerminal } from "../domain/prState.ts";
import type { Logger } from "../logger.ts";
import { sanitizeLinkLabel, sanitizeMrkdwn } from "../slack/blocks.ts";
import type { SlackClient } from "../slack/client.ts";
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

  let current = row;
  let channelCreated = false;
  let rootReconciled = false;
  // Persist the channel immediately so a root-post failure cannot orphan it.
  if (!row.channelId) {
    const name = channelName(state, repoFullName, pr.number);
    const { channelId } = await slack.createChannel(name);
    await setChannel(db, row.id, channelId, null);
    current = { ...row, channelId, rootMessageTs: null };
    channelCreated = true;
    logger.info("channel created", { prId: row.id, channelId, state });
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
        blocks: lifecycleBlocks(pr, state),
      },
    );
    await setChannel(db, current.id, channelId, root.slackTs);
    current = { ...current, rootMessageTs: root.slackTs };
  }

  const prevState = existing?.currentState;

  if (target && target !== prevState) {
    const name = channelName(target, repoFullName, pr.number);
    if (payload.action === "reopened" && prevState && isTerminal(prevState)) {
      await slack.unarchiveChannel(channelId);
    }
    await slack.renameChannel(channelId, name); // rename first, always (KTD8)
    await updateState(db, current.id, target);

    if (isTerminal(target)) {
      await slack.archiveChannel(channelId); // ...then archive
      await cancelForPr(db, current.id); // stop pending reminders on close/merge
    }
    logger.info("channel state reconciled", { prId: current.id, from: prevState, to: target });
  }

  // Thread a lifecycle note under the root for notable transitions.
  if (!channelCreated && !rootReconciled && target && current.rootMessageTs) {
    await deliverSlackMessage(
      db,
      slack,
      {
        prId: current.id,
        kind: "lifecycle",
        githubEventRef: `${payload.action}:${state}:${pr.head.sha}`,
      },
      {
        channel: channelId,
        text: sanitizeMrkdwn(`PR #${pr.number} ${payload.action}`),
        threadTs: current.rootMessageTs,
        blocks: lifecycleBlocks(pr, state),
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

function lifecycleBlocks(pr: PullRequestPayload["pull_request"], state: PrState): unknown[] {
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
