export type PrState = "draft" | "pr" | "closed" | "merged";

export interface GithubActor {
  id: number;
  login: string;
  isBot: boolean;
}

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
  updatedAt: string;
  requestedReviewers: readonly GithubActor[];
}

export interface PrChange {
  action: string;
  pr: PrSnapshot;
  merged: boolean;
}

export type MirrorAction = "created" | "edited" | "deleted";

export interface ReviewComment {
  id: number;
  inReplyTo: number | undefined;
  path: string;
  line: number | null;
  body: string;
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

export interface IssueCommentEvent {
  kind: "issue_comment";
  action: MirrorAction;
  repo: string;
  number: number;
  prAuthorLogin: string | undefined;
  comment: IssueComment;
}

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
