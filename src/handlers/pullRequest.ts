import type { Db } from "#db";
import {
  type PrChange,
  type PrSnapshot,
  type PrState,
  claimFromAction,
  isTerminal,
  nextState,
} from "#events";
import type {
  CiReadinessFetcher,
  GithubEmailFetcher,
  ImageEmbedder,
  PrCommenter,
  PullRequestFetcher,
} from "#github";
import { displayName, resolveSlackUser } from "#identity";
import { type ArrivalKey, type Logger, type PrId, Retry, errMessage, leaseWaitMs } from "#lib";
import {
  PULL_REQUEST_LIFECYCLE_LEASE_MS,
  applyPullRequestSource,
  claimMergeComment,
  claimPullRequestLifecycle,
  findByGithubPrId,
  findByRepoNumber,
  markSlackStateApplied,
  pullRequestLifecycleClaimedAt,
  releaseMergeComment,
  releasePullRequestLifecycle,
  setChannel,
} from "#pr";
import { cancelForPr } from "#reminders";
import {
  CURRENT_CHANNEL_NAME_VERSION,
  type Ledger,
  type PrView,
  SlackApiError,
  type SlackGateway,
  channelName,
  channelSink,
  channelTopic,
  createLedger,
  keys,
  slackChannelUrl,
} from "#slack";
import { inviteToChannel } from "./invites.ts";
import { notifyShipped } from "./shipped.ts";

export interface PrHandlerDeps {
  db: Db;
  slack: SlackGateway;
  logger: Logger;
  /** Optional GitHub email lookup so identity resolution can fall back past the map. */
  fetchGithubEmail?: GithubEmailFetcher;
  /**
   * Aggregate CI for the PR head. Review-needed alerts wait until this is
   * passing. Omit to keep the previous behavior (drafts still wait; CI is not
   * consulted).
   */
  fetchCiReadiness?: CiReadinessFetcher;
  /** Optional PR read: mergeability for reminders, and requested reviewers for alerts. */
  fetchPullRequest?: PullRequestFetcher;
  /** Optional #shipped channel (id or name); announces a PR when it merges. */
  shippedChannel?: string;
  /** Opt-in: post the Slack channel URL as a comment on the PR when it merges. */
  commentOnMerge?: boolean;
  /** GitHub write used only by the merge-comment feature. */
  postPrComment?: PrCommenter;
  /** Slack workspace id, used to build the channel deep link for the merge comment. */
  slackTeamId?: string;
  embedImages?: ImageEmbedder;
  /** Bot logins (normalized) whose comments/reviews should be mirrored anyway. */
  allowedBots?: ReadonlySet<string>;
  /**
   * When true (default), a reply within a GitHub review thread is posted as a
   * Slack threaded reply under the original comment's message. When false, every
   * comment posts top-level (flat). Thread-starting comments and PR conversation
   * comments are always top-level regardless.
   */
  threadComments?: boolean;
  /**
   * Optional silent-archive hook (U-quiet). When set, it makes members who have
   * authorized us leave the channel before it's archived, so Slack sends no
   * "archived the channel" notification. Best-effort — it must never throw or
   * block the archive. Omitted when Slack user-OAuth isn't configured.
   */
  quietArchive?: (channelId: string) => Promise<void>;
  /**
   * Optional post-as-user capability. When wired (Slack user-OAuth configured),
   * mirrored comments/reviews are authored with the linked user's own token
   * instead of the bot. `getUserToken` returns a decrypted token ONLY when the
   * user granted `chat:write`; `onInvalidToken` drops a token Slack reports dead.
   */
  authorPoster?: {
    getUserToken: (slackUserId: string) => Promise<string | undefined>;
    onInvalidToken: (slackUserId: string) => Promise<void>;
  };
}

export interface PullRequestHandlingOptions {
  sourceArrivalKey?: ArrivalKey;
  now?: Date;
  lifecycleLeaseMs?: number;
  /**
   * Post the #shipped note and the opt-in GitHub merge comment when a PR merges.
   * Defaults to true, which is the webhook path. Late reconciliation sets this
   * false so a catch-up archive does not announce a merge that already happened.
   */
  announceMerge?: boolean;
}

/** Whether the snapshot was stored. False when a newer snapshot was already applied. */
export interface PullRequestHandlingResult {
  sourceAccepted: boolean;
  /** A configured #shipped note was not posted. */
  skippedShipped: boolean;
  /** A configured merge comment was not posted. */
  skippedMergeComment: boolean;
}

