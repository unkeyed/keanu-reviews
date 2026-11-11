import type { Db } from "#db";
import { type GithubActor, type PrSnapshot, isTerminal, nextState } from "#events";
import type { GithubEmailFetcher, PrCommenter } from "#github";
import { displayName, resolveSlackUser } from "#identity";
import { type Logger, errMessage } from "#lib";
import { cancelForPr } from "#reminders";
import {
  CURRENT_CHANNEL_NAME_VERSION,
  type PrView,
  SlackApiError,
  type SlackGateway,
  channelTopic,
  createLedger,
  keys,
  slackChannelUrl,
} from "#slack";
import { prChannel } from "./channel.ts";
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
  fetchGithubEmail: GithubEmailFetcher;
  shippedChannel: string | undefined;
  postPrComment: PrCommenter | undefined;
  slackTeamId: string;
  quietArchive: ((channelId: string) => Promise<void>) | undefined;
}

export interface ConvergeOutcome {
  accepted: boolean;
  skippedShipped: boolean;
  skippedMergeComment: boolean;
}

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
  const steps = planChannel(source.row, snapshot, cause, features(deps));
  return execute(deps, source.row, snapshot, cause, steps);
}

export async function followNewerSnapshot(deps: PrDeps, snapshot: PrSnapshot): Promise<void> {
  const { db, logger } = deps;
  const row = await findByGithubPrId(db, snapshot.githubPrId);
  if (!row?.channelId || !row.rootMessageTs || isTerminal(row.currentState)) return;
  if (!row.sourceUpdatedAt || Date.parse(snapshot.updatedAt) <= row.sourceUpdatedAt.getTime()) {
    return;
  }
  const cause = { kind: "child" } as const;
  const currentState = nextState(row.currentState, causeClaim(cause, snapshot));
  const steps = planChannel({ ...row, currentState }, snapshot, cause, features(deps));
  if (!steps.some((step) => step.kind === "mark-applied")) return;
  try {
    const { row: stored } = await applyPullRequestSource(db, {
      repoFullName: row.repoFullName,
      number: row.number,
      githubPrId: row.githubPrId,
      currentState,
    });
    await execute(deps, stored, snapshot, cause, steps);
  } catch (err) {
    logger.warn("PR channel did not follow a newer PR snapshot", {
      prId: row.id,
      githubPrId: snapshot.githubPrId,
      err: errMessage(err),
    });
  }
}

function features(deps: PrDeps) {
  return {
    shipped: Boolean(deps.shippedChannel),
    commentOnMerge: Boolean(deps.postPrComment),
    quietLeave: Boolean(deps.quietArchive),
  };
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
          prChannel(deps, channel()),
          async () => ({ message: { kind: "root", pr: view } }),
        );
        if (root.status === "tombstoned") throw new Error(`PR root was tombstoned: ${row.id}`);
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
        const sink = prChannel(deps, channel());
        await ledger.deliver(keys.authorInvite(row.id, snapshot.author.id), sink, async () => ({
          message: {
            kind: "author_invite",
            authorLogin: snapshot.author.login,
            authorLabel: await displayName(deps, slackUserId, snapshot.author.login),
          },
          beforePost: () => sink.invite([slackUserId], { prId: row.id, role: "author" }),
        }));
        break;
      }
      case "cancel-reminders":
        await cancelForPr(db, row.id, {
          updatedAt: new Date(snapshot.updatedAt),
          version: cause.kind === "child" ? "" : cause.arrivalKey,
        });
        break;
      case "rename":
        await slack.rename(channel(), step.name);
        break;
      case "lifecycle-note":
        await ledger.deliver(
          keys.lifecycle(row.id, step.action, step.state, snapshot.headSha, snapshot.updatedAt),
          prChannel(deps, channel()),
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
            authorLabel: () => displayName(deps, authorSlackId, snapshot.author.login),
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
    if (!createMayHaveSucceeded(error)) throw error;
    const recovered = await slack.findChannelByName(name);
    if (!recovered) throw error;
    channelId = recovered;
    logger.info("channel creation recovered by exact name", { prId: row.id, channelId, name });
  }
  await setChannel(db, row.id, channelId, null, CURRENT_CHANNEL_NAME_VERSION);
  logger.info("channel created", { prId: row.id, channelId, state: row.currentState });

  try {
    await slack.setTopic(channelId, channelTopic(view));
  } catch (error) {
    logger.warn("failed to set channel topic", { prId: row.id, err: errMessage(error) });
  }
  return channelId;
}

function createMayHaveSucceeded(error: unknown): boolean {
  return error instanceof SlackApiError && (error.ambiguous || error.code === "name_taken");
}

const MERGE_COMMENT_LEAD = "💬 Slack discussion for this PR: ";

export const mergeCommentBody = (channelUrl: string) => `${MERGE_COMMENT_LEAD}${channelUrl}`;

export const isMergeComment = (author: Pick<GithubActor, "isBot">, body: string) =>
  author.isBot && body.startsWith(MERGE_COMMENT_LEAD);

async function commentOnMerge(deps: PrDeps, row: PrRow, channelId: string): Promise<void> {
  const { db, logger, postPrComment, slackTeamId } = deps;
  if (!postPrComment) return;
  try {
    if (await claimMergeComment(db, row.id, new Date())) {
      const url = slackChannelUrl(slackTeamId, channelId);
      await postPrComment(row.repoFullName, row.number, mergeCommentBody(url));
      logger.info("posted merge comment to PR", { prId: row.id, number: row.number });
    }
  } catch (err) {
    await releaseMergeComment(db, row.id);
    logger.warn("merge comment to GitHub failed", { prId: row.id, err: errMessage(err) });
  }
}
