export interface MintedToken {
  token: string;
  expiresAt: Date;
}

export type MintFn = (installationId: string) => Promise<MintedToken>;

const REFRESH_SKEW_MS = 5 * 60_000;
/** auth-app's request takes no AbortSignal, so a stalled mint is bounded here. */
const MINT_TIMEOUT_MS = 10_000;

function mintWithTimeout(mint: MintFn, installationId: string): Promise<MintedToken> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Installation token mint timed out after ${MINT_TIMEOUT_MS}ms`)),
      MINT_TIMEOUT_MS,
    );
  });
  return Promise.race([mint(installationId), timeout]).finally(() => clearTimeout(timer));
}

export interface InstallationAuth {
  getToken(installationId: string): Promise<string>;
  invalidate(installationId: string): void;
}

export function createInstallationAuth(
  mint: MintFn,
  now: () => number = Date.now,
): InstallationAuth {
  const cache = new Map<string, MintedToken>();
  const minting = new Map<string, Promise<MintedToken>>();

  return {
    async getToken(installationId) {
      const cached = cache.get(installationId);
      const fresh = cached && cached.expiresAt.getTime() - REFRESH_SKEW_MS > now();
      if (fresh && cached) return cached.token;

      let pending = minting.get(installationId);
      if (!pending) {
        pending = mintWithTimeout(mint, installationId)
          .then((minted) => {
            cache.set(installationId, minted);
            return minted;
          })
          .finally(() => minting.delete(installationId));
        minting.set(installationId, pending);
      }
      return (await pending).token;
    },
    invalidate(installationId) {
      cache.delete(installationId);
    },
  };
}
