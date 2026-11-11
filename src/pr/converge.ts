import type { Db } from "#db";
import { type PrSnapshot, nextState } from "#events";
import type { GithubEmailFetcher, PrCommenter } from "#github";
import { displayName, resolveSlackUser } from "#identity";
import { type Logger, errMessage } from "#lib";
import { cancelForPr } from "#reminders";
import {
  CURRENT_CHANNEL_NAME_VERSION,
  type PrView,
  SlackApiError,
  type SlackGateway,
  channelSink,
  channelTopic,
  createLedger,
  keys,
  slackChannelUrl,
} from "#slack";
import { inviteToChannel } from "./invite.ts";
import { type ChannelStep, type ConvergeCause, causeClaim, planChannel } from "./plan.ts";
import { notifyShipped } from "./shipped.ts";
import {
  type PrRow,
  applyPullRequestSource,
  claimMergeComment,
  findByGithubPrId,
  markSlackStateApplied,
  releaseMergeComment,
  setChannel,
} from "./store.ts";

export interface PrDeps {
  db: Db;
  slack: SlackGateway;
  logger: Logger;
  /** GitHub email lookup, so the author resolves past the identity map. */
  fetchGithubEmail?: GithubEmailFetcher;
  /** #shipped channel (id or name) that announces merges; unset disables it. */
  shippedChannel?: string;
  /** Opt-in: comment the Slack channel URL on the PR when it merges. */
  commentOnMerge?: boolean;
  postPrComment?: PrCommenter;
  /** Slack workspace id for the merge comment's channel deep link. */
  slackTeamId?: string;
  /**
   * Members who authorized us leave on their own token before an archive, so
   * Slack sends no "archived the channel" notice. Best-effort; never throws.
   * Unset when Slack user OAuth is not configured.
   */
  quietArchive?: (channelId: string) => Promise<void>;
}

export interface ConvergeOutcome {
  /** False when a newer snapshot was already applied, so nothing ran. */
  accepted: boolean;
  /** A configured #shipped note was not posted. */
  skippedShipped: boolean;
  /** A configured merge comment was not posted. */
  skippedMergeComment: boolean;
}

/**
 * Store the snapshot behind the source-order guard, then bring the channel to
 * the stored state. Runs under the PR lifecycle lease.
 */
export async function converge(
  deps: PrDeps,
  snapshot: PrSnapshot,
  cause: ConvergeCause,
): Promise<ConvergeOutcome> {
  const { db, logger } = deps;
  const existing = await findByGithubPrId(db, snapshot.githubPrId);
  const arrivalKey = cause.kind === "child" ? undefined : cause.arrivalKey;
  const source = await applyPullRequestSource(db, {
    repoFullName: snapshot.repo,
    number: snapshot.number,
    githubPrId: snapshot.githubPrId,
    currentState: nextState(existing?.currentState, causeClaim(cause, snapshot)),
    headSha: snapshot.headSha,
    sourceUpdatedAt: new Date(snapshot.updatedAt),
    sourceArrivalKey: arrivalKey,
  });
  if (!source.sourceAccepted) {
    logger.info("stale PR lifecycle event ignored", {
      githubPrId: snapshot.githubPrId,
      incomingUpdatedAt: snapshot.updatedAt,
      incomingArrivalKey: arrivalKey,
      storedUpdatedAt: source.row.sourceUpdatedAt?.toISOString(),
      storedArrivalKey: source.row.sourceArrivalKey,
    });
    return { accepted: false, skippedShipped: false, skippedMergeComment: false };
  }
  const steps = planChannel(source.row, snapshot, cause, {
    shipped: Boolean(deps.shippedChannel),
    commentOnMerge: Boolean(deps.commentOnMerge),
    quietLeave: Boolean(deps.quietArchive),
  });
  return execute(deps, source.row, snapshot, cause, steps);
}

