/**
 * Installation token provider (U3). GitHub installation tokens live ~1h and have
 * no refresh endpoint — you re-mint. This caches per installation and refreshes
 * on expiry (with a safety skew) or when a caller reports a 401.
 *
 * The actual mint (JWT -> installation token) is injected so the core cache logic
 * is testable offline; production wires `@octokit/auth-app` via `octokitMintFn`.
 */

export interface MintedToken {
  token: string;
  /** Absolute expiry. */
  expiresAt: Date;
}

export type MintFn = (installationId: string) => Promise<MintedToken>;

const REFRESH_SKEW_MS = 5 * 60_000; // refresh 5 min before expiry

export interface InstallationAuth {
  getToken(installationId: string): Promise<string>;
  invalidate(installationId: string): void;
}

export function createInstallationAuth(
  mint: MintFn,
  now: () => number = Date.now,
): InstallationAuth {
  const cache = new Map<string, MintedToken>();

  return {
    async getToken(installationId) {
      const cached = cache.get(installationId);
      const fresh = cached && cached.expiresAt.getTime() - REFRESH_SKEW_MS > now();
      if (fresh && cached) return cached.token;

      const minted = await mint(installationId);
      cache.set(installationId, minted);
      return minted.token;
    },
    invalidate(installationId) {
      cache.delete(installationId);
    },
  };
}
