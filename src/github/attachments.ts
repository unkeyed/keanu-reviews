import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { type EmbeddedImage, extractEmbeddedImages } from "../slack/blocks.ts";
import type { MessageImage } from "../slack/client.ts";
import { isBotActor } from "./actors.ts";

// GitHub serves a pasted image at `github.com/user-attachments/assets/<uuid>`,
// which 302s to an S3 URL signed for 300 s. Older pastes use
// `github.com/<owner>/<repo>/assets/<uid>/<uuid>`, which redirects to the same
// object. Slack re-fetches image URLs whenever it renders.
//
// Never add credentials here. Anyone holding a mirror URL gets the bytes, and
// GitHub only serves a private-repo attachment to a signed-in request, so a token
// would make private screenshots readable by anyone who sees the Slack message.

const ROUTE_PREFIX = "/github-attachments";
const GITHUB_ATTACHMENT_ORIGIN = "https://github.com/user-attachments/assets/";
const UPSTREAM_HEADERS_TIMEOUT_MS = 5_000;
const SIGNATURE_CHARS = 22;

const SLACK_IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
} as const;
type SlackImageContentType = keyof typeof SLACK_IMAGE_TYPES;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MIRROR_FILE_RE = new RegExp(
  `^(${UUID})\\.(?:${Object.values(SLACK_IMAGE_TYPES).join("|")})$`,
  "i",
);
const ATTACHMENT_PATH_RE = new RegExp(
  `^/(?:user-attachments/assets|[^/]+/[^/]+/assets/\\d+)/(${UUID})$`,
  "i",
);

type AttachmentId = string & { readonly __brand: "GithubAttachmentId" };

interface PublicAttachment {
  contentType: SlackImageContentType;
  contentLength: string | undefined;
  body: ReadableStream<Uint8Array>;
}

export type AnonymousFetch = (
  url: string,
  init: { redirect: "follow"; signal: AbortSignal },
) => Promise<Response>;

export type ImageEmbedder = (images: readonly EmbeddedImage[]) => Promise<MessageImage[]>;

export interface GithubAttachmentMirror {
  embedImages: ImageEmbedder;
  route: Hono;
}

export function createGithubAttachmentMirror(opts: {
  publicUrl: string;
  secret: string;
  fetch?: AnonymousFetch;
}): GithubAttachmentMirror {
  const fetchFn: AnonymousFetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  // Serving only URLs the bot minted keeps strangers from spending the bot's
  // anonymous GitHub rate limit, which would break every image it has posted.
  const key = createHmac("sha256", opts.secret).update("github-attachments").digest();
  const sign = (id: AttachmentId) =>
    createHmac("sha256", key).update(id).digest("base64url").slice(0, SIGNATURE_CHARS);
  const signedBy = (id: AttachmentId, signature: string) => {
    const given = Buffer.from(signature);
    const expected = Buffer.from(sign(id));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const embedImages: ImageEmbedder = (images) =>
    Promise.all(
      images.map(async (img): Promise<MessageImage> => {
        const id = attachmentIdFromUrl(img.url);
        if (!id) return { kind: "embed", imageUrl: img.url, sourceUrl: img.url, alt: img.alt };
        const att = await openPublicAttachment(id, fetchFn);
        if (!att) return { kind: "link", sourceUrl: img.url, alt: img.alt };
        await att.body.cancel();
        return {
          kind: "embed",
          imageUrl: `${opts.publicUrl}${ROUTE_PREFIX}/${sign(id)}/${id}.${SLACK_IMAGE_TYPES[att.contentType]}`,
          sourceUrl: img.url,
          alt: img.alt,
        };
      }),
    );

  const route = new Hono();
  route.get(`${ROUTE_PREFIX}/:signature/:file`, async (c) => {
    const id = MIRROR_FILE_RE.exec(c.req.param("file"))?.[1]?.toLowerCase() as
      | AttachmentId
      | undefined;
    const att =
      id &&
      signedBy(id, c.req.param("signature")) &&
      (await openPublicAttachment(id, fetchFn, c.req.raw.signal));
    if (!att) return c.body(null, 404, { "cache-control": "no-store" });
    const headers = {
      "content-type": att.contentType,
      ...(att.contentLength ? { "content-length": att.contentLength } : {}),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    };
    // Hono answers HEAD with this handler's response minus its body, without
    // cancelling the body, which would hold the upstream connection open.
    if (c.req.method === "HEAD") {
      await att.body.cancel();
      return new Response(null, { headers });
    }
    return new Response(att.body, { headers });
  });

  return { embedImages, route };
}

export async function commentImages(
  deps: { embedImages?: ImageEmbedder },
  body: string,
  author: { type?: string },
): Promise<MessageImage[]> {
  if (isBotActor(author)) return [];
  return deps.embedImages ? deps.embedImages(extractEmbeddedImages(body)) : [];
}

async function openPublicAttachment(
  id: AttachmentId,
  fetchFn: AnonymousFetch,
  viewer?: AbortSignal,
): Promise<PublicAttachment | undefined> {
  // Time the headers only: AbortSignal.timeout would also cut a large body mid-stream.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_HEADERS_TIMEOUT_MS);
  // The server never cancels a body it didn't start sending, so a viewer who
  // leaves before GitHub answers would otherwise pin the upstream socket.
  const res = await fetchFn(GITHUB_ATTACHMENT_ORIGIN + id, {
    redirect: "follow",
    signal: viewer ? AbortSignal.any([controller.signal, viewer]) : controller.signal,
  })
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));
  const type = res?.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!res?.ok || !res.body || !type || !Object.hasOwn(SLACK_IMAGE_TYPES, type)) {
    await res?.body?.cancel();
    return undefined;
  }
  return {
    contentType: type as SlackImageContentType,
    contentLength: res.headers.get("content-length") ?? undefined,
    body: res.body,
  };
}

function attachmentIdFromUrl(url: string): AttachmentId | undefined {
  try {
    const u = new URL(url);
    if (u.hostname !== "github.com") return undefined;
    return ATTACHMENT_PATH_RE.exec(u.pathname)?.[1]?.toLowerCase() as AttachmentId | undefined;
  } catch {
    return undefined;
  }
}
