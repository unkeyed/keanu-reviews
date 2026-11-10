/**
 * A primitive that means one thing. Each brand is minted by exactly one file,
 * which the architecture test enforces, so a value of the type always came
 * from that minter.
 */
type Brand<T, B extends string> = T & { readonly __brand: B };

/** `${repo}#${number}`, the stable pull_requests row id. Minted in pr/store.ts. */
export type PrId = Brand<string, "PrId">;

/** The UUID-shaped id Slack dedupes a post by. Minted in slack/ledger.ts. */
export type ClientMsgId = Brand<string, "ClientMsgId">;

/** Orders PR snapshots whose GitHub updated_at ties. Minted in events/arrival.ts. */
export type ArrivalKey = Brand<string, "ArrivalKey">;
