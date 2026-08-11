import type { PrForShaFetcher } from "../ci/status.ts";
import type { GithubUserFetcher } from "../identity/link.ts";
import type { GithubEmailFetcher } from "../identity/resolve.ts";
import type { InstallationAuth } from "./auth.ts";
import { GithubApiError, type GithubRequestOptions, githubGetJson } from "./http.ts";

export { GithubApiError } from "./http.ts";

type GithubUserResponse = { id?: unknown; login?: unknown };
type GithubEmailResponse = { email?: unknown };

function invalidResponse(path: string): GithubApiError {
  return new GithubApiError("GitHub API returned an unexpected response shape", {
    kind: "invalid_response",
    url: `https://api.github.com${path}`,
  });
}

/**
 * Production GitHub email fetcher (U5). Reads a user's public profile via
 * `GET /users/{login}`. This is a read — it never writes to GitHub, so it stays
 * within the one-way boundary (R10). Returns undefined when the email is private.
 */
export function createGithubEmailFetcher(
  auth: InstallationAuth,
  installationId: string,
  options: GithubRequestOptions = {},
): GithubEmailFetcher {
  return async (login: string): Promise<string | undefined> => {
    const path = `/users/${encodeURIComponent(login)}`;
    const body = await githubGetJson<GithubEmailResponse>(auth, installationId, path, options);
    if (body === undefined) return undefined;
    if (body.email === null) return undefined;
    if (typeof body.email !== "string") throw invalidResponse(path);
    return body.email;
  };
}

/** Production GitHub user fetcher (U9): resolve a login to its immutable id. */
export function createGithubUserFetcher(
  auth: InstallationAuth,
  installationId: string,
  options: GithubRequestOptions = {},
): GithubUserFetcher {
  return async (login: string) => {
    const path = `/users/${encodeURIComponent(login)}`;
    const body = await githubGetJson<GithubUserResponse>(auth, installationId, path, options);
    if (body === undefined) return undefined;
    if (!Number.isInteger(body.id) || typeof body.login !== "string" || body.login.length === 0) {
      throw invalidResponse(path);
    }
    return { id: body.id as number, login: body.login };
  };
}

/** Production fallback PR resolver (U7): the PR a commit heads, via the Checks-safe read API. */
export function createPrForShaFetcher(
  auth: InstallationAuth,
  installationId: string,
  options: GithubRequestOptions = {},
): PrForShaFetcher {
  return async (repoFullName: string, sha: string) => {
    const repoPath = repoFullName.split("/").map(encodeURIComponent).join("/");
    const path = `/repos/${repoPath}/commits/${encodeURIComponent(sha)}/pulls`;
    const body = await githubGetJson<unknown>(auth, installationId, path, options);
    if (body === undefined) return [];
    if (!Array.isArray(body)) throw invalidResponse(path);

    const numbers: number[] = [];
    for (const pullRequest of body) {
      if (
        typeof pullRequest !== "object" ||
        pullRequest === null ||
        !Number.isInteger((pullRequest as { number?: unknown }).number)
      ) {
        throw invalidResponse(path);
      }
      numbers.push((pullRequest as { number: number }).number);
    }
    return numbers;
  };
}
