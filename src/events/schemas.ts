import { z } from "zod";
import { Permanent } from "#lib";
import type { DomainEvent, GithubActor, MirrorAction, PrSnapshot } from "./types.ts";

// Only the fields a handler reads are required. Everything else GitHub sends is
// ignored, so a new or missing optional field never fails a delivery.

const actor = z
  .object({ id: z.number(), login: z.string(), type: z.string().nullish() })
  .transform((u): GithubActor => ({ id: u.id, login: u.login, isBot: u.type === "Bot" }));

const repository = z.object({ full_name: z.string() });

const timestamp = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "must be a timestamp");

const pullRequest = z.object({
  number: z.number(),
  id: z.number(),
  draft: z.boolean().nullish(),
  merged: z.boolean().nullish(),
  title: z.string(),
  html_url: z.string(),
  user: actor,
  head: z.object({ sha: z.string(), ref: z.string().nullish() }),
  base: z.object({ ref: z.string().nullish() }).nullish(),
  updated_at: timestamp,
  requested_reviewers: z.array(actor).nullish(),
});

function snapshot(repo: string, pr: z.output<typeof pullRequest>): PrSnapshot {
  return {
    repo,
    number: pr.number,
    githubPrId: pr.id,
    title: pr.title,
    url: pr.html_url,
    author: pr.user,
    draft: pr.draft ?? false,
    headSha: pr.head.sha,
    headRef: pr.head.ref ?? undefined,
    baseRef: pr.base?.ref ?? undefined,
    updatedAt: pr.updated_at,
    requestedReviewers: pr.requested_reviewers ?? [],
  };
}

const pullRequestEvent = z
  .object({
    action: z.string(),
    repository,
    pull_request: pullRequest,
    requested_reviewer: actor.nullish(),
    requested_team: z.object({ slug: z.string() }).nullish(),
  })
  .transform(
    (p): DomainEvent => ({
      kind: "pull_request",
      action: p.action,
      pr: snapshot(p.repository.full_name, p.pull_request),
      merged: p.pull_request.merged ?? false,
      requestedReviewer: p.requested_reviewer ?? undefined,
      requestedTeam: p.requested_team?.slug,
    }),
  );

const mirrorAction = z.enum(["created", "edited", "deleted"]);

const reviewCommentEvent = z
  .object({
    action: mirrorAction,
    repository,
    pull_request: pullRequest,
    comment: z.object({
      id: z.number(),
      in_reply_to_id: z.number().nullish(),
      path: z.string(),
      line: z.number().nullish(),
      body: z.string(),
      html_url: z.string(),
      user: actor,
    }),
  })
  .transform(
    (p): DomainEvent => ({
      kind: "review_comment",
      action: p.action,
      pr: snapshot(p.repository.full_name, p.pull_request),
      comment: {
        id: p.comment.id,
        inReplyTo: p.comment.in_reply_to_id ?? undefined,
        path: p.comment.path,
        line: p.comment.line ?? null,
        body: p.comment.body,
        url: p.comment.html_url,
        author: p.comment.user,
      },
    }),
  );

const reviewEvent = z
  .object({
    action: z.literal("submitted"),
    repository,
    pull_request: pullRequest,
    review: z.object({
      id: z.number(),
      state: z.string(),
      body: z.string().nullish(),
      html_url: z.string(),
      submitted_at: z.string().nullish(),
      user: actor,
    }),
  })
  .transform(
    (p): DomainEvent => ({
      kind: "review",
      action: p.action,
      pr: snapshot(p.repository.full_name, p.pull_request),
      review: {
        id: p.review.id,
        state: p.review.state,
        body: p.review.body ?? "",
        url: p.review.html_url,
        submittedAt: p.review.submitted_at ?? undefined,
        author: p.review.user,
      },
    }),
  );

const issueCommentEvent = z
  .object({
    action: mirrorAction,
    repository,
    issue: z.object({ number: z.number(), user: z.object({ login: z.string() }).nullish() }),
    comment: z.object({ id: z.number(), body: z.string(), html_url: z.string(), user: actor }),
  })
  .transform(
    (p): DomainEvent => ({
      kind: "issue_comment",
      action: p.action,
      repo: p.repository.full_name,
      number: p.issue.number,
      prAuthorLogin: p.issue.user?.login,
      comment: {
        id: p.comment.id,
        body: p.comment.body,
        url: p.comment.html_url,
        author: p.comment.user,
      },
    }),
  );

const checkRunEvent = z
  .object({
    repository,
    check_run: z.object({
      head_sha: z.string(),
      pull_requests: z.array(z.object({ number: z.number() })).nullish(),
    }),
  })
  .transform(
    (p): DomainEvent => ({
      kind: "check_run",
      repo: p.repository.full_name,
      headSha: p.check_run.head_sha,
      prNumbers: p.check_run.pull_requests?.map((pr) => pr.number) ?? [],
    }),
  );

const envelope = z.object({
  action: z.string().nullish(),
  issue: z.object({ pull_request: z.unknown().optional() }).nullish(),
  check_run: z.object({ status: z.unknown().optional() }).nullish(),
});
type Envelope = z.output<typeof envelope>;

interface EventParser {
  schema: z.ZodType<DomainEvent>;
  /** Why a delivery this handler never acts on is dropped, checked before full validation. */
  skip?: (raw: Envelope) => string | undefined;
}

const MIRRORED: ReadonlySet<string> = new Set<MirrorAction>(["created", "edited", "deleted"]);
const unhandledMirrorAction = (raw: Envelope) =>
  raw.action && MIRRORED.has(raw.action) ? undefined : "unhandled action";

/** The single list of GitHub events this app subscribes to. */
const EVENT_PARSERS: Readonly<Record<string, EventParser>> = {
  pull_request: { schema: pullRequestEvent },
  pull_request_review_comment: { schema: reviewCommentEvent, skip: unhandledMirrorAction },
  pull_request_review: {
    schema: reviewEvent,
    skip: (raw) => (raw.action === "submitted" ? undefined : "unhandled action"),
  },
  issue_comment: {
    schema: issueCommentEvent,
    skip: (raw) => unhandledMirrorAction(raw) ?? (raw.issue?.pull_request ? undefined : "not a PR"),
  },
  // In-progress runs are ignored; their completion event is the trigger.
  check_run: {
    schema: checkRunEvent,
    skip: (raw) => (raw.check_run?.status === "completed" ? undefined : "check run not completed"),
  },
};

/**
 * Turn a stored webhook payload into a DomainEvent. Unknown events and actions
 * no handler acts on become `ignored`. A known event missing a field a handler
 * reads throws Permanent: redelivering the same bytes can never succeed.
 */
export function parseEvent(event: string, raw: unknown): DomainEvent {
  const parser = Object.hasOwn(EVENT_PARSERS, event) ? EVENT_PARSERS[event] : undefined;
  const head = envelope.safeParse(raw);
  const action = head.success ? (head.data.action ?? null) : null;
  if (!parser) return { kind: "ignored", event, action, reason: "unknown event" };
  if (!head.success) throw invalid(event, head.error);

  const reason = parser.skip?.(head.data);
  if (reason) return { kind: "ignored", event, action, reason };

  const parsed = parser.schema.safeParse(raw);
  if (!parsed.success) throw invalid(event, parsed.error);
  return parsed.data;
}

function invalid(event: string, error: z.ZodError): Permanent {
  const fields = error.issues.map(
    (issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`,
  );
  return new Permanent(`invalid ${event} payload`, { issues: fields });
}
