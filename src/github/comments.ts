import type { InstallationAuth } from "./auth.ts";
import { type GithubRequestOptions, githubPostJson } from "./http.ts";

/** Post a comment on a PR (opt-in write — see the merge-comment feature). */
export type PrCommenter = (repoFullName: string, number: number, body: string) => Promise<void>;

/**
 * Production PR commenter. PR conversation comments post via the issues API
 * (`POST /repos/{owner}/{repo}/issues/{number}/comments`) and require the GitHub
 * App to have write permission on Pull requests (or Issues).
 */
export function createPrCommenter(
  auth: InstallationAuth,
  installationId: string,
  options: GithubRequestOptions = {},
): PrCommenter {
  return async (repoFullName, number, body) => {
    const repoPath = repoFullName.split("/").map(encodeURIComponent).join("/");
    await githubPostJson(
      auth,
      installationId,
      `/repos/${repoPath}/issues/${number}/comments`,
      { body },
      options,
    );
  };
}
