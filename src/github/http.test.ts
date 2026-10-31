import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallationAuth } from "./auth.ts";
import { githubGetJson, githubPostJson } from "./http.ts";

const auth: InstallationAuth = {
  getToken: async () => "token",
  invalidate: () => {},
};

function trackedResponse(status: number, value: unknown) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
  return { response, cancelled: () => cancelled };
}

describe("GitHub HTTP bodies", () => {
  it("releases the 401 body before retrying with a fresh token", async () => {
    const unauthorized = trackedResponse(401, { message: "Bad credentials" });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized.response)
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await expect(githubGetJson(auth, "42", "/users/octocat", { fetch: fetchFn })).resolves.toEqual({
      ok: true,
    });
    expect(unauthorized.cancelled()).toBe(true);
  });

  it("releases a 404 body when reporting absence", async () => {
    const missing = trackedResponse(404, { message: "Not Found" });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(missing.response);

    await expect(
      githubGetJson(auth, "42", "/users/missing", { fetch: fetchFn }),
    ).resolves.toBeUndefined();
    expect(missing.cancelled()).toBe(true);
  });

  it("releases an error body when throwing for a non-OK status", async () => {
    const failed = trackedResponse(502, { message: "Bad Gateway" });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(failed.response);

    await expect(
      githubGetJson(auth, "42", "/users/octocat", { fetch: fetchFn }),
    ).rejects.toMatchObject({ kind: "http", status: 502 });
    expect(failed.cancelled()).toBe(true);
  });

  it.each([201, 403])("releases the POST response body for HTTP %i", async (status) => {
    const posted = trackedResponse(status, { id: 1 });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(posted.response);

    await githubPostJson(
      auth,
      "42",
      "/repos/unkey/api/issues/1/comments",
      { body: "hi" },
      {
        fetch: fetchFn,
      },
    ).catch(() => {});
    expect(posted.cancelled()).toBe(true);
  });
});

describe("GitHub HTTP timeouts", () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
  });

  it("reports a body that stalls past the timeout as a timeout", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"id":');
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const local: typeof fetch = (_url, init) => fetch(`http://127.0.0.1:${port}/`, init);

    await expect(
      githubGetJson(auth, "42", "/users/octocat", { fetch: local, timeoutMs: 100 }),
    ).rejects.toMatchObject({ name: "GithubApiError", kind: "timeout" });
  });
});
