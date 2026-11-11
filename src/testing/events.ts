import { type DomainEvent, parseEvent } from "#events";

export interface GithubUserJson {
  id: number;
  login: string;
  type?: string;
}

export interface PullRequestJson {
  number: number;
  id: number;
  draft?: boolean;
  merged?: boolean;
  title: string;
  html_url: string;
  user: GithubUserJson;
  head: { sha: string; ref?: string };
  base?: { ref: string };
  updated_at: string;
  requested_reviewers?: GithubUserJson[];
}

export interface PullRequestPayload {
  action: string;
  repository: { full_name: string };
  pull_request: PullRequestJson;
  requested_reviewer?: GithubUserJson;
  requested_team?: { id: number; slug: string };
}

export interface ReviewCommentPayload {
  action: string;
  repository: { full_name: string };
  pull_request: PullRequestJson;
  comment: {
    id: number;
    commit_id?: string;
    path: string;
    line: number | null;
    in_reply_to_id?: number | null;
    body: string;
    html_url: string;
    user: GithubUserJson;
  };
}

export interface ReviewPayload {
  action: string;
  repository: { full_name: string };
  pull_request: PullRequestJson;
  review: {
    id: number;
    state: string;
    body: string | null;
    html_url: string;
    submitted_at?: string;
    user: GithubUserJson;
  };
}

export interface IssueCommentPayload {
  action: string;
  repository: { full_name: string };
  issue: { number: number; pull_request?: unknown; user?: { login: string } };
  comment: { id: number; body: string; html_url: string; user: GithubUserJson };
}

export interface CheckRunPayload {
  action: string;
  repository: { full_name: string };
  check_run: {
    id?: number;
    status: string;
    conclusion?: string | null;
    html_url?: string;
    head_sha: string;
    name?: string;
    pull_requests?: { number: number }[];
  };
}

function parsed<K extends DomainEvent["kind"]>(
  event: string,
  kind: K,
  raw: unknown,
): Extract<DomainEvent, { kind: K }> {
  const ev = parseEvent(event, raw);
  if (ev.kind !== kind) throw new Error(`${event} payload parsed as ${ev.kind}, not ${kind}`);
  return ev as Extract<DomainEvent, { kind: K }>;
}

export const pullRequestEvent = (raw: PullRequestPayload) =>
  parsed("pull_request", "pull_request", raw);
export const reviewCommentEvent = (raw: ReviewCommentPayload) =>
  parsed("pull_request_review_comment", "review_comment", raw);
export const reviewEvent = (raw: ReviewPayload) => parsed("pull_request_review", "review", raw);
export const issueCommentEvent = (raw: IssueCommentPayload) =>
  parsed("issue_comment", "issue_comment", raw);
export const checkRunEvent = (raw: CheckRunPayload) => parsed("check_run", "check_run", raw);