async function execute(
  deps: PrDeps,
  row: PrRow,
  snapshot: PrSnapshot,
  cause: ConvergeCause,
  steps: readonly ChannelStep[],
): Promise<ConvergeOutcome> {
  const { db, slack, logger } = deps;
  const ledger = createLedger(db);
  const view: PrView = {
    repo: snapshot.repo,
    number: snapshot.number,
    title: snapshot.title,
    url: snapshot.url,
    authorLogin: snapshot.author.login,
    headRef: snapshot.headRef,
    baseRef: snapshot.baseRef,
  };
  const outcome: ConvergeOutcome = {
    accepted: true,
    skippedShipped: false,
    skippedMergeComment: false,
  };
  const fields = { prId: row.id, repoFullName: row.repoFullName, number: row.number };
  let channelId = row.channelId;
  let authorSlackId: string | undefined;
  const channel = () => {
    if (!channelId) throw new Error(`PR channel mapping is missing for ${row.id}`);
    return channelId;
  };

  for (const step of steps) {
    switch (step.kind) {
      case "create":
        channelId = await createChannel(deps, row, step.name, view);
        break;
      case "unarchive":
        await slack.unarchive(channel());
        break;
      case "post-root": {
        const root = await ledger.deliver(
          keys.root(row.id),
          channelSink(slack, channel()),
          async () => ({ message: { kind: "root", pr: view } }),
        );
        await setChannel(db, row.id, channel(), root.ts);
        break;
      }
      case "resolve-author":
        authorSlackId = await resolveSlackUser(deps, {
          githubId: snapshot.author.id,
          login: snapshot.author.login,
        });
        break;
      case "invite-author": {
        const slackUserId = authorSlackId;
        if (!slackUserId) break;
        const channelIdNow = channel();
        await ledger.deliver(
          keys.authorInvite(row.id, snapshot.author.id),
          channelSink(slack, channelIdNow),
          async () => ({
            message: {
              kind: "author_invite",
              authorLogin: snapshot.author.login,
              authorLabel: await displayName(slack, slackUserId, snapshot.author.login),
            },
            beforePost: () =>
              inviteToChannel(deps, channelIdNow, [slackUserId], { prId: row.id, role: "author" }),
          }),
        );
        break;
      }
      case "cancel-reminders":
        await cancelForPr(
          db,
          row.id,
          new Date(snapshot.updatedAt),
          cause.kind === "child" ? "" : cause.arrivalKey,
        );
        break;
      case "rename":
        await slack.rename(channel(), step.name);
        break;
      case "lifecycle-note":
        await ledger.deliver(
          keys.lifecycle(row.id, step.action, step.state, snapshot.headSha, snapshot.updatedAt),
          channelSink(slack, channel()),
          async () => ({
            message: { kind: "lifecycle", pr: view, action: step.action, state: step.state },
          }),
        );
        break;
      case "quiet-leave":
        await deps.quietArchive?.(channel());
        break;
      case "archive":
        await slack.archive(channel());
        break;
      case "announce-shipped":
        try {
          await notifyShipped(deps, {
            prId: row.id,
            pr: { ...view, repo: row.repoFullName, number: row.number },
            authorLabel: () => displayName(slack, authorSlackId, snapshot.author.login),
          });
        } catch (err) {
          logger.warn("merge announcement to #shipped failed", {
            prId: row.id,
            err: errMessage(err),
          });
        }
        break;
      case "comment-on-merge":
        await commentOnMerge(deps, row, channel());
        break;
      case "skip-announcements":
        if (step.shipped) {
          outcome.skippedShipped = true;
          logger.info("skipped #shipped note", fields);
        }
        if (step.mergeComment) {
          outcome.skippedMergeComment = true;
          logger.info("skipped merge comment", fields);
        }
        break;
      case "mark-applied":
        await markSlackStateApplied(db, row.id, step.state, step.name);
        logger.info("channel state reconciled", {
          prId: row.id,
          from: step.from,
          to: step.state,
          channelName: step.name,
        });
        break;
    }
  }
  return outcome;
}

/** Create the channel and persist its id at once, so a later failure cannot orphan it. */
async function createChannel(
  deps: PrDeps,
  row: PrRow,
  name: string,
  view: PrView,
): Promise<string> {
  const { db, slack, logger } = deps;
  let channelId: string;
  try {
    channelId = await slack.createChannel(name);
  } catch (error) {
    // conversations.create can succeed remotely and fail locally, or a retry
    // can receive name_taken. The exact deterministic name recovers only the
    // intended PR channel. The lookup pages through every public channel, so it
    // runs only when the channel may exist.
    if (!createMayHaveSucceeded(error)) throw error;
    const recovered = await slack.findChannelByName(name);
    if (!recovered) throw error;
    channelId = recovered;
    logger.info("channel creation recovered by exact name", { prId: row.id, channelId, name });
  }
  await setChannel(db, row.id, channelId, null, CURRENT_CHANNEL_NAME_VERSION);
  logger.info("channel created", { prId: row.id, channelId, state: row.currentState });

  // A topic failure (e.g. a missing scope) must not block the channel.
  try {
    await slack.setTopic(channelId, channelTopic(view));
  } catch (error) {
    logger.warn("failed to set channel topic", { prId: row.id, err: errMessage(error) });
  }
  return channelId;
}

/**
 * Slack may have created the channel when it said `name_taken` or when no
 * usable response arrived. A rate limit or any other Slack error means it did not.
 */
function createMayHaveSucceeded(error: unknown): boolean {
  return error instanceof SlackApiError && (error.ambiguous || error.code === "name_taken");
}

/**
 * The one write back to GitHub: the channel URL as a PR comment, claimed so it
 * posts at most once and released on failure so a retry can post it.
 * Best-effort: a failure never blocks the archive that already happened.
 */
async function commentOnMerge(deps: PrDeps, row: PrRow, channelId: string): Promise<void> {
  const { db, logger, postPrComment, slackTeamId } = deps;
  if (!postPrComment || !slackTeamId) {
    logger.warn("merge comment enabled but not configured", {
      prId: row.id,
      hasCommenter: Boolean(postPrComment),
      hasSlackTeamId: Boolean(slackTeamId),
    });
    return;
  }
  try {
    if (await claimMergeComment(db, row.id, new Date())) {
      const url = slackChannelUrl(slackTeamId, channelId);
      await postPrComment(row.repoFullName, row.number, `💬 Slack discussion for this PR: ${url}`);
      logger.info("posted merge comment to PR", { prId: row.id, number: row.number });
    }
  } catch (err) {
    await releaseMergeComment(db, row.id);
    logger.warn("merge comment to GitHub failed", { prId: row.id, err: errMessage(err) });
  }
}
