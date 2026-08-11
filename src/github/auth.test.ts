import { describe, expect, it, vi } from "vitest";
import { type MintFn, createInstallationAuth } from "./auth.ts";

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

  it("forces a re-mint after a reported 401 (invalidate / forceRefresh)", async () => {
    const now = () => 1_000_000;
    const mint = vi.fn(async () => ({ token: "tok", expiresAt: new Date(now() + 60 * 60_000) }));
    const auth = createInstallationAuth(mint, now);
    await auth.getToken("42");
    await auth.getToken("42", { forceRefresh: true });
    expect(mint).toHaveBeenCalledTimes(2);
  });
});
