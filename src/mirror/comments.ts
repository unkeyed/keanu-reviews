import type { GithubActor, IssueCommentEvent, ReviewCommentEvent } from "#events";
import { shouldSkipActor } from "#github";
import { type PrId, Retry } from "#lib";
import { type PrRow, findByRepoNumber, session } from "#pr";
import { type EffectKey, keys } from "#slack";
import { type MirrorDeps, commentPresentation, removeMirror, upsertAuthored } from "./author.ts";

const locked = (pr: PrRow) => ({ kind: "existing", githubPrId: pr.githubPrId }) as const;

/**
 * Mirror an inline review comment into the PR channel. A comment that arrives
 * before the PR's `opened` event builds the channel and root from the
 * comment's embedded pull_request.
 *
 * Threading follows GitHub's review threads: a comment that starts a thread
 * posts top-level, and a reply is threaded under the Slack message of the
 * comment it replies to, never under the PR root.
 */
export async function onReviewComment(deps: MirrorDeps, ev: ReviewCommentEvent): Promise<void> {
  const c = ev.comment;
  if (shouldSkipActor(c.author, deps.allowedBots)) return;
  if (ev.action === "deleted") {
    return removeStored(deps, ev.pr.repo, ev.pr.number, c.author, (prId) =>
      keys.reviewComment(prId, c.id),
    );
  }
  const action = ev.action;

  // The PR author's inline replies are mirrored too: replying to review
  // feedback is the core channel conversation.
  await session(
    deps,
    { kind: "snapshot", snapshot: ev.pr, cause: { kind: "child" } },
    async (s) => {
      const pr = await s.ready();
      // THREAD_COMMENTS=false keeps every comment top-level, and a reply whose
      // parent was never mirrored posts top-level too.
      const threadTs =
        deps.threadComments !== false && c.inReplyTo !== undefined
          ? await s.sentTs(keys.reviewComment(pr.id, c.inReplyTo))
          : undefined;
      const item = { key: keys.reviewComment(pr.id, c.id), action, author: c.author, body: c.body };
      await upsertAuthored(deps, s, item, (author, images) => {
        const { poster, label } = commentPresentation(author);
        return {
          poster,
          threadTs,
          message: {
            kind: "review_comment",
            path: c.path,
            line: c.line,
            body: c.body,
            url: c.url,
            label,
            images,
          },
        };
      });
      // On edits too, so a newly added mention still pulls that person in. The
      // PR author is already a member of their own channel.
      await s.inviteMentions(c.body, ev.pr.author.login);
    },
  );
}

/**
 * Mirror a PR conversation comment. It carries no PR object to build a channel
 * from, so it waits for the pull_request event that builds one.
 */
export async function onIssueComment(deps: MirrorDeps, ev: IssueCommentEvent): Promise<void> {
  const c = ev.comment;
  // Bot comments (Vercel/Mintlify deploy previews, our own merge comment) are
  // skipped unless allow-listed. `type: "Bot"` covers our App's bot, so this
  // also keeps our merge comment from echoing (never allow-list our App's login).
  if (shouldSkipActor(c.author, deps.allowedBots)) return;
  if (ev.action === "deleted") {
    return removeStored(deps, ev.repo, ev.number, c.author, (prId) =>
      keys.issueComment(prId, c.id),
    );
  }
  const action = ev.action;

  const pr = await findByRepoNumber(deps.db, ev.repo, ev.number);
  if (!pr?.channelId) throw new Retry(`PR channel is not ready for ${ev.repo}#${ev.number}`);
  await session(deps, locked(pr), async (s) => {
    const item = { key: keys.issueComment(pr.id, c.id), action, author: c.author, body: c.body };
    // GitHub has no threads here, so the comment posts top-level.
    await upsertAuthored(deps, s, item, (author, images) => {
      const { poster, label } = commentPresentation(author);
      return {
        poster,
        message: {
          kind: "issue_comment",
          authorLogin: c.author.login,
          body: c.body,
          url: c.url,
          label,
          images,
        },
      };
    });
    await s.inviteMentions(c.body, ev.prAuthorLogin);
  });
}

/** A deletion never creates a channel: without a stored one, nothing was mirrored. */
async function removeStored(
  deps: MirrorDeps,
  repo: string,
  number: number,
  author: GithubActor,
  key: (prId: PrId) => EffectKey,
): Promise<void> {
  const pr = await findByRepoNumber(deps.db, repo, number);
  if (!pr?.channelId) return;
  await session(deps, locked(pr), (s) => removeMirror(deps, s, key(pr.id), author));
}
