import { type PrForShaFetcher, conclusionLabel } from "../ci/status.ts";
import { findAllByRepoHeadSha, findAllByRepoNumbers } from "../db/repositories/pullRequests.ts";
import { sanitizeLinkLabel, sanitizeMrkdwn } from "../slack/blocks.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";
import type { PrHandlerDeps } from "./pullRequest.ts";

export interface CheckRunPayload {
  action: string;
  repository: { full_name: string };
  check_run: {
    id: number;
    status: string; // queued | in_progress | completed
    conclusion: string | null;
    html_url: string;
    head_sha: string;
    name: string;
    pull_requests?: { number: number }[];
  };
}

export interface ChecksDeps extends PrHandlerDeps {
  /** Fallback PR resolution for a head_sha not stored locally (e.g. fork checks). */
  fetchPrForSha?: PrForShaFetcher;
}

/**
 * CI reporting (U7, R6). Only `check_run` (legacy `status` and `check_suite`
 * aggregation are deferred). Reports on completion, mapping the check to its PR
 * by head_sha: local column first, then a read-only REST fallback.
 */
export async function handleCheckRun(deps: ChecksDeps, payload: CheckRunPayload): Promise<void> {
  const run = payload.check_run;
  if (payload.action !== "completed" || run.status !== "completed" || !run.conclusion) return;

  const repoFullName = payload.repository.full_name;
  const associatedNumbers = new Set(run.pull_requests?.map((pr) => pr.number) ?? []);
  let rows =
    associatedNumbers.size > 0
      ? await findAllByRepoNumbers(deps.db, repoFullName, [...associatedNumbers])
      : await findAllByRepoHeadSha(deps.db, repoFullName, run.head_sha);

  if (rows.length === 0 && associatedNumbers.size === 0 && deps.fetchPrForSha) {
    for (const number of await deps.fetchPrForSha(repoFullName, run.head_sha)) {
      associatedNumbers.add(number);
    }
    rows = await findAllByRepoNumbers(deps.db, repoFullName, [...associatedNumbers]);
  }

  if (associatedNumbers.size > rows.length) {
    throw new Error(`PR channel is not ready for every check_run association in ${repoFullName}`);
  }

  if (rows.length === 0) {
    deps.logger.debug("check_run maps to no tracked PR", { sha: run.head_sha });
    return;
  }

  for (const row of rows) {
    if (!row.channelId) throw new Error(`PR channel is not ready for ${row.id}`);
    await deliverSlackMessage(
      deps.db,
      deps.slack,
      { prId: row.id, kind: "ci", githubEventRef: `${run.id}:${run.conclusion}` },
      {
        channel: row.channelId,
        text: sanitizeMrkdwn(`CI ${run.conclusion}: ${run.name}`),
        threadTs: row.rootMessageTs ?? undefined,
        blocks: [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `${conclusionLabel(run.conclusion)} · <${run.html_url}|${sanitizeLinkLabel(run.name)}>`,
              },
            ],
          },
        ],
      },
    );
  }
}
