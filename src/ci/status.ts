/** CI conclusion presentation (U7). */
const CONCLUSION: Record<string, string> = {
  success: "✅ passed",
  failure: "❌ failed",
  neutral: "➖ neutral",
  cancelled: "🚫 cancelled",
  timed_out: "⏱️ timed out",
  action_required: "⚠️ action required",
  skipped: "⏭️ skipped",
  stale: "🕸️ stale",
};

export function conclusionLabel(conclusion: string): string {
  return CONCLUSION[conclusion] ?? conclusion;
}

/** Fetch every PR number that a commit heads (fallback when associations aren't stored). */
export type PrForShaFetcher = (repoFullName: string, sha: string) => Promise<number[]>;
