import { createAppAuth } from "@octokit/auth-app";
import type { MintFn, MintedToken } from "./auth.ts";

/**
 * Production mint function: signs an RS256 app JWT (<=10 min) and exchanges it
 * for an installation access token via `@octokit/auth-app`. Kept out of `auth.ts`
 * so the cache logic there stays dependency-free and offline-testable.
 */
export function octokitMintFn(appId: string, privateKey: string): MintFn {
  const auth = createAppAuth({ appId, privateKey });
  return async (installationId: string): Promise<MintedToken> => {
    // `auth.ts` owns caching; without `refresh` auth-app returns its own cached
    // token, so a re-mint after a 401 would hand back the revoked one.
    const res = await auth({
      type: "installation",
      installationId: Number(installationId),
      refresh: true,
    });
    return { token: res.token, expiresAt: new Date(res.expiresAt) };
  };
}
