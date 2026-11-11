import type { CheckRunEvent, Work } from "#events";
import { Retry } from "#lib";
import {
  type ChannelPr,
  type PrRow,
  findAllByRepoHeadSha,
  findAllByRepoNumbers,
  session,
} from "#pr";
import { releaseAlerts } from "./alerts.ts";
import type { ReviewDeps } from "./deps.ts";

/**
 * A completed check run may release the review alerts of every tracked PR its
 * commit heads: the PRs GitHub lists on the run, else the stored PRs at that
 * head, else the PRs GitHub says the commit heads (fork checks list none).
 * Each runs in its PR's session. An associated PR with no row or channel yet
 * makes the job retry, after the PRs that are ready have been handled.
 */
export async function onCheckRun(deps: ReviewDeps, ev: CheckRunEvent, work: Work): Promise<void> {
  const { repo, headSha } = ev;
  const associated = new Set(ev.prNumbers);
  let rows =
    associated.size > 0
      ? await findAllByRepoNumbers(deps.db, repo, [...associated])
      : await findAllByRepoHeadSha(deps.db, repo, headSha);
  if (rows.length === 0 && associated.size === 0) {
    for (const number of await deps.fetchPrForSha(repo, headSha)) associated.add(number);
    rows = await findAllByRepoNumbers(deps.db, repo, [...associated]);
  }

  const notReady = () =>
    new Retry(`PR channel is not ready for every CI association in ${repo}`, {
      sha: headSha,
      associations: [...associated],
    });
  const missing = associated.size > rows.length;
  if (rows.length === 0) {
    if (missing) throw notReady();
    deps.logger.debug("CI event maps to no tracked PR", { sha: headSha });
    return;
  }

  let retry: Retry | undefined;
  for (const row of rows) {
    if (!hasChannel(row)) continue;
    if (row.headSha && row.headSha !== headSha) {
      deps.logger.debug("ignoring CI event for a stale head", {
        prId: row.id,
        headSha: row.headSha,
        eventSha: headSha,
      });
      continue;
    }
    try {
      await session(
        deps,
        { kind: "existing", githubPrId: row.githubPrId },
        (s) => releaseAlerts(deps, s, row, { kind: "check_run" }, work.attempt),
        work.signal,
      );
    } catch (err) {
      if (!(err instanceof Retry)) throw err;
      retry = err;
    }
  }

  if (missing || rows.some((row) => !row.channelId)) throw notReady();
  if (retry) throw retry;
}

function hasChannel(row: PrRow): row is ChannelPr {
  return Boolean(row.channelId);
}
