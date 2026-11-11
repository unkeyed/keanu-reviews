import { describe, expect, it } from "vitest";
import { type Author, commentPresentation, reviewPresentation } from "./author.ts";

const profile = { name: "Flo Rider", iconUrl: "https://slack/a.png" };
const user = (p: typeof profile | undefined): Author => ({
  kind: "user",
  login: "flo",
  slackUserId: "U7",
  token: "xoxp-flo",
  profile: p,
});
const linked = (p: typeof profile | { iconUrl: string } | undefined): Author => ({
  kind: "linked",
  login: "flo",
  slackUserId: "U7",
  profile: p,
});
const unlinked: Author = { kind: "unlinked", login: "flo" };
const asUser = { kind: "user", userId: "U7", token: "xoxp-flo" };

describe("commentPresentation", () => {
  it.each([
    ["a user token with a profile name", user(profile), asUser, undefined],
    // Known quirk kept as is: the label follows the profile name, not the poster.
    ["a user token without a profile name", user(undefined), asUser, "flo"],
    [
      "a linked profile",
      linked(profile),
      { kind: "bot-as", username: "Flo Rider", iconUrl: "https://slack/a.png" },
      undefined,
    ],
    [
      "a linked user with only an avatar",
      linked({ iconUrl: "https://slack/a.png" }),
      { kind: "bot-as", username: undefined, iconUrl: "https://slack/a.png" },
      "flo",
    ],
    ["an unlinked author", unlinked, { kind: "bot" }, "flo"],
  ])("posts %s", (_, author, poster, label) => {
    expect(commentPresentation(author)).toEqual({ poster, label });
  });
});

describe("reviewPresentation", () => {
  it.each([
    ["a user token", user(undefined), asUser, undefined],
    ["a linked profile, never spoofed", linked(profile), { kind: "bot" }, "Flo Rider"],
    ["a linked user without a name", linked(undefined), { kind: "bot" }, "flo"],
    ["an unlinked author", unlinked, { kind: "bot" }, "flo"],
  ])("posts %s", (_, author, poster, label) => {
    expect(reviewPresentation(author)).toEqual({ poster, label });
  });
});
