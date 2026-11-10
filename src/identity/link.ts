import type { Db } from "#db";
import type { GithubUserFetcher } from "#github";
import type { SlackGateway } from "#slack";
import { upsertIdentity } from "./store.ts";

export interface LinkDeps {
  db: Db;
  slack: SlackGateway;
  fetchGithubUser: GithubUserFetcher;
}

export interface ImportRow {
  github_login?: string;
  slack_email?: string;
  slack_user_id?: string;
}

export interface ImportResult {
  imported: number;
  skipped: { row: ImportRow; reason: string }[];
}

/** Admin bulk-import of identity mappings (U9). Malformed rows are skipped, not fatal. */
export async function importIdentities(deps: LinkDeps, rows: ImportRow[]): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: [] };
  for (const row of rows) {
    if (!row.github_login || (!row.slack_email && !row.slack_user_id)) {
      result.skipped.push({ row, reason: "missing github_login or slack identity" });
      continue;
    }
    const user = await deps.fetchGithubUser(row.github_login);
    if (!user) {
      result.skipped.push({ row, reason: "unknown github login" });
      continue;
    }
    const slackUserId =
      row.slack_user_id ??
      (row.slack_email ? await deps.slack.lookupByEmail(row.slack_email) : undefined);
    if (!slackUserId) {
      result.skipped.push({ row, reason: "no slack user for email" });
      continue;
    }
    await upsertIdentity(deps.db, {
      githubUserId: user.id,
      githubLogin: user.login,
      slackUserId,
      source: "admin-import",
    });
    result.imported += 1;
  }
  return result;
}
