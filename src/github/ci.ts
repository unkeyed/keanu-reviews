/** CI aggregate from check runs, used to decide whether a review-needed alert may fire. */
export type CiReadiness = "passing" | "failing" | "pending" | "absent";

export interface CiCheckRun {
  name?: string | null;
  status: string;
  conclusion: string | null;
  /** ISO timestamp; the newest run wins when the same check name is rerun. */
  startedAt?: string | null;
  completedAt?: string | null;
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
 * Fold check runs into one signal. Legacy commit statuses are ignored.
 *
 * In-progress work waits, even when another check has already failed: the next
 * `check_run` completion re-reads the list, and a failing result still does not
 * alert. `absent` means the commit has no check runs (no GitHub Checks CI, or
 * checks have not been created yet).
 */
export function classifyCiReadiness(runs: CiCheckRun[]): CiReadiness {
  const latest = latestRuns(runs);
  if (latest.length === 0) return "absent";
  if (latest.some((run) => run.status !== "completed" || run.conclusion === null)) {
    return "pending";
  }
  if (latest.some((run) => run.conclusion !== null && HARD_FAIL.has(run.conclusion))) {
    return "failing";
  }
  // Every latest run was cancelled: CI did not pass. A cancelled sibling next
  // to a success (fail-fast or a superseded attempt) does not, because that
  // sibling is not "every" run.
  if (latest.every((run) => run.conclusion === "cancelled")) return "failing";
  return "passing";
}
