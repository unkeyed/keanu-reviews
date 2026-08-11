import { describe, expect, it } from "vitest";
import { buildBlobPermalink } from "./permalink.ts";

describe("buildBlobPermalink (KTD5)", () => {
  it("builds a SHA-pinned blob link with a single-line anchor", () => {
    expect(
      buildBlobPermalink({
        repoFullName: "unkey/api",
        sha: "abc123",
        path: "src/handlers/auth.ts",
        line: 42,
      }),
    ).toBe("https://github.com/unkey/api/blob/abc123/src/handlers/auth.ts#L42");
  });

  it("produces a ranged anchor for a multi-line comment", () => {
    expect(
      buildBlobPermalink({
        repoFullName: "unkey/api",
        sha: "abc",
        path: "a.ts",
        line: 20,
        startLine: 10,
      }),
    ).toBe("https://github.com/unkey/api/blob/abc/a.ts#L10-L20");
  });

  it("URL-encodes path segments with spaces/special chars", () => {
    const url = buildBlobPermalink({
      repoFullName: "unkey/api",
      sha: "abc",
      path: "src/my dir/a b.ts",
      line: 1,
    });
    expect(url).toBe("https://github.com/unkey/api/blob/abc/src/my%20dir/a%20b.ts#L1");
  });
});
