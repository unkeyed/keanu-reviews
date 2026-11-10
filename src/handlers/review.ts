import { Retry } from "#lib";
import { type Message, cleanGithubMarkdown, createLedger, keys } from "#slack";
import { findByRepoNumber } from "../db/repositories/pullRequests.ts";
import { isBotActor, shouldSkipActor } from "../github/actors.ts";
import { commentImages } from "../github/attachments.ts";
import {
  deleteMirroredComment,
  deliverAuthored,
  resolveMessageAuthor,
  updateAuthoredMessage,
} from "./authorship.ts";
import { inviteMentionedUsers } from "./mentions.ts";
import {
  type PrHandlerDeps,
  type PullRequestPayload,
  ensurePullRequestChannel,
} from "./pullRequest.ts";
import { sourceDate } from "./reviewRequest.ts";

export interface ReviewDeps extends PrHandlerDeps {
  /** U8 wires this to cancel a reviewer's pending reminder once they review. */
  onReviewSubmitted?: (
    prId: string,
    reviewerGithubId: number,
    sourceUpdatedAt?: Date,
    sourceVersion?: string,
  ) => Promise<void>;
}

export interface ReviewPayload {
  action: string;
  repository: { full_name: string };
  pull_request: PullRequestPayload["pull_request"];
  review: {
    id: number;
    state: string; // approved | changes_requested | commented
    body: string | null;
    html_url: string;
    submitted_at?: string;
    user: { id: number; login: string; type?: string };
  };
}

/** Mirror a review submission (U6, R5) and cancel the reviewer's reminder (U8 hook). */
export async function handleReview(
  deps: ReviewDeps,
  payload: ReviewPayload,
  sourceVersion = String(payload.review.id),
): Promise<void> {
  if (payload.action !== "submitted") return;
  if (shouldSkipActor(payload.review.user, deps.allowedBots)) return; // skip non-allowed bots
  const row = await ensurePullRequestChannel(deps, payload.repository, payload.pull_request);
  const channelId = row.channelId;

  const r = payload.review;
  // GitHub is the source of truth: cancel before enrichment or Slack delivery,
  // so a downstream failure cannot leave an obsolete reminder live.
  const reviewedAt = sourceDate(r.submitted_at ?? payload.pull_request.updated_at);
  // Cancels the reminder. A later check_run sees that cancellation and does not
  // send the review-needed alert.
  await deps.onReviewSubmitted?.(row.id, r.user.id, reviewedAt, sourceVersion);
  await deliverAuthored(deps, keys.review(row.id, r.id), channelId, async () => {
    const author = await resolveMessageAuthor(deps, r.user);
    const images = await commentImages(deps, r.body ?? "", r.user);
    // A "commented" review with no text or images after cleaning is just the
    // wrapper GitHub emits around inline review comments, which arrive as
    // review_comment events. Posting it would be an empty "💬 commented by …"
    // line, so nothing is posted (the reminder is still cancelled above).
    const isEmptyCommentWrapper =
      r.state === "commented" && !cleanGithubMarkdown(r.body ?? "") && images.length === 0;
    return {
      author,
      outgoing: (mode) =>
        isEmptyCommentWrapper
          ? null
          : {
              // Thread bot reviews under the PR root to keep the channel readable.
              threadTs: isBotActor(r.user) ? (row.rootMessageTs ?? undefined) : undefined,
              message: {
                kind: "review",
                authorLogin: r.user.login,
                state: r.state,
                body: r.body ?? "",
                url: r.html_url,
                // Never ping the reviewer for their own review activity; a bot
                // post shows their Slack display name as plain text instead.
                label: mode === "user" ? undefined : (author.name ?? r.user.login),
                images,
              },
            },
    };
  });

  // Pull anyone @-mentioned in the review body into the channel (best-effort).
  // The PR author is skipped — already a member of their own channel.
  await inviteMentionedUsers(deps, channelId, r.body ?? "", payload.pull_request.user.login);
}

export interface IssueCommentPayload {
  action: string;
  repository: { full_name: string };
  // `issue.user` is the PR opener (issues and PRs share the same payload shape).
  issue: { number: number; pull_request?: unknown; user?: { login: string } };
  comment: {
    id: number;
    body: string;
    html_url: string;
    user: { id: number; login: string; type?: string };
  };
}

/** Mirror a PR conversation comment (U6). Ignored for non-PR issues. */
export async function handleIssueComment(
  deps: ReviewDeps,
  payload: IssueCommentPayload,
): Promise<void> {
  // `created` mirrors, `edited` syncs the body, `deleted` removes the mirror;
  // other actions are ignored.
  if (!["created", "edited", "deleted"].includes(payload.action)) return;
  if (!payload.issue.pull_request) return; // not a PR — ignore
  // Skip bot comments (Vercel/Mintlify deploy previews, our own merge comment, …)
  // unless allow-listed. `type: "Bot"` covers our App's bot, so this also guards
  // against echoing our own merge comment (never allow-list our App's login).
  if (shouldSkipActor(payload.comment.user, deps.allowedBots)) return;

  // A deletion removes the mirror without ever creating a channel.
  if (payload.action === "deleted") {
    await deleteMirroredComment(deps, {
      repoFullName: payload.repository.full_name,
      number: payload.issue.number,
      key: (prId) => keys.issueComment(prId, payload.comment.id),
      user: payload.comment.user,
    });
    return;
  }

  const row = await findByRepoNumber(deps.db, payload.repository.full_name, payload.issue.number);
  if (!row?.channelId) {
    throw new Retry(
      `PR channel is not ready for ${payload.repository.full_name}#${payload.issue.number}`,
    );
  }
  const channelId = row.channelId;

  const c = payload.comment;
  // Author as the commenter: their own token when authorized, else the bot
  // spoofing their name/avatar, else the bot with a plain "by <login>" label. PR
  // conversation comments aren't threaded on GitHub, so they post top-level.
  const enrich = async () => {
    const author = await resolveMessageAuthor(deps, c.user);
    const images = await commentImages(deps, c.body, c.user);
    const message: Message = {
      kind: "issue_comment",
      authorLogin: c.user.login,
      body: c.body,
      url: c.html_url,
      label: author.name ? undefined : c.user.login,
      images,
    };
    return { author, message };
  };

  // An edit updates the mirrored message in place; otherwise post it.
  const key = keys.issueComment(row.id, c.id);
  const sentTs = payload.action === "edited" ? await createLedger(deps.db).sentTs(key) : undefined;
  if (sentTs) {
    const { author, message } = await enrich();
    await updateAuthoredMessage(deps, sentTs, channelId, author, () => message);
  } else {
    await deliverAuthored(deps, key, channelId, async () => {
      const { author, message } = await enrich();
      return {
        author,
        outgoing: (mode) => ({
          message,
          poster:
            mode === "bot"
              ? { kind: "bot-as", username: author.name, iconUrl: author.iconUrl }
              : undefined,
        }),
      };
    });
  }

  // Pull anyone @-mentioned in the comment into the channel (best-effort). Runs
  // on edits too, so a newly added mention still pulls that person in. The PR
  // author is skipped — already a member of their own channel.
  await inviteMentionedUsers(deps, channelId, c.body, payload.issue.user?.login);
}
