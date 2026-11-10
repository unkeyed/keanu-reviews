import type { PrState } from "./types.ts";

export const isTerminal = (state: PrState): boolean => state === "closed" || state === "merged";

/**
 * What one source says the state is. Lifecycle actions assert it. Every other
 * source only hints at the open state through its `draft` fact: it may flip
 * draft and pr, but never revives a closed PR or closes an open one.
 */
export type StateClaim =
  | { kind: "asserted"; state: PrState }
  | { kind: "open-hint"; draft: boolean };

/** Merged has no dedicated action: it is `closed` with `merged === true`. */
export function claimFromAction(action: string, draft: boolean, merged: boolean): StateClaim {
  switch (action) {
    case "opened":
    case "reopened":
      return { kind: "asserted", state: draft ? "draft" : "pr" };
    case "ready_for_review":
      return { kind: "asserted", state: "pr" };
    case "converted_to_draft":
      return { kind: "asserted", state: "draft" };
    case "closed":
      return { kind: "asserted", state: merged ? "merged" : "closed" };
    default:
      return { kind: "open-hint", draft };
  }
}

/**
 * State follows the latest PR facts, not event order. The open hint lets a lost
 * or out-of-order `ready_for_review` self-heal on the next event; without it a
 * channel stays stuck at `draft-` forever.
 */
export function nextState(stored: PrState | undefined, claim: StateClaim): PrState {
  if (claim.kind === "asserted") return claim.state;
  if (stored && isTerminal(stored)) return stored;
  return claim.draft ? "draft" : "pr";
}
