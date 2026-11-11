import { afterEach, describe, expect, it, vi } from "vitest";
import { Retry } from "#lib";
import type { InstallationAuth } from "./auth.ts";
import { GithubApiError } from "./http.ts";
import { createPullRequestSnapshotFetcher } from "./pullRequestSnapshot.ts";

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
  it("throws a retry at the reset instead of sleeping through a rate limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json(429, { message: "rate limit" }, { "retry-after": "60" }));
    const fetchSnapshot = createPullRequestSnapshotFetcher(auth, "42", { fetch: fetchFn });

    const fetched = fetchSnapshot("unkey/api", 7);
    const settled = await Promise.race([
      fetched.then(
        () => "resolved",
        (error: unknown) => error,
      ),
      vi.advanceTimersByTimeAsync(0).then(() => "still sleeping"),
    ]);

    expect(settled).toBeInstanceOf(Retry);
    expect(settled).toMatchObject({ retryAfterMs: 60_000 });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("throws a retry at the reset when no requests remain", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_000_000);
    const fetchFn = vi.fn<typeof fetch>(async () =>
      json(
        403,
        { message: "API rate limit exceeded" },
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000002" },
      ),
    );
    const fetchSnapshot = createPullRequestSnapshotFetcher(auth, "42", { fetch: fetchFn });

    await expect(fetchSnapshot("unkey/api", 7)).rejects.toMatchObject({
      name: "RateLimited",
      retryAfterMs: 2_000,
    });
  });

  it("recognizes a secondary limit GitHub names only in the body", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      json(
        403,
        { message: "You have exceeded a secondary rate limit" },
        { "x-ratelimit-remaining": "10" },
      ),
    );
    const fetchSnapshot = createPullRequestSnapshotFetcher(auth, "42", { fetch: fetchFn });

    const fetched = fetchSnapshot("unkey/api", 7);
    await expect(fetched).rejects.toBeInstanceOf(Retry);
    await expect(fetched).rejects.toMatchObject({ retryAfterMs: undefined });
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
