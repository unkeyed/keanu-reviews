import type { GithubActor, IssueCommentEvent, ReviewCommentEvent, Work } from "#events";
import { shouldSkipActor } from "#github";
import { type PrId, Retry } from "#lib";
import {
  type PrRow,
  type PrSession,
  type PrSource,
  findByRepoNumber,
  isMergeComment,
  session,
} from "#pr";
import { type EffectKey, keys } from "#slack";
import { type MirrorDeps, commentPresentation, removeMirror, upsertAuthored } from "./author.ts";

const locked = (pr: PrRow) => ({ kind: "existing", githubPrId: pr.githubPrId }) as const;

const PARENT_WAIT_ATTEMPTS = 3;

export async function onReviewComment(
  deps: MirrorDeps,
  ev: ReviewCommentEvent,
  work: Pick<Work, "attempt"> & { signal?: AbortSignal } = { attempt: 1 },
): Promise<void> {
  const { signal } = work;
  const c = ev.comment;
  if (shouldSkipActor(c.author, deps.allowedBots)) return;
  if (ev.action === "deleted") {
    return removeStored(
      deps,
      ev.pr.repo,
      ev.pr.number,
      c.author,
      (prId) => keys.reviewComment(prId, c.id),
      signal,
    );
  }
  const action = ev.action;

  await session(
    deps,
    { kind: "snapshot", snapshot: ev.pr, cause: { kind: "child" } },
    async (s) => {
      const pr = await s.ready();
      const replyThread =
        deps.threadComments && c.inReplyTo !== undefined
          ? await parentThread(s, keys.reviewComment(pr.id, c.inReplyTo), work.attempt)
          : undefined;
      // An allowed bot's comments join its review summary in the PR root's
      // thread instead of flooding the channel.
      const threadTs = replyThread ?? (c.author.isBot ? pr.rootMessageTs : undefined);
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
      await s.inviteMentions(c.body, ev.pr.author.login);
    },
    signal,
  );
}

/**
 * The Slack thread a reply belongs in. Slack threads are one level deep, so a
 * reply to a message that is itself a thread reply joins that same thread.
 */
async function parentThread(
  s: PrSession,
  parent: EffectKey,
  attempt: number,
): Promise<string | undefined> {
  const state = await s.state(parent);
  if (state.status === "sent") return state.threadTs ?? state.ts;
  if (state.status === "in-flight" && attempt < PARENT_WAIT_ATTEMPTS) {
    throw new Retry("parent review comment is still being mirrored", { ref: parent.ref });
  }
  return undefined;
}

export async function onIssueComment(
  deps: MirrorDeps,
  ev: IssueCommentEvent,
  signal?: AbortSignal,
): Promise<void> {
  const c = ev.comment;
  if (shouldSkipActor(c.author, deps.allowedBots) || isMergeComment(c.author, c.body)) return;
  if (ev.action === "deleted") {
    return removeStored(
      deps,
      ev.repo,
      ev.number,
      c.author,
      (prId) => keys.issueComment(prId, c.id),
      signal,
    );
  }
  const action = ev.action;

  const pr = await findByRepoNumber(deps.db, ev.repo, ev.number);
  await session(
    deps,
    pr?.channelId ? locked(pr) : await fromGithub(deps, ev.repo, ev.number),
    async (s) => {
      const { id, rootMessageTs } = await s.channelPr();
      const threadTs = c.author.isBot ? (rootMessageTs ?? undefined) : undefined;
      const item = { key: keys.issueComment(id, c.id), action, author: c.author, body: c.body };
      await upsertAuthored(deps, s, item, (author, images) => {
        const { poster, label } = commentPresentation(author);
        return {
          poster,
          threadTs,
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
    },
    signal,
  );
}

async function fromGithub(deps: MirrorDeps, repo: string, number: number): Promise<PrSource> {
  const { snapshot } = await deps.fetchSnapshot(repo, number);
  if (!snapshot) throw new Retry(`PR channel is not ready for ${repo}#${number}`);
  return { kind: "snapshot", snapshot, cause: { kind: "child" } };
}

async function removeStored(
  deps: MirrorDeps,
  repo: string,
  number: number,
  author: GithubActor,
  key: (prId: PrId) => EffectKey,
  signal: AbortSignal | undefined,
): Promise<void> {
  const pr = await findByRepoNumber(deps.db, repo, number);
  if (!pr) return;
  await session(deps, locked(pr), (s) => removeMirror(deps, s, key(pr.id), author), signal);
}
