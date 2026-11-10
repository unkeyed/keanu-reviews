export type PrState = "draft" | "pr" | "closed" | "merged";

export interface GithubActor {
  id: number;
  login: string;
  /** GitHub marks automation accounts (Vercel, Dependabot, our own App) with `type: "Bot"`. */
  isBot: boolean;
}

/** What GitHub says about a PR, from a webhook's pull_request object or GET /pulls/{n}. */
export interface PrSnapshot {
  repo: string;
  number: number;
  githubPrId: number;
  title: string;
  url: string;
  author: GithubActor;
  draft: boolean;
  headSha: string;
  headRef: string | undefined;
  baseRef: string | undefined;
  /** GitHub's `updated_at`, verbatim: lifecycle message keys embed the exact string. */
  updatedAt: string;
  requestedReviewers: readonly GithubActor[];
}

/** A PR fact change: what one source asserts about the PR's lifecycle. */
export interface PrChange {
  action: string;
  pr: PrSnapshot;
  merged: boolean;
}

export type MirrorAction = "created" | "edited" | "deleted";

export interface ReviewComment {
  id: number;
  /** Set when this comment replies within an existing review thread. */
  inReplyTo: number | undefined;
  path: string;
  line: number | null;
  body: string;
  /** The PR discussion permalink, not the file/line blob view. */
  url: string;
  author: GithubActor;
}

export interface IssueComment {
  id: number;
  body: string;
  url: string;
  author: GithubActor;
}

export interface Review {
  id: number;
  state: string;
  body: string;
  url: string;
  submittedAt: string | undefined;
  author: GithubActor;
}

export interface PullRequestEvent extends PrChange {
  kind: "pull_request";
  /** review_requested / review_request_removed: a team-only request has no reviewer. */
  requestedReviewer: GithubActor | undefined;
  requestedTeam: string | undefined;
}

export interface ReviewCommentEvent {
  kind: "review_comment";
  action: MirrorAction;
  pr: PrSnapshot;
  comment: ReviewComment;
}

export interface ReviewEvent {
  kind: "review";
  action: "submitted";
  pr: PrSnapshot;
  review: Review;
}

/** issue_comment carries no PR object, only the issue's number and opener. */
export interface IssueCommentEvent {
  kind: "issue_comment";
  action: MirrorAction;
  repo: string;
  number: number;
  prAuthorLogin: string | undefined;
  comment: IssueComment;
}

/** A completed check run. `prNumbers` empty means "resolve by head sha". */
export interface CheckRunEvent {
  kind: "check_run";
  repo: string;
  headSha: string;
  prNumbers: readonly number[];
}

export interface IgnoredEvent {
  kind: "ignored";
  event: string;
  action: string | null;
  reason: string;
}

export type DomainEvent =
  | PullRequestEvent
  | ReviewCommentEvent
  | ReviewEvent
  | IssueCommentEvent
  | CheckRunEvent
  | IgnoredEvent;
