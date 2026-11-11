type Brand<T, B extends string> = T & { readonly __brand: B };

export type PrId = Brand<string, "PrId">;

export type ClientMsgId = Brand<string, "ClientMsgId">;

export type ArrivalKey = Brand<string, "ArrivalKey">;
