import type { PrForShaFetcher } from "../ci/status.ts";
import type { GithubUserFetcher } from "../identity/link.ts";
import type { GithubEmailFetcher } from "../identity/resolve.ts";
import type { InstallationAuth } from "./auth.ts";

/**
 * Production GitHub email fetcher (U5). Reads a user's public profile via
 * `GET /users/{login}`. This is a read — it never writes to GitHub, so it stays
 * within the one-way boundary (R10). Returns undefined when the email is private.
 */
export function createGithubEmailFetcher(
  auth: InstallationAuth,
  installationId: string,
): GithubEmailFetcher {
  return async (login: string): Promise<string | undefined> => {
    const token = await auth.getToken(installationId);
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "unkey-slack-pr-bot",
      },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { email?: string | null };
    return body.email ?? undefined;
  };
}

/** Production GitHub user fetcher (U9): resolve a login to its immutable id. */
export function createGithubUserFetcher(
  auth: InstallationAuth,
  installationId: string,
): GithubUserFetcher {
  return async (login: string) => {
    const token = await auth.getToken(installationId);
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "unkey-slack-pr-bot",
      },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { id?: number; login?: string };
    return body.id && body.login ? { id: body.id, login: body.login } : undefined;
  };
}

/** Production fallback PR resolver (U7): the PR a commit heads, via the Checks-safe read API. */
export function createPrForShaFetcher(
  auth: InstallationAuth,
  installationId: string,
): PrForShaFetcher {
  return async (repoFullName: string, sha: string) => {
    const token = await auth.getToken(installationId);
    const res = await fetch(`https://api.github.com/repos/${repoFullName}/commits/${sha}/pulls`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "unkey-slack-pr-bot",
      },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { number?: number }[];
    return body.flatMap((pullRequest) =>
      pullRequest.number === undefined ? [] : [pullRequest.number],
    );
  };
}
