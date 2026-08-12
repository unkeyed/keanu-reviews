import type { Db } from "../db/client.ts";
import {
  applyPullRequestSource,
  claimMergeComment,
  claimPullRequestLifecycle,
  findByGithubPrId,
  findByRepoNumber,
  markSlackStateApplied,
  releaseMergeComment,
  releasePullRequestLifecycle,
  setChannel,
} from "../db/repositories/pullRequests.ts";
import { cancelForPr } from "../db/repositories/reminders.ts";
import { type PrState, computeTargetState, isTerminal } from "../domain/prState.ts";
import type { PrCommenter } from "../github/comments.ts";
import { type GithubEmailFetcher, resolveSlackUser } from "../identity/resolve.ts";
import type { Logger } from "../logger.ts";
import { sanitizeInlineCode, sanitizeLinkLabel, sanitizeMrkdwn } from "../slack/blocks.ts";
import type { SlackBlock, SlackClient } from "../slack/client.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";
import { slackChannelUrl } from "../slack/links.ts";
import { channelName } from "../slack/naming.ts";
import { RetryableError } from "../worker/retryable.ts";
import type { PullRequestFetcher } from "./mergeability.ts";
import { notifyShipped } from "./shipped.ts";

export interface PullRequestPayload {
  action: string;
  pull_request: {
    number: number;
    id: number;
    draft?: boolean;
    merged?: boolean;
    title: string;
    html_url: string;
    user: { login: string; id: number };
    head: { sha: string; ref?: string };
    base?: { ref: string };
    updated_at: string;
  };
  repository: { full_name: string };
}

export interface PrHandlerDeps {
  db: Db;
  slack: SlackClient;
  logger: Logger;
  /** Optional GitHub email lookup so identity resolution can fall back past the map. */
  fetchGithubEmail?: GithubEmailFetcher;
  /** Optional PR read used to report mergeability (replaces per-check CI messages). */
  fetchPullRequest?: PullRequestFetcher;
  /** Optional #shipped channel (id or name); announces a PR when it merges. */
  shippedChannel?: string;
  /** Opt-in: post the Slack channel URL as a comment on the PR when it merges. */
  commentOnMerge?: boolean;
  /** GitHub write used only by the merge-comment feature. */
  postPrComment?: PrCommenter;
  /** Slack workspace id, used to build the channel deep link for the merge comment. */
  slackTeamId?: string;
  /** Our GitHub App id, used to ignore comments the bot itself authored (echo guard). */
  githubAppId?: string;
}

export interface PullRequestHandlingOptions {
  sourceArrivalKey?: string;
  now?: Date;
  lifecycleLeaseMs?: number;
}

export class PullRequestLifecycleBusyError extends Error {
  constructor(githubPrId: number) {
    super(`GitHub PR ${githubPrId} is already being reconciled`);
    this.name = "PullRequestLifecycleBusyError";
  }
}

/**
 * PR lifecycle -> channel management (U4). Idempotent and state-derived (KTD4):
 * reconciles the channel to the target state, renames before archiving (KTD8),
 * unarchives on reopen, and creates the channel only when none is stored yet.
 */
