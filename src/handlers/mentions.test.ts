import { describe, expect, it } from "vitest";
import { extractGithubMentions } from "./mentions.ts";

describe("extractGithubMentions", () => {
  it("extracts a single login from a sentence", () => {
    expect(extractGithubMentions("Hey @dave-hawkins I need some guidance here")).toEqual([
      "dave-hawkins",
    ]);
  });

  it("extracts multiple logins, de-duplicated and lowercased", () => {
    expect(extractGithubMentions("cc @Alice @bob and again @alice")).toEqual(["alice", "bob"]);
  });

  it("ignores email addresses", () => {
    expect(extractGithubMentions("mail me at dave@example.com please")).toEqual([]);
  });

  it("ignores team mentions like @org/team", () => {
    expect(extractGithubMentions("ping @unkey/api for review")).toEqual([]);
  });

  it("stops at punctuation and does not keep trailing hyphens", () => {
    expect(extractGithubMentions("thanks @dave-hawkins, and @bob!")).toEqual([
      "dave-hawkins",
      "bob",
    ]);
  });

  it("returns nothing for a body with no mentions", () => {
    expect(extractGithubMentions("just a normal comment")).toEqual([]);
  });
});
