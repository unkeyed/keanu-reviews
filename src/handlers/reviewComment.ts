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
import {
  type PrHandlerDeps,
  type PullRequestPayload,
  ensurePullRequestChannel,
} from "./pullRequest.ts";

export interface ReviewCommentPayload {
  action: string;
  repository: { full_name: string };
  pull_request: PullRequestPayload["pull_request"];
  comment: {
    id: number;
    commit_id: string;
    path: string;
    line: number | null;
    start_line?: number | null;
    // Present when this comment is a reply within an existing review thread.
    in_reply_to_id?: number | null;
    body: string;
    html_url: string;
    user: { id: number; login: string; type?: string };
  };
}

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
  payload: ReviewCommentPayload,
): Promise<void> {
  // `created` mirrors, `edited` syncs the body, `deleted` removes the mirror (R4);
  // other actions (resolved, …) are ignored.
  if (!["created", "edited", "deleted"].includes(payload.action)) return;
  if (shouldSkipActor(payload.comment.user, deps.allowedBots)) return; // skip non-allowed bots

  // A deletion removes the mirror without ever creating a channel.
  if (payload.action === "deleted") {
    await deleteMirroredComment(deps, {
      repoFullName: payload.repository.full_name,
      number: payload.pull_request.number,
      key: (prId) => keys.reviewComment(prId, payload.comment.id),
      user: payload.comment.user,
    });
    return;
  }

  // The PR author's inline replies ARE mirrored — replying to review feedback is
  // the core channel conversation.
  const row = await ensurePullRequestChannel(deps, payload.repository, payload.pull_request);
  const channelId = row.channelId;

  const c = payload.comment;
  const ledger = createLedger(deps.db);

  // Thread a reply under the Slack message of the comment it replies to; a
  // thread-starting comment posts top-level. THREAD_COMMENTS=false keeps all
  // comments flat (top-level).
  const threadTs =
    deps.threadComments !== false && c.in_reply_to_id != null
      ? await ledger.sentTs(keys.reviewComment(row.id, c.in_reply_to_id)) // unmirrored -> top-level
      : undefined;

  // Author as the commenter: their own token when they've authorized it, else the
  // bot spoofing their name/avatar, else the bot with a plain "by <login>" label.
  const enrich = async () => {
    const author = await resolveMessageAuthor(deps, c.user);
    const images = await commentImages(deps, c.body, c.user);
    const message: Message = {
      kind: "review_comment",
      path: c.path,
      line: c.line,
      body: c.body,
      // The PR discussion permalink, not the file/line blob view.
      url: c.html_url,
      label: author.name ? undefined : c.user.login,
      images,
    };
    return { author, message };
  };

  // An edit updates the already-mirrored message in place; otherwise post it (a
  // first-seen comment, or an edit that arrived before we ever mirrored it).
  const key = keys.reviewComment(row.id, c.id);
  const sentTs = payload.action === "edited" ? await ledger.sentTs(key) : undefined;
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
  await inviteMentionedUsers(deps, channelId, c.body, payload.pull_request.user.login);
}
