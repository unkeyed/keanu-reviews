export type CiReadiness = "passing" | "failing" | "pending" | "absent";

export interface CiCheckRun {
  name?: string | null;
  status: string;
  conclusion: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

const HARD_FAIL = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

export type PrForShaFetcher = (repoFullName: string, sha: string) => Promise<number[]>;

function runTime(run: CiCheckRun): number {
  const raw = run.completedAt ?? run.startedAt;
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

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

export function classifyCiReadiness(runs: CiCheckRun[]): CiReadiness {
  const latest = latestRuns(runs);
  if (latest.length === 0) return "absent";
  if (latest.some((run) => run.status !== "completed" || run.conclusion === null)) {
    return "pending";
  }
  if (latest.some((run) => run.conclusion !== null && HARD_FAIL.has(run.conclusion))) {
    return "failing";
  }
  if (latest.every((run) => run.conclusion === "cancelled")) return "failing";
  return "passing";
}
