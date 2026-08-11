import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { findByGithubId } from "../db/repositories/identities.ts";
import { createTestDb } from "../db/testDb.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import { importIdentities } from "./link.ts";

let db: Db;
let slack: FakeSlackClient;
let close: () => Promise<void>;

const users: Record<string, { id: number; login: string }> = {
  octocat: { id: 1, login: "octocat" },
  flo: { id: 2, login: "flo" },
};
const fetchGithubUser = vi.fn(async (login: string) => users[login]);

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackClient();
  slack.emailToUser.set("flo@unkey.com", "U2");
});
afterEach(() => close());

describe("importIdentities (U9 admin bulk-import)", () => {
  it("imports valid rows and skips malformed / unknown ones", async () => {
    const result = await importIdentities({ db, slack, fetchGithubUser }, [
      { github_login: "octocat", slack_user_id: "U1" }, // direct id
      { github_login: "flo", slack_email: "flo@unkey.com" }, // email -> lookup
      { github_login: "ghost", slack_user_id: "U9" }, // unknown login -> skip
      { slack_user_id: "U5" }, // missing github_login -> skip
    ]);
    expect(result.imported).toBe(2);
    expect(result.skipped).toHaveLength(2);
    expect((await findByGithubId(db, 1))?.slackUserId).toBe("U1");
    expect((await findByGithubId(db, 2))?.slackUserId).toBe("U2");
  });
});
