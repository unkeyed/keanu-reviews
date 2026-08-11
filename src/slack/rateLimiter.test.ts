import { describe, expect, it, vi } from "vitest";
import { withRetry } from "./rateLimiter.ts";

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
