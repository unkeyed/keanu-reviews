import { afterEach, describe, expect, it, vi } from "vitest";
import { type AnonymousFetch, commentImages, createGithubAttachmentMirror } from "./attachments.ts";

const id = "1710cd7e-6589-4445-889a-a5666b859fc5";
const attachment = `https://github.com/user-attachments/assets/${id}`;
const publicUrl = "https://bot.example.com";
const secret = "oauth-state-secret-of-at-least-32-chars";
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const served =
  (contentType: string, status = 200) =>
  async () =>
    new Response(bytes, { status, headers: { "content-type": contentType } });

// The path the bot handed Slack while GitHub still served the attachment.
async function mintedPath(url = attachment, mintSecret = secret): Promise<string> {
  const mirror = createGithubAttachmentMirror({
    publicUrl,
    secret: mintSecret,
    fetch: served("image/png"),
  });
  const [img] = await mirror.embedImages([{ url, alt: "shot" }]);
  if (img?.kind !== "embed") throw new Error("expected the minting mirror to embed");
  return new URL(img.imageUrl).pathname;
}

const hangsUntilAborted: AnonymousFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GitHub attachment mirror", () => {
  const upstreams: [string, AnonymousFetch, "embed" | "link"][] = [
    ["png", served("image/png"), "embed"],
    ["jpeg", served("image/jpeg; charset=binary"), "embed"],
    ["gif", served("image/gif"), "embed"],
    ["webp", served("image/webp"), "link"],
    ["svg", served("image/svg+xml"), "link"],
    ["video", served("video/mp4"), "link"],
    ["html", served("text/html"), "link"],
    ["a content type named like an Object.prototype key", served("constructor"), "link"],
    ["404 (deleted or not public)", served("text/plain", 404), "link"],
    ["expired S3 signature", served("application/xml", 403), "link"],
    [
      "network error",
      async () => {
        throw new TypeError("fetch failed");
      },
      "link",
    ],
    ["no headers within 5 s", hangsUntilAborted, "link"],
  ];

  it.each(upstreams)(
    "embeds exactly what the route serves: %s",
    async (_name, upstream, expected) => {
      const minted = await mintedPath();
      vi.useFakeTimers();
      const fetch = vi.fn(upstream);
      const mirror = createGithubAttachmentMirror({ publicUrl, secret, fetch });

      const pending = mirror.embedImages([{ url: attachment, alt: "shot" }]);
      await vi.advanceTimersByTimeAsync(5_000);
      const [img] = await pending;

      const path = img?.kind === "embed" ? new URL(img.imageUrl).pathname : minted;
      const served = mirror.route.request(path);
      await vi.advanceTimersByTimeAsync(5_000);
      const res = await served;

      expect(img?.kind).toBe(expected);
      expect(img?.kind === "embed").toBe(res.status === 200);
      for (const [url, init] of fetch.mock.calls) {
        expect(url).toBe(attachment);
        expect(init).not.toHaveProperty("headers");
      }
    },
  );

  it("embeds a stable URL on our origin, with the extension of the type GitHub serves", async () => {
    const mirror = createGithubAttachmentMirror({ publicUrl, secret, fetch: served("image/gif") });
    expect(await mirror.embedImages([{ url: attachment, alt: "shot" }])).toEqual([
      {
        kind: "embed",
        imageUrl: expect.stringMatching(
          new RegExp(`^${publicUrl}/github-attachments/[A-Za-z0-9_-]+/${id}\\.gif$`),
        ),
        sourceUrl: attachment,
        alt: "shot",
      },
    ]);
  });

  it("links to GitHub when it won't serve the attachment as a Slack image", async () => {
    const mirror = createGithubAttachmentMirror({
      publicUrl,
      secret,
      fetch: served("text/plain", 404),
    });
    expect(await mirror.embedImages([{ url: attachment, alt: "shot" }])).toEqual([
      { kind: "link", sourceUrl: attachment, alt: "shot" },
    ]);
  });

  it("passes other image URLs through for Slack to fetch, without fetching them", async () => {
    const fetch = vi.fn(served("image/png"));
    const mirror = createGithubAttachmentMirror({ publicUrl, secret, fetch });
    const url = "https://img.example.com/a.png";
    expect(await mirror.embedImages([{ url, alt: "a" }])).toEqual([
      { kind: "embed", imageUrl: url, sourceUrl: url, alt: "a" },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches GitHub anonymously by default", async () => {
    const globalFetch = vi.fn(served("image/png"));
    vi.stubGlobal("fetch", globalFetch);
    const mirror = createGithubAttachmentMirror({ publicUrl, secret });

    const [img] = await mirror.embedImages([{ url: attachment, alt: "shot" }]);
    const res = await mirror.route.request(
      new URL(img?.kind === "embed" ? img.imageUrl : "").pathname,
    );
    expect(res.status).toBe(200);

    expect(globalFetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of globalFetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).toBe(attachment);
      expect(init).not.toHaveProperty("headers");
      expect(init).not.toHaveProperty("credentials");
    }
  });

  it("serves the bytes as an immutable, sandboxed image", async () => {
    const mirror = createGithubAttachmentMirror({ publicUrl, secret, fetch: served("image/png") });
    const res = await mirror.route.request(await mintedPath());

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
  });

  it("never caches a miss", async () => {
    const mirror = createGithubAttachmentMirror({
      publicUrl,
      secret,
      fetch: served("text/plain", 404),
    });
    const res = await mirror.route.request(await mintedPath());
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("404s anything that isn't a URL it minted, without calling GitHub", async () => {
    const other = "257e0ab0-5b6e-496e-9762-cedb27e67783";
    const sig = (await mintedPath()).split("/")[2];
    const forgedSig = `${sig?.slice(0, -1)}${sig?.endsWith("A") ? "B" : "A"}`;
    const fetch = vi.fn(served("image/png"));
    const mirror = createGithubAttachmentMirror({ publicUrl, secret, fetch });
    const paths = [
      `/github-attachments/${id}.png`,
      `/github-attachments/${forgedSig}/${id}.png`,
      `/github-attachments/${sig}/${other}.png`,
      `/github-attachments/${sig?.slice(0, 8)}/${id}.png`,
      `/github-attachments//${id}.png`,
      await mintedPath(attachment, "a-different-secret-of-at-least-32-chars"),
      ...["..%2F..%2Fsettings", id, `${id}.svg`, `${id}.png.html`].map(
        (file) => `/github-attachments/${sig}/${file}`,
      ),
    ];
    for (const path of paths) {
      expect((await mirror.route.request(path)).status, path).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serves a URL minted before a restart that kept the secret", async () => {
    const mirror = createGithubAttachmentMirror({ publicUrl, secret, fetch: served("image/png") });
    expect((await mirror.route.request(await mintedPath())).status).toBe(200);
  });

  it("answers HEAD with GET's headers and releases the upstream body", async () => {
    const cancel = vi.fn();
    const upstream: AnonymousFetch = async () =>
      new Response(new ReadableStream({ pull() {}, cancel }), {
        headers: { "content-type": "image/png", "content-length": "4" },
      });
    const mirror = createGithubAttachmentMirror({ publicUrl, secret, fetch: upstream });
    const path = await mintedPath();

    const get = await mirror.route.request(path);
    await get.body?.cancel();
    cancel.mockClear();
    const head = await mirror.route.request(path, { method: "HEAD" });

    expect(head.status).toBe(200);
    expect(Object.fromEntries(head.headers)).toEqual(Object.fromEntries(get.headers));
    expect(head.headers.get("content-length")).toBe("4");
    expect(head.body).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("stops fetching from GitHub when the viewer disconnects first", async () => {
    const upstream = vi.fn<AnonymousFetch>(hangsUntilAborted);
    const mirror = createGithubAttachmentMirror({ publicUrl, secret, fetch: upstream });
    const viewer = new AbortController();

    const res = mirror.route.request(await mintedPath(), { signal: viewer.signal });
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
    viewer.abort();

    expect(upstream.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect((await res).status).toBe(404);
  });

  it("mirrors GitHub's older repo-scoped attachment URL as the same attachment", async () => {
    const fetch = vi.fn<AnonymousFetch>(served("image/png"));
    const mirror = createGithubAttachmentMirror({ publicUrl, secret, fetch });
    const old = `https://github.com/acme/api/assets/100/${id}`;

    const [img] = await mirror.embedImages([{ url: old, alt: "shot" }]);

    expect(img).toEqual({
      kind: "embed",
      imageUrl: `${publicUrl}${await mintedPath()}`,
      sourceUrl: old,
      alt: "shot",
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([attachment]);
  });

  it("streams a body that takes longer than the headers timeout", async () => {
    vi.useFakeTimers();
    const slowBody: AnonymousFetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal.addEventListener("abort", () => controller.error(init.signal.reason));
            setTimeout(() => {
              controller.enqueue(bytes);
              controller.close();
            }, 30_000);
          },
        }),
        { headers: { "content-type": "image/png" } },
      );
    const path = await mintedPath();
    const mirror = createGithubAttachmentMirror({ publicUrl, secret, fetch: slowBody });

    const res = await mirror.route.request(path);
    const body = res.arrayBuffer();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(new Uint8Array(await body)).toEqual(bytes);
  });
});

describe("commentImages", () => {
  const body = `before ![shot](${attachment}) and ![chart](https://img.example.com/c.png)`;

  it("shows no images from a bot", async () => {
    const embedImages = vi.fn();
    expect(await commentImages({ embedImages }, body, { type: "Bot" })).toEqual([]);
    expect(embedImages).not.toHaveBeenCalled();
  });

  it("asks the mirror about every image in a human's comment", async () => {
    const mirror = createGithubAttachmentMirror({ publicUrl, secret, fetch: served("image/png") });
    expect(await commentImages(mirror, body, { type: "User" })).toEqual([
      {
        kind: "embed",
        imageUrl: `${publicUrl}${await mintedPath()}`,
        sourceUrl: attachment,
        alt: "shot",
      },
      {
        kind: "embed",
        imageUrl: "https://img.example.com/c.png",
        sourceUrl: "https://img.example.com/c.png",
        alt: "chart",
      },
    ]);
  });

  it("shows no images when no mirror is wired", async () => {
    expect(await commentImages({}, body, { type: "User" })).toEqual([]);
  });
});