/** The holder may have crashed, so a retry waits until its lease can be reclaimed. */
export class PullRequestLifecycleBusyError extends Retry {
  constructor(githubPrId: number, retryAfterMs?: number) {
    super(`GitHub PR ${githubPrId} is already being reconciled`, { githubPrId }, retryAfterMs);
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
  change: PrChange,
  options: PullRequestHandlingOptions = {},
): Promise<PullRequestHandlingResult> {
  const { db, slack, logger } = deps;
  const ledger = createLedger(db);
  const { pr } = change;
  const repoFullName = pr.repo;
  const view: PrView = {
    repo: repoFullName,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    authorLogin: pr.author.login,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
  };
  const claim = claimFromAction(change.action, pr.draft, change.merged);
  const sourceUpdatedAt = new Date(pr.updatedAt);

  const lifecycleClaim = await claimPullRequestLifecycle(db, pr.githubPrId, {
    now: options.now,
    leaseMs: options.lifecycleLeaseMs,
  });
  if (!lifecycleClaim) {
    throw new PullRequestLifecycleBusyError(
      pr.githubPrId,
      leaseWaitMs(
        await pullRequestLifecycleClaimedAt(db, pr.githubPrId),
        options.lifecycleLeaseMs ?? PULL_REQUEST_LIFECYCLE_LEASE_MS,
        options.now ?? new Date(),
      ),
    );
  }

  try {
    const existing = await findByGithubPrId(db, pr.githubPrId);
    const state = nextState(existing?.currentState, claim);

    const source = await applyPullRequestSource(db, {
      repoFullName,
      number: pr.number,
      githubPrId: pr.githubPrId,
      currentState: state,
      headSha: pr.headSha, // refreshed on opened/synchronize (U7 mapping)
      sourceUpdatedAt,
      sourceArrivalKey: options.sourceArrivalKey,
    });
    if (!source.sourceAccepted) {
      logger.info("stale PR lifecycle event ignored", {
        githubPrId: pr.githubPrId,
        incomingUpdatedAt: pr.updatedAt,
        incomingArrivalKey: options.sourceArrivalKey,
        storedUpdatedAt: source.row.sourceUpdatedAt?.toISOString(),
        storedArrivalKey: source.row.sourceArrivalKey,
      });
      return { sourceAccepted: false, skippedShipped: false, skippedMergeComment: false };
    }
    const row = source.row;

    let current = row;
    let channelCreated = false;
    let rootReconciled = false;
    // Persist the channel immediately so a root-post failure cannot orphan it.
    if (!row.channelId) {
      const name = channelName({
        version: CURRENT_CHANNEL_NAME_VERSION,
        state: row.currentState,
        repoFullName: row.repoFullName,
        number: row.number,
        title: pr.title,
        author: pr.author.login,
      });
      let channelId: string;
      try {
        channelId = await slack.createChannel(name);
      } catch (error) {
        // conversations.create can succeed remotely and fail locally, or a
        // retry can receive name_taken. Exact deterministic-name lookup
        // recovers only the intended PR channel. The lookup pages through every
        // public channel, so it runs only when the channel may exist.
        if (!createMayHaveSucceeded(error)) throw error;
        const recovered = await slack.findChannelByName(name);
        if (!recovered) throw error;
        channelId = recovered;
        logger.info("channel creation recovered by exact name", { prId: row.id, channelId, name });
      }
      await setChannel(db, row.id, channelId, null, CURRENT_CHANNEL_NAME_VERSION);
      current = {
        ...row,
        channelId,
        rootMessageTs: null,
        channelNameVersion: CURRENT_CHANNEL_NAME_VERSION,
      };
      channelCreated = true;
      logger.info("channel created", { prId: row.id, channelId, state: row.currentState });

      // Best-effort: a topic failure (e.g. missing scope) must not block the flow.
      try {
        await slack.setTopic(channelId, channelTopic(view));
      } catch (error) {
        logger.warn("failed to set channel topic", {
          prId: row.id,
          err: errMessage(error),
        });
      }
    }

    const channelId = current.channelId;
    if (!channelId) throw new Error(`PR channel mapping is missing for ${current.id}`);

    // A channel whose last applied state is terminal is archived in Slack, and
    // posting to an archived channel throws `is_archived` (which, unlike
    // `not_in_channel`, is not auto-recovered). If this event keeps the PR
    // terminal, skip every channel write below; if it revives the PR (e.g.
    // reopened), unarchive up front so the writes that precede the reconciliation
    // block don't hit an archived channel.
    const wasArchived = Boolean(current.appliedState && isTerminal(current.appliedState));
    const stayingArchived = wasArchived && isTerminal(current.currentState);
    if (wasArchived && !isTerminal(current.currentState)) {
      await slack.unarchive(channelId);
    }

    if (!current.rootMessageTs && !stayingArchived) {
      rootReconciled = true;
      const root = await ledger.deliver(
        keys.root(current.id),
        channelSink(slack, channelId),
        async () => ({ message: { kind: "root", pr: view } }),
      );
      await setChannel(db, current.id, channelId, root.ts);
      current = { ...current, rootMessageTs: root.ts };
    }

    // Invite the PR author into their channel. Idempotent per author, and
    // retryable across events, so an author who links their account after
    // opening still gets pulled in on the next PR event.
    const authorSlackId = await resolveSlackUser(deps, {
      githubId: pr.author.id,
      login: pr.author.login,
    });
    if (authorSlackId && !stayingArchived) {
      const prId = current.id;
      await ledger.deliver(
        keys.authorInvite(prId, pr.author.id),
        channelSink(slack, channelId),
        async () => ({
          message: {
            kind: "author_invite",
            authorLogin: pr.author.login,
            authorLabel: await displayName(slack, authorSlackId, pr.author.login),
          },
          beforePost: () =>
            inviteToChannel(deps, channelId, [authorSlackId], { prId, role: "author" }),
        }),
      );
    }

    const desiredState = current.currentState;
    const desiredChannelName = channelName({
      // Reuse the scheme stamped at creation: legacy rows default to v1 (no
      // author), so their names never churn into v2, while new rows use v2.
      version: current.channelNameVersion,
      state: desiredState,
      repoFullName: current.repoFullName,
      number: current.number,
      title: pr.title,
      author: pr.author.login,
    });
    const needsSlackReconciliation =
      current.appliedState !== desiredState || current.appliedChannelName !== desiredChannelName;
    const shouldPostLifecycle =
      !channelCreated &&
      !rootReconciled &&
      claim.kind === "asserted" &&
      Boolean(current.rootMessageTs);

    // A closed/merged PR never needs a reminder. Cancel independently of Slack
    // reconciliation so a Slack failure can't leave a reminder live and fire a
    // review ping after the PR is already done.
    if (isTerminal(desiredState)) {
      await cancelForPr(db, current.id, sourceUpdatedAt, options.sourceArrivalKey ?? "");
    }

    // Default true: the webhook path announces a merge. Late reconciliation opts out.
    const announceMerge = options.announceMerge !== false;
    let skippedShipped = false;
    let skippedMergeComment = false;

    if (needsSlackReconciliation) {
      // Either side being terminal can mean the real channel is archived after a
      // partial prior attempt. Make it writable before the idempotent rename.
      if (isTerminal(desiredState) || (current.appliedState && isTerminal(current.appliedState))) {
        await slack.unarchive(channelId);
      }
      await slack.rename(channelId, desiredChannelName); // rename first, always (KTD8)

      // Terminal channels must still be writable when the lifecycle note is
      // posted. A retry reuses its durable message effect before archiving.
      if (shouldPostLifecycle) {
        await postLifecycleNote(ledger, slack, current, change, view, desiredState, channelId);
      }

      if (isTerminal(desiredState)) {
        // Before archiving, make members who authorized us leave on their own
        // token so Slack sends no "archived the channel" notification. This is
        // best-effort and must never throw — archiving is the critical outcome
        // and precedes the optional merge announcements so a later failure can
        // never leave the channel un-archived. Reminders were cancelled above.
        if (deps.quietArchive) await deps.quietArchive(channelId);
        await slack.archive(channelId);

        // Merge announcements are best-effort — a failure here must never throw,
        // or it would block archiving and endlessly retry the reconciliation.
        // A late catch-up skips both; rename, archive, reminder cancel, and the
        // database update above and below still run.
        if (desiredState === "merged" && !announceMerge) {
          if (deps.shippedChannel) {
            skippedShipped = true;
            logger.info("skipped #shipped note", {
              prId: current.id,
              repoFullName: current.repoFullName,
              number: current.number,
            });
          }
          if (deps.commentOnMerge) {
            skippedMergeComment = true;
            logger.info("skipped merge comment", {
              prId: current.id,
              repoFullName: current.repoFullName,
              number: current.number,
            });
          }
        } else if (desiredState === "merged") {
          try {
            await notifyShipped(
              { db, slack, logger, shippedChannel: deps.shippedChannel },
              {
                prId: current.id,
                pr: { ...view, repo: current.repoFullName, number: current.number },
                authorLabel: () => displayName(slack, authorSlackId, pr.author.login),
              },
            );
          } catch (err) {
            logger.warn("merge announcement to #shipped failed", {
              prId: current.id,
              err: errMessage(err),
            });
          }

          // Opt-in ONE-WAY-BOUNDARY EXCEPTION: post the Slack channel URL back to
          // the PR for context. Claimed atomically so it posts at most once.
          if (deps.commentOnMerge && deps.postPrComment && deps.slackTeamId) {
            try {
              if (await claimMergeComment(db, current.id, options.now ?? new Date())) {
                const url = slackChannelUrl(deps.slackTeamId, channelId);
                await deps.postPrComment(
                  current.repoFullName,
                  current.number,
                  `💬 Slack discussion for this PR: ${url}`,
                );
                logger.info("posted merge comment to PR", {
                  prId: current.id,
                  number: current.number,
                });
              }
            } catch (err) {
              await releaseMergeComment(db, current.id);
              logger.warn("merge comment to GitHub failed", {
                prId: current.id,
                err: errMessage(err),
              });
            }
          } else if (desiredState === "merged" && deps.commentOnMerge) {
            // Enabled but a dependency is missing — surface it instead of silently no-op.
            logger.warn("merge comment enabled but not configured", {
              prId: current.id,
              hasCommenter: Boolean(deps.postPrComment),
              hasSlackTeamId: Boolean(deps.slackTeamId),
            });
          }
        }
      }
      await markSlackStateApplied(db, current.id, desiredState, desiredChannelName);
      logger.info("channel state reconciled", {
        prId: current.id,
        from: current.appliedState,
        to: desiredState,
        channelName: desiredChannelName,
      });
    }

    // Thread a lifecycle note under the root for notable transitions. Never post
    // to a channel that is (and stays) archived — that throws is_archived.
    if (shouldPostLifecycle && !needsSlackReconciliation && !stayingArchived) {
      await postLifecycleNote(ledger, slack, current, change, view, desiredState, channelId);
    }
    return { sourceAccepted: true, skippedShipped, skippedMergeComment };
  } finally {
    if (!(await releasePullRequestLifecycle(db, lifecycleClaim))) {
      logger.error("PR lifecycle lease was lost before release", { githubPrId: pr.githubPrId });
    }
  }
}

/**
 * A failed `conversations.create` may still have left the channel in Slack when
 * Slack said `name_taken` or when no usable response arrived. A rate limit or
 * any other Slack error means nothing was created.
 */
function createMayHaveSucceeded(error: unknown): boolean {
  return error instanceof SlackApiError && (error.ambiguous || error.code === "name_taken");
}

async function postLifecycleNote(
  ledger: Ledger,
  slack: SlackGateway,
  row: { id: PrId; rootMessageTs: string | null },
  change: PrChange,
  view: PrView,
  state: PrState,
  channelId: string,
): Promise<void> {
  if (!row.rootMessageTs) return;
  await ledger.deliver(
    keys.lifecycle(row.id, change.action, state, change.pr.headSha, change.pr.updatedAt),
    channelSink(slack, channelId),
    async () => ({ message: { kind: "lifecycle", pr: view, action: change.action, state } }),
  );
}

export async function ensurePullRequestChannel(deps: PrHandlerDeps, pr: PrSnapshot) {
  let row = await findByRepoNumber(deps.db, pr.repo, pr.number);
  if (!row?.channelId || !row.rootMessageTs) {
    await handlePullRequest(deps, { action: "synchronize", pr, merged: false });
    row = await findByRepoNumber(deps.db, pr.repo, pr.number);
  }
  if (!row?.channelId || !row.rootMessageTs) {
    throw new Retry(`PR channel is not ready for ${pr.repo}#${pr.number}`);
  }
  return { ...row, channelId: row.channelId, rootMessageTs: row.rootMessageTs };
}
