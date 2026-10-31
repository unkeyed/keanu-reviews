import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type MintFn, createInstallationAuth } from "./auth.ts";
import { octokitMintFn } from "./octokitAuth.ts";

const mintReturning = (token: string, expiresInMs: number, now: () => number): MintFn =>
  vi.fn(async () => ({ token, expiresAt: new Date(now() + expiresInMs) }));

describe("createInstallationAuth", () => {
  it("caches and reuses a token while fresh", async () => {
    const now = () => 1_000_000;
    const mint = mintReturning("tok-1", 60 * 60_000, now);
    const auth = createInstallationAuth(mint, now);
    expect(await auth.getToken("42")).toBe("tok-1");
    expect(await auth.getToken("42")).toBe("tok-1");
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("re-mints when the cached token is within the refresh skew of expiry", async () => {
    let t = 1_000_000;
    const now = () => t;
    const mint = vi.fn(async () => ({ token: `tok-${t}`, expiresAt: new Date(t + 6 * 60_000) }));
    const auth = createInstallationAuth(mint, now);
    const first = await auth.getToken("42");
    t += 2 * 60_000; // now within the 5-min refresh skew of the 6-min token
    const second = await auth.getToken("42");
    expect(second).not.toBe(first);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("forces a re-mint after a reported 401 invalidates the token", async () => {
    const now = () => 1_000_000;
    const mint = vi.fn(async () => ({ token: "tok", expiresAt: new Date(now() + 60 * 60_000) }));
    const auth = createInstallationAuth(mint, now);
    await auth.getToken("42");
    auth.invalidate("42");
    await auth.getToken("42");
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("fails a stalled mint after 10s and mints again on the next call", async () => {
    vi.useFakeTimers();
    try {
      const now = () => 1_000_000;
      const mint = vi
        .fn<MintFn>()
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValueOnce({ token: "tok", expiresAt: new Date(now() + 60 * 60_000) });
      const auth = createInstallationAuth(mint, now);

      const stalled = expect(auth.getToken("42")).rejects.toThrow(/timed out after 10000ms/);
      await vi.advanceTimersByTimeAsync(10_000);
      await stalled;

      expect(await auth.getToken("42")).toBe("tok");
      expect(mint).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("octokitMintFn", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mints a new installation token on every call instead of reusing auth-app's cache", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({ token: `tok-${urls.length}`, expires_at: "2099-01-01T00:00:00Z" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const mint = octokitMintFn("1", privateKey);

    expect((await mint("42")).token).toBe("tok-1");
    expect((await mint("42")).token).toBe("tok-2");
    expect(urls).toEqual([
      "https://api.github.com/app/installations/42/access_tokens",
      "https://api.github.com/app/installations/42/access_tokens",
    ]);
  });
});
