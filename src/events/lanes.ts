const PR_EVENTS = new Set(["pull_request", "pull_request_review", "pull_request_review_comment"]);

interface RawPrRefs {
  repository?: { full_name?: unknown };
  pull_request?: { number?: unknown };
  issue?: { number?: unknown };
  check_run?: { pull_requests?: unknown };
}

/**
 * The PRs a stored webhook job is about, as `owner/repo#number`, read off the
 * raw payload without parsing the event. The worker runs jobs that share a PR
 * one at a time, in claim order. A check run that names no PR (a fork's, found
 * by head sha) and every non-PR event name none.
 */
export function jobPrKeys(event: string, raw: unknown): string[] {
  const p = raw as RawPrRefs | null | undefined;
  const repo = p?.repository?.full_name;
  if (typeof repo !== "string") return [];
  const runPrs = p?.check_run?.pull_requests;
  const numbers: unknown[] =
    event === "issue_comment"
      ? [p?.issue?.number]
      : event === "check_run"
        ? Array.isArray(runPrs)
          ? runPrs.map((pr: { number?: unknown } | null) => pr?.number)
          : []
        : PR_EVENTS.has(event)
          ? [p?.pull_request?.number]
          : [];
  const keys = numbers.filter(Number.isInteger).map((n) => `${repo.toLowerCase()}#${n}`);
  return [...new Set(keys)];
}
