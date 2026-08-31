import { describe, expect, it, vi } from "vitest";
import type { InstallationAuth } from "./auth.ts";
import {
  GithubApiError,
  createGithubEmailFetcher,
  createGithubUserFetcher,
  createPrForShaFetcher,
  createReviewApprovalFetcher,
} from "./users.ts";

const createAuth = (tokens: string[] = ["token-1"]): InstallationAuth => ({
  getToken: vi.fn(async () => tokens.shift() ?? "token-final"),
  invalidate: vi.fn(),
});

const jsonResponse = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("GitHub API fetchers", () => {
  it("returns absence only for a 404", async () => {
    const auth = createAuth();
    const fetchFn = vi.fn(async () => jsonResponse(404, { message: "Not Found" }));
    const fetchUser = createGithubUserFetcher(auth, "42", { fetch: fetchFn });

    await expect(fetchUser("missing")).resolves.toBeUndefined();
  });

  it.each([429, 500, 503])("throws a classified API error for HTTP %i", async (status) => {
    const auth = createAuth();
    const fetchFn = vi.fn(async () => jsonResponse(status, { message: "unavailable" }));
    const fetchEmail = createGithubEmailFetcher(auth, "42", { fetch: fetchFn });

    await expect(fetchEmail("octocat")).rejects.toMatchObject({
      name: "GithubApiError",
      kind: "http",
      status,
    });
  });

  it("invalidates the installation token and retries once after a 401", async () => {
    const auth = createAuth(["stale-token", "fresh-token"]);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(401, { message: "Bad credentials" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 583231, login: "octocat" }));
    const fetchUser = createGithubUserFetcher(auth, "42", { fetch: fetchFn });

    await expect(fetchUser("octocat")).resolves.toEqual({ id: 583231, login: "octocat" });
    expect(auth.invalidate).toHaveBeenCalledOnce();
    expect(auth.invalidate).toHaveBeenCalledWith("42");
    expect(auth.getToken).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer stale-token",
    });
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer fresh-token",
    });
  });

  it("does not retry a second 401", async () => {
    const auth = createAuth(["stale-token", "still-invalid"]);
    const fetchFn = vi.fn(async () => jsonResponse(401, { message: "Bad credentials" }));
    const fetchUser = createGithubUserFetcher(auth, "42", { fetch: fetchFn });

    await expect(fetchUser("octocat")).rejects.toMatchObject({
      name: "GithubApiError",
      kind: "http",
      status: 401,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(auth.invalidate).toHaveBeenCalledOnce();
  });

  it("aborts a stalled request at the configured timeout", async () => {
    const auth = createAuth();
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const fetchUser = createGithubUserFetcher(auth, "42", { fetch: fetchFn, timeoutMs: 5 });
    const request = fetchUser("octocat");

    await expect(request).rejects.toBeInstanceOf(GithubApiError);
    await expect(request).rejects.toMatchObject({ kind: "timeout" });
  });

  it("returns every associated pull request number", async () => {
    const auth = createAuth();
    const fetchFn = vi.fn(async () => jsonResponse(200, [{ number: 7 }, { number: 9 }]));
    const fetchPrs = createPrForShaFetcher(auth, "42", { fetch: fetchFn });

    await expect(fetchPrs("unkeyed/example", "abc123")).resolves.toEqual([7, 9]);
  });

  it("counts current approvals: latest decision per reviewer, ignoring comments", async () => {
    const auth = createAuth();
    const reviews = [
      { user: { id: 1 }, state: "COMMENTED" }, // ignored
      { user: { id: 1 }, state: "APPROVED" }, // 1 → approved
      { user: { id: 2 }, state: "CHANGES_REQUESTED" },
      { user: { id: 2 }, state: "APPROVED" }, // 2 → latest approved
      { user: { id: 3 }, state: "APPROVED" },
      { user: { id: 3 }, state: "COMMENTED" }, // ignored → 3 stays approved
      { user: { id: 4 }, state: "APPROVED" },
      { user: { id: 4 }, state: "DISMISSED" }, // 4 → dismissed, not counted
    ];
    const fetchFn = vi.fn(async () => jsonResponse(200, reviews));
    const fetchApprovals = createReviewApprovalFetcher(auth, "42", { fetch: fetchFn });

    await expect(fetchApprovals("unkey/api", 7)).resolves.toBe(3); // reviewers 1, 2, 3
  });

  it("returns undefined counting approvals for a missing PR (404)", async () => {
    const auth = createAuth();
    const fetchFn = vi.fn(async () => jsonResponse(404, { message: "Not Found" }));
    const fetchApprovals = createReviewApprovalFetcher(auth, "42", { fetch: fetchFn });

    await expect(fetchApprovals("unkey/api", 7)).resolves.toBeUndefined();
  });
});
