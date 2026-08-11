/**
 * SHA-pinned blob permalinks (KTD5) — the marquee feature (R4). Format:
 *   https://github.com/<owner>/<repo>/blob/<sha>/<path>#L<line>
 * Pinned to the commit SHA so the link doesn't drift as the file changes.
 * Multi-line comments produce a ranged anchor `#L<start>-L<line>`.
 */
export interface PermalinkInput {
  repoFullName: string;
  sha: string;
  path: string;
  line: number;
  startLine?: number | null;
}

export function buildBlobPermalink(input: PermalinkInput): string {
  const encodedPath = input.path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const anchor =
    input.startLine && input.startLine !== input.line
      ? `#L${input.startLine}-L${input.line}`
      : `#L${input.line}`;
  return `https://github.com/${input.repoFullName}/blob/${input.sha}/${encodedPath}${anchor}`;
}
