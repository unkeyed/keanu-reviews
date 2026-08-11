import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Database schema (U2). One durable store mapping GitHub PRs to Slack channels,
 * plus the identity map, reminder queue, job queue, and webhook dedupe.
 *
 * Review-driven columns: pull_requests.head_sha (CI mapping join key, U7),
 * jobs.claimed_at (single-writer leasing, KTD10), reminders atomic status (KTD10),
 * and jobs.raw is nullable so it can be purged after processing (retention, KTD13).
 */

export const prStateEnum = pgEnum("pr_state", ["draft", "pr", "closed", "merged"]);
export const reminderStatusEnum = pgEnum("reminder_status", ["pending", "sent", "cancelled"]);
export const jobStatusEnum = pgEnum("job_status", ["pending", "processing", "done", "failed"]);
export const identitySourceEnum = pgEnum("identity_source", [
  "self-link",
  "admin-import",
  "email-match",
]);

export const installations = pgTable("installations", {
  installationId: bigint("installation_id", { mode: "number" }).primaryKey(),
  account: text("account").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pullRequests = pgTable(
  "pull_requests",
  {
    id: text("id").primaryKey(), // `${repoFullName}#${number}`
    repoFullName: text("repo_full_name").notNull(),
    number: integer("number").notNull(),
    githubPrId: bigint("github_pr_id", { mode: "number" }).notNull(),
    channelId: text("channel_id"),
    currentState: prStateEnum("current_state").notNull(),
    headSha: text("head_sha"), // CI mapping join key (U7), refreshed on opened/synchronize
    rootMessageTs: text("root_message_ts"), // Slack thread root for follow-up activity (R7)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    repoNumberUnique: uniqueIndex("pr_repo_number_unique").on(t.repoFullName, t.number),
    headShaIdx: index("pr_head_sha_idx").on(t.headSha),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    prId: text("pr_id")
      .notNull()
      .references(() => pullRequests.id),
    githubEventRef: text("github_event_ref"), // e.g. review-comment id, for idempotency
    slackTs: text("slack_ts").notNull(),
    kind: text("kind").notNull(), // root | review_comment | review | ci | reminder | lifecycle
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    prKindEventUnique: uniqueIndex("messages_pr_kind_event_unique").on(
      t.prId,
      t.kind,
      t.githubEventRef,
    ),
  }),
);

export const identities = pgTable("identities", {
  githubUserId: bigint("github_user_id", { mode: "number" }).primaryKey(),
  githubLogin: text("github_login").notNull(),
  slackUserId: text("slack_user_id").notNull(),
  source: identitySourceEnum("source").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reminders = pgTable(
  "reminders",
  {
    id: text("id").primaryKey(),
    prId: text("pr_id")
      .notNull()
      .references(() => pullRequests.id),
    reviewerGithubId: bigint("reviewer_github_id", { mode: "number" }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: reminderStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    prReviewerUnique: uniqueIndex("reminders_pr_reviewer_unique").on(t.prId, t.reviewerGithubId),
    dueStatusIdx: index("reminders_due_status_idx").on(t.status, t.dueAt),
  }),
);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    deliveryId: text("delivery_id").notNull(),
    event: text("event").notNull(),
    action: text("action"),
    raw: jsonb("raw"), // nullable: purged after successful processing (retention, KTD13)
    status: jobStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true }), // single-writer lease (KTD10)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusCreatedIdx: index("jobs_status_created_idx").on(t.status, t.createdAt),
  }),
);

export const processedDeliveries = pgTable("processed_deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PullRequestRow = typeof pullRequests.$inferSelect;
export type IdentityRow = typeof identities.$inferSelect;
export type ReminderRow = typeof reminders.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
