import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client.ts";
import { githubLinkConfirmations, oauthStateNonces } from "../schema.ts";
import { createTestDb } from "../testDb.ts";
import { confirmGithubLink, createGithubLinkConfirmation } from "./githubLinks.ts";
import { findByGithubId, upsertIdentity } from "./identities.ts";

const NOW = new Date("2026-08-11T12:00:00Z");
const CODE = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  close = () => testDb.client.close();
});

afterEach(() => close());

const createPending = (over: Partial<Parameters<typeof createGithubLinkConfirmation>[1]> = {}) =>
  createGithubLinkConfirmation(db, {
    nonce: "state-nonce",
    stateExpiresAt: new Date(NOW.getTime() + 10 * 60_000),
    code: CODE,
    slackTeamId: "T123",
    slackUserId: "U7",
    githubUserId: 583231,
    githubLogin: "octocat",
    now: NOW,
    ...over,
  });

describe("GitHub link confirmations", () => {
  it("consumes state once and stores only hashes of browser secrets", async () => {
    await expect(createPending()).resolves.toMatchObject({ outcome: "pending" });
    await expect(createPending({ code: "AgICAgICAgICAgICAgICAgICAgICAgIC" })).resolves.toEqual({
      outcome: "state_replayed",
    });

    const [nonce] = await db.select().from(oauthStateNonces);
    const [pending] = await db.select().from(githubLinkConfirmations);
    expect(nonce?.nonceHash).not.toBe("state-nonce");
    expect(pending?.codeHash).not.toBe(CODE);
  });

  it("does not consume a valid code for the wrong Slack user or team", async () => {
    await createPending();

    await expect(
      confirmGithubLink(db, {
        code: CODE,
        slackTeamId: "T123",
        slackUserId: "U8",
        now: NOW,
      }),
    ).resolves.toEqual({ outcome: "invalid_or_expired" });
    await expect(
      confirmGithubLink(db, {
        code: CODE,
        slackTeamId: "T999",
        slackUserId: "U7",
        now: NOW,
      }),
    ).resolves.toEqual({ outcome: "invalid_or_expired" });
    expect(await db.select().from(githubLinkConfirmations)).toHaveLength(1);
  });

  it("links once for the bound Slack identity and rejects replay", async () => {
    await createPending();
    await expect(
      confirmGithubLink(db, {
        code: CODE,
        slackTeamId: "T123",
        slackUserId: "U7",
        now: NOW,
      }),
    ).resolves.toMatchObject({ outcome: "linked" });
    expect(await findByGithubId(db, 583231)).toMatchObject({
      githubLogin: "octocat",
      slackUserId: "U7",
      source: "self-link",
    });
    await expect(
      confirmGithubLink(db, {
        code: CODE,
        slackTeamId: "T123",
        slackUserId: "U7",
        now: NOW,
      }),
    ).resolves.toEqual({ outcome: "invalid_or_expired" });
  });

  it("deletes expired confirmations and nonce-consumption records", async () => {
    const expiresAt = new Date(NOW.getTime() + 1_000);
    await createPending({ stateExpiresAt: expiresAt });

    await expect(
      confirmGithubLink(db, {
        code: CODE,
        slackTeamId: "T123",
        slackUserId: "U7",
        now: expiresAt,
      }),
    ).resolves.toEqual({ outcome: "invalid_or_expired" });
    expect(await db.select().from(githubLinkConfirmations)).toHaveLength(0);
    expect(await db.select().from(oauthStateNonces)).toHaveLength(0);
  });

  it("consumes a confirmation that conflicts with an existing owner", async () => {
    await upsertIdentity(db, {
      githubUserId: 583231,
      githubLogin: "existing",
      slackUserId: "UOWNER",
      source: "admin-import",
    });
    await createPending();

    await expect(
      confirmGithubLink(db, {
        code: CODE,
        slackTeamId: "T123",
        slackUserId: "U7",
        now: NOW,
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    expect(await db.select().from(githubLinkConfirmations)).toHaveLength(0);
    expect(await findByGithubId(db, 583231)).toMatchObject({ slackUserId: "UOWNER" });
  });
});
