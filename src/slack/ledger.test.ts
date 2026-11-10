import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Retry } from "#lib";
import type { Db } from "../db/client.ts";
import { prId, upsertPullRequest } from "../db/repositories/pullRequests.ts";
import { messages, pullRequests } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
import { type EffectKey, keys } from "./catalog.ts";
import { channelSink, claim, clientMsgId, complete, createLedger, naturalKey } from "./ledger.ts";

let db: Db;
let close: () => Promise<void>;
let slack: FakeSlackGateway;
const PR = prId("unkey/api", 1);

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackGateway();
  await upsertPullRequest(db, {
    repoFullName: "unkey/api",
    number: 1,
    githubPrId: 1,
    currentState: "pr",
  });
});
afterEach(() => close());

const rows = () => db.select().from(messages);
const sink = () => channelSink(slack, "C1");
const lifecycle: EffectKey = { prId: PR, kind: "lifecycle", ref: "opened:sha-1" };

describe("effect identity", () => {
  it("keeps today's natural key and client_msg_id so existing rows keep deduping", async () => {
    expect(naturalKey(lifecycle)).toBe("11:unkey/api#1|9:lifecycle|12:opened:sha-1");
    expect(clientMsgId(naturalKey(lifecycle))).toBe("6327a1a5-feaa-5ae1-95a4-fa9c70e907ae");

    const row = await claim(db, lifecycle, new Date(1_000));
    expect(row?.naturalKey).toBe(naturalKey(lifecycle));
    expect(row?.clientMsgId).toBe("6327a1a5-feaa-5ae1-95a4-fa9c70e907ae");
    expect(row?.slackTs).toBeNull();
    expect(row?.status).toBe("sending");
  });

  it("writes each key's kind and ref in today's formats", () => {
    expect(keys.root(PR)).toEqual({ prId: PR, kind: "root", ref: "root" });
    expect(keys.authorInvite(PR, 100)).toEqual({ prId: PR, kind: "author_invite", ref: "100" });
    expect(keys.lifecycle(PR, "closed", "merged", "abc", "2026-08-11T12:00:00Z")).toEqual({
      prId: PR,
      kind: "lifecycle",
      ref: "closed:merged:abc:2026-08-11T12:00:00Z",
    });
    expect(keys.reviewComment(PR, 55)).toEqual({ prId: PR, kind: "review_comment", ref: "55" });
    expect(keys.issueComment(PR, 56)).toEqual({ prId: PR, kind: "issue_comment", ref: "56" });
    expect(keys.review(PR, 77)).toEqual({ prId: PR, kind: "review", ref: "77" });
    expect(keys.reviewRequest(PR, 7, 2)).toEqual({ prId: PR, kind: "invite", ref: "7:2" });
    expect(keys.reviewRequest(PR, 7, "2026:x")).toEqual({
      prId: PR,
      kind: "invite",
      ref: "7:2026:x",
    });
    expect(keys.reminder(PR, 7, 3)).toEqual({ prId: PR, kind: "reminder", ref: "7:3" });
    expect(keys.shipped(PR)).toEqual({ prId: PR, kind: "shipped", ref: "shipped" });
  });

  it("keeps primary keys database-safe while natural keys deduplicate effects", async () => {
    const row = await claim(db, keys.root(PR), new Date());
    if (!row) throw new Error("expected message claim");
    await complete(db, row, "1.0");

    const [stored] = await rows();
    expect(stored?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("claim lease", () => {
  it("reclaims expired sending effects and fences stale completion", async () => {
    const key = keys.reviewComment(PR, 55);
    const stale = await claim(db, key, new Date(1_000), 5_000);
    expect(stale).toBeDefined();
    expect(await claim(db, key, new Date(5_999), 5_000)).toBeUndefined();
    const current = await claim(db, key, new Date(6_000), 5_000);
    if (!stale || !current) throw new Error("expected effect claims");
    expect(current.clientMsgId).toBe(stale.clientMsgId);
    expect(await complete(db, stale, "stale-ts")).toBe(false);
    expect(await complete(db, current, "real-ts")).toBe(true);
    expect(await createLedger(db).sentTs(key)).toBe("real-ts");
    expect(await claim(db, key, new Date())).toBeUndefined();
  });

  it("keeps a message effect fenced beyond the worker's default job lease", async () => {
    const key = keys.review(PR, 77);
    expect(await claim(db, key, new Date(1_000))).toBeDefined();
    expect(await claim(db, key, new Date(61_000))).toBeUndefined();
    expect(await claim(db, key, new Date(121_000))).toBeDefined();
  });
});

describe("deliver", () => {
  const root = async () => ({
    message: {
      kind: "root" as const,
      pr: {
        repo: "unkey/api",
        number: 1,
        title: "Add auth",
        url: "https://github.com/unkey/api/pull/1",
        authorLogin: "oz",
      },
    },
  });

  it("posts once with the key's client_msg_id and records the Slack ts", async () => {
    const ledger = createLedger(db);
    const delivered = await ledger.deliver(keys.root(PR), sink(), root);

    expect(delivered).toEqual({ status: "posted", ts: "ts-1" });
    expect(slack.messages).toHaveLength(1);
    expect(slack.messages[0]?.clientMsgId).toBe(clientMsgId(naturalKey(keys.root(PR))));
    expect(await ledger.sentTs(keys.root(PR))).toBe("ts-1");
  });

  it("returns an already-sent effect without building it again", async () => {
    const ledger = createLedger(db);
    await ledger.deliver(keys.root(PR), sink(), root);
    const build = vi.fn(root);

    await expect(ledger.deliver(keys.root(PR), sink(), build)).resolves.toEqual({
      status: "already-sent",
      ts: "ts-1",
    });
    expect(build).not.toHaveBeenCalled();
    expect(slack.messages).toHaveLength(1);
  });

  it("posts nothing and leaves no row when the build declines", async () => {
    const ledger = createLedger(db);
    await expect(ledger.deliver(keys.review(PR, 1), sink(), async () => null)).resolves.toEqual({
      status: "skipped",
    });
    expect(slack.messages).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("runs beforePost after the claim and before the post", async () => {
    const order: string[] = [];
    const post = slack.post.bind(slack);
    slack.post = async (channel, msg, opts) => {
      order.push("post");
      return post(channel, msg, opts);
    };

    await createLedger(db).deliver(keys.root(PR), sink(), async () => ({
      ...(await root()),
      beforePost: async () => {
        const [row] = await rows();
        order.push(`invite:${row?.status}`);
      },
    }));

    expect(order).toEqual(["invite:sending", "post"]);
  });

  it("releases the claim when Slack fails so the next attempt posts", async () => {
    const ledger = createLedger(db);
    slack.post = async () => {
      throw new Error("transient Slack failure");
    };
    await expect(ledger.deliver(keys.root(PR), sink(), root)).rejects.toThrow("transient");
    const [row] = await rows();
    expect(row?.status).toBe("pending");
    expect(row?.claimedAt).toBeNull();
  });

  it("asks for a retry, waiting out an orphaned lease, while another holder has the effect", async () => {
    const now = new Date("2026-08-11T12:00:00Z");
    const clock = { now: () => now };
    await claim(db, keys.root(PR), new Date(now.getTime() - 90_000));

    const rejection = createLedger(db, clock).deliver(keys.root(PR), sink(), root);
    await expect(rejection).rejects.toBeInstanceOf(Retry);
    await expect(rejection).rejects.toMatchObject({ retryAfterMs: 30_000 });
    expect(slack.messages).toHaveLength(0);
  });

  it("commits onSentTx with the sent mark, and neither when the lease was lost", async () => {
    const ledger = createLedger(db);
    await ledger.deliver(keys.root(PR), sink(), root, {
      onSentTx: async (tx) => {
        await tx
          .update(pullRequests)
          .set({ rootMessageTs: "from-tx" })
          .where(eq(pullRequests.id, PR));
      },
    });
    const [pr] = await db.select().from(pullRequests);
    expect(pr?.rootMessageTs).toBe("from-tx");

    const stale = await claim(db, keys.review(PR, 9), new Date(0), 1);
    await claim(db, keys.review(PR, 9), new Date(10), 1);
    if (!stale) throw new Error("expected claim");
    const onSentTx = vi.fn(async () => {});
    expect(await complete(db, stale, "late", onSentTx)).toBe(false);
    expect(onSentTx).not.toHaveBeenCalled();
  });

  it("rolls the sent mark back when onSentTx fails", async () => {
    const ledger = createLedger(db);
    await expect(
      ledger.deliver(keys.root(PR), sink(), root, {
        onSentTx: async () => {
          throw new Error("dependent write failed");
        },
      }),
    ).rejects.toThrow("dependent write failed");
    expect(await ledger.sentTs(keys.root(PR))).toBeUndefined();
    const [row] = await rows();
    expect(row?.status).toBe("pending");
  });
});
