import { describe, expect, it, vi } from "vitest";
import { Pacer, withRetry } from "./rateLimiter.ts";

describe("withRetry (429 Retry-After, KTD9)", () => {
  it("retries after Retry-After on a 429 then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw { status: 429, retryAfterSeconds: 3 };
      return "ok";
    });
    const result = await withRetry(fn, { sleep });
    expect(result).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and rethrows", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => {
      throw { status: 429, retryAfterSeconds: 1 };
    });
    await expect(withRetry(fn, { sleep, maxRetries: 2 })).rejects.toMatchObject({ status: 429 });
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry a non-429 error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(withRetry(fn)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("Pacer", () => {
  it("preserves the last-send timestamp across sequential calls for a key", async () => {
    let currentTime = 1_000;
    const sleep = vi.fn(async (ms: number) => {
      currentTime += ms;
    });
    const pacer = new Pacer(250, sleep, () => currentTime);

    await pacer.run("channel", async () => "first");
    await pacer.run("channel", async () => "second");

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("tracks pacing independently per key", async () => {
    const sleep = vi.fn(async () => {});
    const pacer = new Pacer(250, sleep, () => 1_000);

    await pacer.run("channel-a", async () => undefined);
    await pacer.run("channel-b", async () => undefined);

    expect(sleep).not.toHaveBeenCalled();
  });

  it("forgets an idle key after its pacing window", async () => {
    vi.useFakeTimers();
    try {
      const sleep = vi.fn(async () => {});
      const pacer = new Pacer(250, sleep, () => 1_000);

      await pacer.run("channel", async () => undefined);
      await vi.advanceTimersByTimeAsync(250);
      await pacer.run("channel", async () => undefined);

      expect(sleep).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
