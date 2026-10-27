/** Mergeability facts read from a pull request. Used to stop reminders once a PR is ready to merge. */
export interface PullRequestMergeability {
  mergeable: boolean | null;
  mergeableState: string;
  draft: boolean;
  /** Present when the pull-request read included the current requested reviewers. */
  requestedReviewers?: { id: number; login: string }[];
}

/** Read a PR's current mergeability (a GitHub read; within the one-way boundary). */
export type PullRequestFetcher = (
  repoFullName: string,
  number: number,
) => Promise<PullRequestMergeability | undefined>;