export async function handlePullRequest(
  deps: PrHandlerDeps,
  payload: PullRequestPayload,
  options: PullRequestHandlingOptions = {},
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

  const lifecycleClaim = await claimPullRequestLifecycle(db, pr.id, {
    now: options.now,
    leaseMs: options.lifecycleLeaseMs,
  });
  if (!lifecycleClaim) throw new PullRequestLifecycleBusyError(pr.id);

  try {
    const existing = await findByGithubPrId(db, pr.id);
    const state: PrState = target ?? existing?.currentState ?? (pr.draft ? "draft" : "pr");

    const source = await applyPullRequestSource(db, {
      repoFullName,
      number: pr.number,
      githubPrId: pr.id,
      currentState: state,
      headSha: pr.head.sha, // refreshed on opened/synchronize (U7 mapping)
      sourceUpdatedAt,
      sourceArrivalKey: options.sourceArrivalKey,
    });
    if (!source.sourceAccepted) {
      logger.info("stale PR lifecycle event ignored", {
        githubPrId: pr.id,
        incomingUpdatedAt: pr.updated_at,
        incomingArrivalKey: options.sourceArrivalKey,
        storedUpdatedAt: source.row.sourceUpdatedAt?.toISOString(),
        storedArrivalKey: source.row.sourceArrivalKey,
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
      let channelId: string;
      try {
        ({ channelId } = await slack.createChannel(name));
      } catch (error) {
        // conversations.create can succeed remotely and fail locally, or a
        // retry can receive name_taken. Exact deterministic-name lookup
        // recovers only the intended PR channel.
        const recovered = await slack.findChannelByName(name);
        if (!recovered) throw error;
        channelId = recovered;
        logger.info("channel creation recovered by exact name", { prId: row.id, channelId, name });
      }
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
          blocks: rootBlocks(pr),
        },
      );
      await setChannel(db, current.id, channelId, root.slackTs);
      current = { ...current, rootMessageTs: root.slackTs };
    }

    // Invite the PR author into their channel. Idempotent per author, and
    // retryable across events, so an author who links their account after
    // opening still gets pulled in on the next PR event.
    const authorSlackId = await resolveSlackUser(deps, {
      githubId: pr.user.id,
      login: pr.user.login,
    });
    if (authorSlackId) {
      await deliverSlackMessage(
        db,
        slack,
        { prId: current.id, kind: "author_invite", githubEventRef: String(pr.user.id) },
        {
          channel: channelId,
          text: sanitizeMrkdwn(`PR opened by ${pr.user.login}`),
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: `👤 Opened by <@${authorSlackId}>` },
            },
          ],
        },
        () => slack.inviteUsers(channelId, [authorSlackId]),
      );
    }

    const desiredState = current.currentState;
    const desiredChannelName = channelName(desiredState, current.repoFullName, current.number);
    const needsSlackReconciliation =
      current.appliedState !== desiredState || current.appliedChannelName !== desiredChannelName;
    const shouldPostLifecycle =
      !channelCreated && !rootReconciled && Boolean(target && current.rootMessageTs);

    if (needsSlackReconciliation) {
      // Either side being terminal can mean the real channel is archived after a
      // partial prior attempt. Make it writable before the idempotent rename.
      if (isTerminal(desiredState) || (current.appliedState && isTerminal(current.appliedState))) {
        await slack.unarchiveChannel(channelId);
      }
      await slack.renameChannel(channelId, desiredChannelName); // rename first, always (KTD8)

      // Terminal channels must still be writable when the lifecycle note is
      // posted. A retry reuses its durable message effect before archiving.
      if (shouldPostLifecycle) {
        await postLifecycleNote(db, slack, current, payload, desiredState, channelId);
      }

      if (isTerminal(desiredState)) {
        // Announce merges (only merged, never plain close) in #shipped.
        if (desiredState === "merged") {
          await notifyShipped(
            { db, slack, logger, shippedChannel: deps.shippedChannel },
            {
              prId: current.id,
              repoFullName: current.repoFullName,
              number: current.number,
              title: pr.title,
              htmlUrl: pr.html_url,
              authorMention: authorSlackId ? `<@${authorSlackId}>` : sanitizeMrkdwn(pr.user.login),
            },
          );

          // Opt-in ONE-WAY-BOUNDARY EXCEPTION: post the Slack channel URL back to
          // the PR for context. Claimed atomically so it posts at most once.
          if (deps.commentOnMerge && deps.postPrComment && deps.slackTeamId) {
            if (await claimMergeComment(db, current.id, options.now ?? new Date())) {
              try {
                const url = slackChannelUrl(deps.slackTeamId, channelId);
                await deps.postPrComment(
                  current.repoFullName,
                  current.number,
                  `💬 Slack discussion for this PR: ${url}`,
                );
              } catch (error) {
                await releaseMergeComment(db, current.id); // allow a retry
                throw error;
              }
            }
          }
        }
        await slack.archiveChannel(channelId); // ...then archive
        await cancelForPr(db, current.id, sourceUpdatedAt, options.sourceArrivalKey ?? ""); // stop pending reminders on close/merge
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
    if (shouldPostLifecycle && !needsSlackReconciliation) {
      await postLifecycleNote(db, slack, current, payload, desiredState, channelId);
    }
  } finally {
    if (!(await releasePullRequestLifecycle(db, lifecycleClaim))) {
      logger.error("PR lifecycle lease was lost before release", { githubPrId: pr.id });
    }
  }
}

async function postLifecycleNote(
  db: Db,
  slack: SlackClient,
  row: { id: string; rootMessageTs: string | null },
  payload: PullRequestPayload,
  state: PrState,
  channelId: string,
): Promise<void> {
  const pr = payload.pull_request;
  if (!row.rootMessageTs) return;
  await deliverSlackMessage(
    db,
    slack,
    {
      prId: row.id,
      kind: "lifecycle",
      githubEventRef: `${payload.action}:${state}:${pr.head.sha}:${pr.updated_at}`,
    },
    {
      channel: channelId,
      text: sanitizeMrkdwn(`PR #${pr.number} ${payload.action}`),
      blocks: lifecycleBlocks(pr, state),
    },
  );
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
    throw new RetryableError(
      `PR channel is not ready for ${repository.full_name}#${pullRequest.number}`,
    );
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

/** The channel's opening message: a linked PR number plus the branch flow. */
function rootBlocks(pr: PullRequestPayload["pull_request"]): SlackBlock[] {
  const base = pr.base?.ref ?? "the base branch";
  const head = pr.head.ref ?? "this branch";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🔀 *<${pr.html_url}|PR #${pr.number}>* — ${sanitizeMrkdwn(pr.title)}\n${sanitizeMrkdwn(pr.user.login)} wants to merge into \`${sanitizeInlineCode(base)}\` from \`${sanitizeInlineCode(head)}\``,
      },
    },
  ];
}
