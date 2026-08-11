export type PrState = "draft" | "pr" | "closed" | "merged";

export interface PrFacts {
  draft: boolean;
  merged: boolean;
}

/**
 * Derive the target channel state from a pull_request action + facts (KTD4:
 * state is a function of the latest known PR facts, not event arrival order).
 * Merged has no dedicated action — it is `closed` with `merged === true`.
 * Returns null for actions that carry no state change (e.g. synchronize, edited).
 */
export function computeTargetState(action: string, facts: PrFacts): PrState | null {
  switch (action) {
    case "opened":
    case "reopened":
      return facts.draft ? "draft" : "pr";
    case "ready_for_review":
      return "pr";
    case "converted_to_draft":
      return "draft";
    case "closed":
      return facts.merged ? "merged" : "closed";
    default:
      return null;
  }
}

export const isTerminal = (state: PrState): boolean => state === "closed" || state === "merged";
