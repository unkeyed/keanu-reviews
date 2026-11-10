import type { ReviewCommentEvent } from "#events";
import { type Message, createLedger, keys } from "#slack";
import { shouldSkipActor } from "../github/actors.ts";
import { commentImages } from "../github/attachments.ts";
import {
  deleteMirroredComment,
  deliverAuthored,
  resolveMessageAuthor,
  updateAuthoredMessage,
} from "./authorship.ts";
import { inviteMentionedUsers } from "./mentions.ts";
import { type PrHandlerDeps, ensurePullRequestChannel } from "./pullRequest.ts";

/**
 * Mirror an inline review comment into the PR channel (U6, R4). Handles the
 * out-of-order case (KTD4): if the comment arrives before the PR's `opened`
 * event, reconcile the channel + root from the comment's embedded pull_request.
 *
 * Threading mirrors GitHub's review threads: a comment that starts a thread is a
 * top-level channel message; a reply (`in_reply_to_id`) is threaded under the
 * Slack message of the comment it replies to. It never threads under the PR root.
 */
export async function handleReviewComment(
  deps: PrHandlerDeps,
  ev: ReviewCommentEvent,
): Promise<void> {
  if (shouldSkipActor(ev.comment.author, deps.allowedBots)) return; // skip non-allowed bots

  // A deletion removes the mirror without ever creating a channel.
  if (ev.action === "deleted") {
    await deleteMirroredComment(deps, {
      repoFullName: ev.pr.repo,
      number: ev.pr.number,
      key: (prId) => keys.reviewComment(prId, ev.comment.id),
      user: ev.comment.author,
    });
    return;
  }

  // The PR author's inline replies ARE mirrored — replying to review feedback is
  // the core channel conversation.
  const row = await ensurePullRequestChannel(deps, ev.pr);
  const channelId = row.channelId;

  const c = ev.comment;
  const ledger = createLedger(deps.db);

  // Thread a reply under the Slack message of the comment it replies to; a
  // thread-starting comment posts top-level. THREAD_COMMENTS=false keeps all
  // comments flat (top-level).
  const threadTs =
    deps.threadComments !== false && c.inReplyTo !== undefined
      ? await ledger.sentTs(keys.reviewComment(row.id, c.inReplyTo)) // unmirrored -> top-level
      : undefined;

  // Author as the commenter: their own token when they've authorized it, else the
  // bot spoofing their name/avatar, else the bot with a plain "by <login>" label.
  const enrich = async () => {
    const author = await resolveMessageAuthor(deps, c.author);
    const images = await commentImages(deps, c.body, c.author);
    const message: Message = {
      kind: "review_comment",
      path: c.path,
      line: c.line,
      body: c.body,
      url: c.url,
      label: author.name ? undefined : c.author.login,
      images,
    };
    return { author, message };
  };

  // An edit updates the already-mirrored message in place; otherwise post it (a
  // first-seen comment, or an edit that arrived before we ever mirrored it).
  const key = keys.reviewComment(row.id, c.id);
  const sentTs = ev.action === "edited" ? await ledger.sentTs(key) : undefined;
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
          threadTs,
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
  // author is skipped — they're already a member of their own channel.
  await inviteMentionedUsers(deps, channelId, c.body, ev.pr.author.login);
}
