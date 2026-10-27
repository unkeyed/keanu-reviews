/** CI aggregate used to decide whether a review-needed alert may fire. */
export type CiReadiness = "passing" | "failing" | "pending" | "absent";

export interface CiCheckRun {
  name?: string | null;
  status: string;
  conclusion: string | null;
  /** ISO timestamp; the newest run wins when the same check name is rerun. */
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface CiCheckSuite {
  status: string;
}

export interface CiCommitStatus {
  /**
   * Combined commit-status state. GitHub reports `"pending"` with a count of 0
   * when the commit has no statuses at all, so a zero count is "no statuses".
   */
  state: string | null;
  count: number;
}

export interface CiSnapshot {
  checkRuns: CiCheckRun[];
  checkSuites: CiCheckSuite[];
  commitStatus: CiCommitStatus;
}

/** Conclusions that mean CI did not pass. `cancelled` is handled separately. */
const HARD_FAIL = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

/** Fetch every PR number that a commit heads (fallback when associations aren't stored). */
export type PrForShaFetcher = (repoFullName: string, sha: string) => Promise<number[]>;

function runTime(run: CiCheckRun): number {
  const raw = run.completedAt ?? run.startedAt;
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Keep the newest run for each check name. A rerun leaves the old conclusion
 * on the commit; alerting off that stale failure would block the PR forever
 * after the rerun passed. Runs with no name are kept individually.
 */
function latestRuns(runs: CiCheckRun[]): CiCheckRun[] {
  const byName = new Map<string, CiCheckRun>();
  const unnamed: CiCheckRun[] = [];
  for (const run of runs) {
    const name = run.name?.trim();
    if (!name) {
      unnamed.push(run);
      continue;
    }
    const previous = byName.get(name);
    if (!previous || runTime(run) >= runTime(previous)) byName.set(name, run);
  }
  return [...byName.values(), ...unnamed];
}

/**
 * Fold check runs, check suites, and legacy commit statuses into one signal.
 *
 * In-progress work waits, even when another check has already failed: the next
 * completion event re-reads the aggregate, and a failing result still does not
 * alert. `absent` means the commit has no checks and no commit statuses (the
 * repo likely has no CI). Callers decide whether to wait briefly for checks to
 * register or to treat that as ready.
 */
export function classifyCiReadiness(snapshot: CiSnapshot): CiReadiness {
  const runs = latestRuns(snapshot.checkRuns);
  const suites = snapshot.checkSuites;
  const status = snapshot.commitStatus;
  const statusPending = status.count > 0 && status.state === "pending";
  const statusFailing =
    status.count > 0 && (status.state === "failure" || status.state === "error");

  const incomplete =
    runs.some((run) => run.status !== "completed" || run.conclusion === null) ||
    suites.some((suite) => suite.status !== "completed") ||
    statusPending;
  if (incomplete) return "pending";

  const hardFail = runs.some((run) => run.conclusion !== null && HARD_FAIL.has(run.conclusion));
  if (hardFail || statusFailing) return "failing";

  // A commit whose latest runs are all cancelled did not pass. A cancelled
  // sibling next to a success (fail-fast or a superseded attempt) does not.
  const cancelledOnly =
    runs.length > 0 &&
    runs.every((run) => run.conclusion === "cancelled") &&
    status.state !== "success";
  if (cancelledOnly) return "failing";

  if (runs.length > 0 || suites.length > 0 || status.count > 0) return "passing";
  return "absent";
}
