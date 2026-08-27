import type { EmbeddedImage } from "../slack/blocks.ts";

const ATTACHMENT_TIMEOUT_MS = 5_000;

/**
 * `github.com/user-attachments/assets/<uuid>` — how GitHub serves images pasted
 * into comments. It has no file extension and 302-redirects to a short-lived
 * signed asset URL, so Slack's image proxy won't render it in an image block.
 */
function isGithubAttachment(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "github.com" && u.pathname.startsWith("/user-attachments/");
  } catch {
    return false;
  }
}

async function resolveAttachmentUrl(
  url: string,
  fetchFn: typeof globalThis.fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchFn(url, {
      method: "GET",
      redirect: "manual", // read the 302 target without downloading the image
      signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS),
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location && /^https:\/\//i.test(location)) {
      return location; // the direct, extensioned signed URL Slack can render
    }
    // No redirect but a healthy response — the URL is already direct; keep it.
    if (res.status >= 200 && res.status < 300) return url;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve GitHub attachment image URLs to their direct target so Slack can fetch
 * (and permanently cache) them; other image URLs pass through unchanged. Runs
 * one lightweight redirect-only request per attachment. Best-effort: an image we
 * can't resolve is dropped rather than shown as a blank block.
 */
export async function resolveEmbeddedImages(
  images: EmbeddedImage[],
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<EmbeddedImage[]> {
  const out: EmbeddedImage[] = [];
  for (const img of images) {
    if (!isGithubAttachment(img.url)) {
      out.push(img);
      continue;
    }
    const resolved = await resolveAttachmentUrl(img.url, fetchFn);
    if (resolved) out.push({ ...img, url: resolved });
  }
  return out;
}
