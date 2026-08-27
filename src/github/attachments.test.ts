import { describe, expect, it, vi } from "vitest";
import { resolveEmbeddedImages } from "./attachments.ts";

const response = (status: number, location: string | null) =>
  ({
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "location" ? location : null) },
  }) as unknown as Response;

const attachment = "https://github.com/user-attachments/assets/40d17cf7-baa5";

describe("resolveEmbeddedImages", () => {
  it("resolves a GitHub attachment URL to its redirect target", async () => {
    const fetchFn = vi.fn(async () => response(302, "https://s3.example.com/asset.png?sig=1"));
    const out = await resolveEmbeddedImages(
      [{ url: attachment, alt: "shot" }],
      fetchFn as unknown as typeof fetch,
    );
    expect(out).toEqual([{ url: "https://s3.example.com/asset.png?sig=1", alt: "shot" }]);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("passes non-attachment URLs through without fetching", async () => {
    const fetchFn = vi.fn();
    const out = await resolveEmbeddedImages(
      [{ url: "https://img.example.com/a.png", alt: "a" }],
      fetchFn as unknown as typeof fetch,
    );
    expect(out).toEqual([{ url: "https://img.example.com/a.png", alt: "a" }]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("drops an attachment that can't be resolved (non-3xx)", async () => {
    const fetchFn = vi.fn(async () => response(404, null));
    const out = await resolveEmbeddedImages(
      [{ url: attachment, alt: "x" }],
      fetchFn as unknown as typeof fetch,
    );
    expect(out).toEqual([]);
  });

  it("keeps the original when a direct (2xx) response has no redirect", async () => {
    const fetchFn = vi.fn(async () => response(200, null));
    const out = await resolveEmbeddedImages(
      [{ url: attachment, alt: "x" }],
      fetchFn as unknown as typeof fetch,
    );
    expect(out).toEqual([{ url: attachment, alt: "x" }]);
  });

  it("drops an attachment when the fetch throws", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network");
    });
    const out = await resolveEmbeddedImages(
      [{ url: attachment, alt: "x" }],
      fetchFn as unknown as typeof fetch,
    );
    expect(out).toEqual([]);
  });
});
