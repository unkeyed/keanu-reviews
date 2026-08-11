import type { Db } from "../db/client.ts";
import { upsertIdentity } from "../db/repositories/identities.ts";
import type { SlackClient } from "../slack/client.ts";

/** Resolve a GitHub login to its immutable numeric id (read-only). */
export type GithubUserFetcher = (
  login: string,
) => Promise<{ id: number; login: string } | undefined>;

export interface LinkDeps {
  db: Db;
  slack: SlackClient;
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
      (row.slack_email ? await deps.slack.lookupUserByEmail(row.slack_email) : undefined);
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
