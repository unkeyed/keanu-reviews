import type { PrState } from "./types.ts";

export const isTerminal = (state: PrState): boolean => state === "closed" || state === "merged";

export type StateClaim =
  | { kind: "asserted"; state: PrState }
  | { kind: "open-hint"; draft: boolean };

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

export function nextState(stored: PrState | undefined, claim: StateClaim): PrState {
  if (claim.kind === "asserted") return claim.state;
  if (stored && isTerminal(stored)) return stored;
  return claim.draft ? "draft" : "pr";
}
