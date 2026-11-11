import type { ReviewEvent } from "#events";
import type { PrSession } from "#pr";
import { cleanGithubMarkdown, keys } from "#slack";
import { type MirrorDeps, reviewPresentation, upsertAuthored } from "./author.ts";

/** Mirror a submitted review into the PR channel of the caller's session. */
export async function mirrorReview(deps: MirrorDeps, s: PrSession, ev: ReviewEvent): Promise<void> {
  const pr = await s.ready();
  const r = ev.review;
  const item = {
    key: keys.review(pr.id, r.id),
    action: "created" as const,
    author: r.author,
    body: r.body,
  };
  await upsertAuthored(deps, s, item, (author, images) => {
    // A "commented" review with no text or images after cleaning is the
    // wrapper GitHub emits around inline review comments, which arrive as
    // review_comment events of their own.
    if (r.state === "commented" && !cleanGithubMarkdown(r.body) && images.length === 0) {
      return null;
    }
    const { poster, label } = reviewPresentation(author);
    return {
      poster,
      // Bot reviews thread under the PR root to keep the channel readable.
      threadTs: r.author.isBot ? pr.rootMessageTs : undefined,
      message: {
        kind: "review",
        authorLogin: r.author.login,
        state: r.state,
        body: r.body,
        url: r.url,
        label,
        images,
      },
    };
  });
  // The PR author is already a member of their own channel.
  await s.inviteMentions(r.body, ev.pr.author.login);
}
