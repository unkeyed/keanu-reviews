import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallationAuth } from "./auth.ts";
import { GithubApiError } from "./http.ts";
import {
  GithubRateLimitExhaustedError,
  createPullRequestSnapshotFetcher,
} from "./pullRequestSnapshot.ts";

afterEach(() => {
  vi.useRealTimers();
});

const auth: InstallationAuth = {
  getToken: vi.fn(async () => "token"),
  invalidate: vi.fn(),
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function pull(number: number, over: Record<string, unknown> = {}) {
  return {
    id: 1000 + number,
    number,
    state: "closed",
    merged: true,
    draft: false,
    title: `Change ${number}`,
    html_url: `https://github.com/unkey/api/pull/${number}`,
    updated_at: "2026-08-12T15:00:00Z",
    user: { id: 100, login: "oz" },
    head: { sha: `sha${number}`, ref: "feature" },
    base: { ref: "main" },
    ...over,
  };
}

describe("createPullRequestSnapshotFetcher", () => {
  it("backs off on retry-after and then returns the pull request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(429, { message: "rate limit" }, { "retry-after": "2", "x-ratelimit-remaining": "0" }),
      )
      .mockResolvedValueOnce(json(200, pull(7), { "x-ratelimit-remaining": "40" }));
    const fetchSnapshot = createPullRequestSnapshotFetcher(auth, "42", { fetch: fetchFn });

    const fetched = fetchSnapshot("unkey/api", 7);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(fetched).resolves.toMatchObject({
      remaining: 40,
      snapshot: { number: 7, merged: true, state: "closed" },
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("backs off until the rate-limit reset when remaining is zero", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    vi.setSystemTime(1_700_000_000_000);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(
          403,
          { message: "API rate limit exceeded" },
          { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000002" },
        ),
      )
      .mockResolvedValueOnce(json(200, pull(7), { "x-ratelimit-remaining": "5000" }));
    const fetchSnapshot = createPullRequestSnapshotFetcher(auth, "42", { fetch: fetchFn });

    const fetched = fetchSnapshot("unkey/api", 7);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(fetched).resolves.toMatchObject({
      snapshot: { number: 7 },
    });
  });

  it("stops without sleeping when the retry delay is outside the backoff budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const fetchFn = vi.fn<typeof fetch>(async () =>
      json(
        403,
        { message: "You have exceeded a secondary rate limit" },
        { "retry-after": "7200", "x-ratelimit-remaining": "10" },
      ),
    );
    const fetchSnapshot = createPullRequestSnapshotFetcher(auth, "42", { fetch: fetchFn });

    await expect(fetchSnapshot("unkey/api", 7)).rejects.toBeInstanceOf(
      GithubRateLimitExhaustedError,
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("returns absence for a missing pull request and reports remaining budget", async () => {
    const fetchFn = vi.fn(async () =>
      json(404, { message: "Not Found" }, { "x-ratelimit-remaining": "8" }),
    );
    const fetchSnapshot = createPullRequestSnapshotFetcher(auth, "42", { fetch: fetchFn });

    await expect(fetchSnapshot("unkey/api", 7)).resolves.toEqual({
      snapshot: undefined,
      remaining: 8,
    });
  });

  it("throws a normal API error for a non-rate-limit failure", async () => {
    const fetchFn = vi.fn(async () =>
      json(500, { message: "boom" }, { "x-ratelimit-remaining": "8" }),
    );
    const fetchSnapshot = createPullRequestSnapshotFetcher(auth, "42", { fetch: fetchFn });

    await expect(fetchSnapshot("unkey/api", 7)).rejects.toBeInstanceOf(GithubApiError);
    await expect(fetchSnapshot("unkey/api", 7)).rejects.toMatchObject({ status: 500 });
  });
});
