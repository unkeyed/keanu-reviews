import { normalizeBotName } from "#config";
import type { GithubActor } from "#events";

export function shouldSkipActor(
  actor: Pick<GithubActor, "isBot" | "login">,
  allowedBots: ReadonlySet<string> = new Set(),
): boolean {
  if (!actor.isBot) return false;
  const login = normalizeBotName(actor.login);
  return !(login && allowedBots.has(login));
}
