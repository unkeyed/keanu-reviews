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
