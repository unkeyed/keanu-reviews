import { type PrForShaFetcher, conclusionLabel } from "../ci/status.ts";
import type { Db } from "../db/client.ts";
import { recordMessage } from "../db/repositories/messages.ts";
import { findByHeadSha, findByRepoNumber } from "../db/repositories/pullRequests.ts";
import type { Logger } from "../logger.ts";
import type { SlackClient } from "../slack/client.ts";

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
  };
}

export interface ChecksDeps {
  db: Db;
  slack: SlackClient;
  logger: Logger;
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
  let row = await findByHeadSha(deps.db, run.head_sha);
  if (!row && deps.fetchPrForSha) {
    const number = await deps.fetchPrForSha(repoFullName, run.head_sha);
    if (number !== undefined) row = await findByRepoNumber(deps.db, repoFullName, number);
  }
  if (!row?.channelId) {
    deps.logger.debug("check_run maps to no tracked PR", { sha: run.head_sha });
    return;
  }

  // Dedup on run id + conclusion so one CI run isn't posted twice.
  const first = await recordMessage(deps.db, {
    prId: row.id,
    kind: "ci",
    githubEventRef: `${run.id}:${run.conclusion}`,
    slackTs: "-",
  });
  if (!first) return;

  await deps.slack.postMessage({
    channel: row.channelId,
    text: `CI ${run.conclusion}: ${run.name}`,
    threadTs: row.rootMessageTs ?? undefined,
    blocks: [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${conclusionLabel(run.conclusion)} · <${run.html_url}|${run.name}>`,
          },
        ],
      },
    ],
  });
}
