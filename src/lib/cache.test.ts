import { describe, expect, it, vi } from "vitest";
import { ttlCache } from "./cache.ts";

describe("ttlCache", () => {
  it("keeps a value for the TTL, then loads again", async () => {
    let now = 0;
    const cache = ttlCache<string, number>({ ttlMs: 100, maxEntries: 10, now: () => now });
    const load = vi.fn(async () => now);

    expect(await cache.get("a", load)).toBe(0);
    now = 99;
    expect(await cache.get("a", load)).toBe(0);
    now = 100;
    expect(await cache.get("a", load)).toBe(100);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps an undefined result, shares a load in flight, and drops a failed one", async () => {
    const cache = ttlCache<string, string | undefined>({ ttlMs: 100, maxEntries: 10 });
    const miss = vi.fn(async () => undefined);
    await Promise.all([cache.get("a", miss), cache.get("a", miss)]);
    await cache.get("a", miss);
    expect(miss).toHaveBeenCalledTimes(1);

    const flaky = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce("up");
    await expect(cache.get("b", flaky)).rejects.toThrow("down");
    expect(await cache.get("b", flaky)).toBe("up");
  });

  it("drops the least recently read entry past its bound", async () => {
    const cache = ttlCache<string, string>({ ttlMs: 100, maxEntries: 2 });
    const load = vi.fn(async () => "v");
    await cache.get("a", load);
    await cache.get("b", load);
    await cache.get("a", load);
    await cache.get("c", load);
    expect(load).toHaveBeenCalledTimes(3);

    await cache.get("a", load);
    expect(load).toHaveBeenCalledTimes(3);
    await cache.get("b", load);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
