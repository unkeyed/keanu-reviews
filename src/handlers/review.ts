import type { IssueCommentEvent, ReviewEvent } from "#events";
import { shouldSkipActor } from "#github";
import { type PrId, Retry } from "#lib";
import { type PrSession, findByRepoNumber, session } from "#pr";
import { type Message, cleanGithubMarkdown, createLedger, keys } from "#slack";
import {
  commentImages,
  deleteMirroredComment,
  deliverAuthored,
  resolveMessageAuthor,
  updateAuthoredMessage,
} from "./authorship.ts";
import type { PrHandlerDeps } from "./deps.ts";
import { inviteMentionedUsers } from "./mentions.ts";
import { sourceDate } from "./reviewRequest.ts";

export interface ReviewDeps extends PrHandlerDeps {
  /** U8 wires this to cancel a reviewer's pending reminder once they review. */
  onReviewSubmitted?: (
    prId: PrId,
    reviewerGithubId: number,
    sourceUpdatedAt?: Date,
    sourceVersion?: string,
  ) => Promise<void>;
}

/** Mirror a review submission (U6, R5) and cancel the reviewer's reminder (U8 hook). */
export async function handleReview(
  deps: ReviewDeps,
  ev: ReviewEvent,
  sourceVersion = String(ev.review.id),
): Promise<void> {
  if (shouldSkipActor(ev.review.author, deps.allowedBots)) return; // skip non-allowed bots
  await session(deps, { kind: "snapshot", snapshot: ev.pr, cause: { kind: "child" } }, (s) =>
    mirrorReview(deps, s, ev, sourceVersion),
  );
}

async function mirrorReview(
  deps: ReviewDeps,
  s: PrSession,
  ev: ReviewEvent,
  sourceVersion: string,
): Promise<void> {
  const row = await s.ready();
  const channelId = row.channelId;

  const r = ev.review;
  // GitHub is the source of truth: cancel before enrichment or Slack delivery,
  // so a downstream failure cannot leave an obsolete reminder live.
  const reviewedAt = sourceDate(r.submittedAt ?? ev.pr.updatedAt);
  // Cancels the reminder. A later check_run sees that cancellation and does not
  // send the review-needed alert.
  await deps.onReviewSubmitted?.(row.id, r.author.id, reviewedAt, sourceVersion);
  await deliverAuthored(deps, keys.review(row.id, r.id), channelId, async () => {
    const author = await resolveMessageAuthor(deps, r.author);
    const images = await commentImages(deps, r.body, r.author);
    // A "commented" review with no text or images after cleaning is just the
    // wrapper GitHub emits around inline review comments, which arrive as
    // review_comment events. Posting it would be an empty "💬 commented by …"
    // line, so nothing is posted (the reminder is still cancelled above).
    const isEmptyCommentWrapper =
      r.state === "commented" && !cleanGithubMarkdown(r.body) && images.length === 0;
    return {
      author,
      outgoing: (mode) =>
        isEmptyCommentWrapper
          ? null
          : {
              // Thread bot reviews under the PR root to keep the channel readable.
              threadTs: r.author.isBot ? (row.rootMessageTs ?? undefined) : undefined,
              message: {
                kind: "review",
                authorLogin: r.author.login,
                state: r.state,
                body: r.body,
                url: r.url,
                // Never ping the reviewer for their own review activity; a bot
                // post shows their Slack display name as plain text instead.
                label: mode === "user" ? undefined : (author.name ?? r.author.login),
                images,
              },
            },
    };
  });

  // Pull anyone @-mentioned in the review body into the channel (best-effort).
  // The PR author is skipped — already a member of their own channel.
  await inviteMentionedUsers(deps, channelId, r.body, ev.pr.author.login);
}

/**
 * Mirror a PR conversation comment (U6): `created` mirrors, `edited` syncs the
 * body, `deleted` removes the mirror.
 */
export async function handleIssueComment(deps: ReviewDeps, ev: IssueCommentEvent): Promise<void> {
  // Skip bot comments (Vercel/Mintlify deploy previews, our own merge comment, …)
  // unless allow-listed. `type: "Bot"` covers our App's bot, so this also guards
  // against echoing our own merge comment (never allow-list our App's login).
  if (shouldSkipActor(ev.comment.author, deps.allowedBots)) return;

  // A deletion removes the mirror without ever creating a channel.
  if (ev.action === "deleted") {
    await deleteMirroredComment(deps, {
      repoFullName: ev.repo,
      number: ev.number,
      key: (prId) => keys.issueComment(prId, ev.comment.id),
      user: ev.comment.author,
    });
    return;
  }

  const row = await findByRepoNumber(deps.db, ev.repo, ev.number);
  if (!row?.channelId) {
    throw new Retry(`PR channel is not ready for ${ev.repo}#${ev.number}`);
  }
  const channelId = row.channelId;

  const c = ev.comment;
  // Author as the commenter: their own token when authorized, else the bot
  // spoofing their name/avatar, else the bot with a plain "by <login>" label. PR
  // conversation comments aren't threaded on GitHub, so they post top-level.
  const enrich = async () => {
    const author = await resolveMessageAuthor(deps, c.author);
    const images = await commentImages(deps, c.body, c.author);
    const message: Message = {
      kind: "issue_comment",
      authorLogin: c.author.login,
      body: c.body,
      url: c.url,
      label: author.name ? undefined : c.author.login,
      images,
    };
    return { author, message };
  };

  // An edit updates the mirrored message in place; otherwise post it.
  const key = keys.issueComment(row.id, c.id);
  const sentTs = ev.action === "edited" ? await createLedger(deps.db).sentTs(key) : undefined;
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
  await inviteMentionedUsers(deps, channelId, c.body, ev.prAuthorLogin);
}
