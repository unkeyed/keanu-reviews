import type { MiddlewareHandler } from "hono";

/** An OAuth callback page is never cached, framed, sniffed, or sent on as a referrer. */
export const callbackHeaders: MiddlewareHandler = async (c, next) => {
  c.header("cache-control", "no-store");
  c.header("pragma", "no-cache");
  c.header("referrer-policy", "no-referrer");
  c.header(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  await next();
};

/** A one-message HTML page titled `title`. */
export const callbackPage =
  (title: string) =>
  (message: string): string =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><p>${message}</p></main></body></html>`;
