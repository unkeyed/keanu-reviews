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
    const res = await auth({ type: "installation", installationId: Number(installationId) });
    return { token: res.token, expiresAt: new Date(res.expiresAt) };
  };
}
