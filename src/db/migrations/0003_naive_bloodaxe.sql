ALTER TABLE "pull_requests" ADD COLUMN "applied_state" "pr_state";--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "applied_channel_name" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "source_updated_at" timestamp with time zone;--> statement-breakpoint
-- A repository rename could leave more than one legacy row for the same
-- immutable GitHub PR id. The migrator executes this file in one transaction;
-- staging makes every dependent rewrite deterministic before the unique index
-- is installed.
CREATE TEMP TABLE "_migration_0003_pr_merge" (
	"member_id" text PRIMARY KEY,
	"canonical_id" text NOT NULL,
	"target_repo_full_name" text NOT NULL,
	"target_number" integer NOT NULL,
	"target_current_state" "pr_state" NOT NULL,
	"target_head_sha" text,
	"target_channel_id" text,
	"target_root_message_ts" text,
	"target_updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
WITH "duplicate_github_ids" AS (
	SELECT "github_pr_id"
	FROM "pull_requests"
	GROUP BY "github_pr_id"
	HAVING count(*) > 1
),
"ranked_prs" AS (
	SELECT
		"pr".*,
		first_value("pr"."id") OVER (
			PARTITION BY "pr"."github_pr_id"
			ORDER BY
				("pr"."channel_id" IS NOT NULL) DESC,
				("pr"."root_message_ts" IS NOT NULL) DESC,
				"pr"."updated_at" DESC,
				"pr"."created_at" ASC,
				"pr"."id" ASC
		) AS "canonical_id",
		first_value("pr"."channel_id") OVER (
			PARTITION BY "pr"."github_pr_id"
			ORDER BY
				("pr"."channel_id" IS NOT NULL) DESC,
				("pr"."root_message_ts" IS NOT NULL) DESC,
				"pr"."updated_at" DESC,
				"pr"."created_at" ASC,
				"pr"."id" ASC
		) AS "target_channel_id",
		first_value("pr"."root_message_ts") OVER (
			PARTITION BY "pr"."github_pr_id"
			ORDER BY
				("pr"."channel_id" IS NOT NULL) DESC,
				("pr"."root_message_ts" IS NOT NULL) DESC,
				"pr"."updated_at" DESC,
				"pr"."created_at" ASC,
				"pr"."id" ASC
		) AS "target_root_message_ts",
		first_value("pr"."repo_full_name") OVER (
			PARTITION BY "pr"."github_pr_id"
			ORDER BY "pr"."updated_at" DESC, "pr"."created_at" DESC, "pr"."id" ASC
		) AS "target_repo_full_name",
		first_value("pr"."number") OVER (
			PARTITION BY "pr"."github_pr_id"
			ORDER BY "pr"."updated_at" DESC, "pr"."created_at" DESC, "pr"."id" ASC
		) AS "target_number",
		first_value("pr"."current_state") OVER (
			PARTITION BY "pr"."github_pr_id"
			ORDER BY "pr"."updated_at" DESC, "pr"."created_at" DESC, "pr"."id" ASC
		) AS "target_current_state",
		first_value("pr"."head_sha") OVER (
			PARTITION BY "pr"."github_pr_id"
			ORDER BY "pr"."updated_at" DESC, "pr"."created_at" DESC, "pr"."id" ASC
		) AS "target_head_sha",
		first_value("pr"."updated_at") OVER (
			PARTITION BY "pr"."github_pr_id"
			ORDER BY "pr"."updated_at" DESC, "pr"."created_at" DESC, "pr"."id" ASC
		) AS "target_updated_at"
	FROM "pull_requests" AS "pr"
	INNER JOIN "duplicate_github_ids" AS "duplicate"
		ON "duplicate"."github_pr_id" = "pr"."github_pr_id"
)
INSERT INTO "_migration_0003_pr_merge" (
	"member_id",
	"canonical_id",
	"target_repo_full_name",
	"target_number",
	"target_current_state",
	"target_head_sha",
	"target_channel_id",
	"target_root_message_ts",
	"target_updated_at"
)
SELECT
	"id",
	"canonical_id",
	"target_repo_full_name",
	"target_number",
	"target_current_state",
	"target_head_sha",
	"target_channel_id",
	"target_root_message_ts",
	"target_updated_at"
FROM "ranked_prs";--> statement-breakpoint
CREATE TEMP TABLE "_migration_0003_message_merge" (
	"message_id" text PRIMARY KEY,
	"target_pr_id" text NOT NULL,
	"target_natural_key" text NOT NULL,
	"target_client_msg_id" text NOT NULL,
	"keep" boolean NOT NULL
);--> statement-breakpoint
WITH "retargeted_messages" AS (
	SELECT
		"message"."id" AS "message_id",
		"mapping"."canonical_id" AS "target_pr_id",
		length("mapping"."canonical_id") || ':' || "mapping"."canonical_id" || '|' ||
		length("message"."kind") || ':' || "message"."kind" || '|' ||
		length(COALESCE("message"."github_event_ref", "message"."kind")) || ':' ||
		COALESCE("message"."github_event_ref", "message"."kind") AS "target_natural_key",
		"message"."slack_ts",
		"message"."created_at"
	FROM "messages" AS "message"
	INNER JOIN "_migration_0003_pr_merge" AS "mapping"
		ON "mapping"."member_id" = "message"."pr_id"
),
"ranked_messages" AS (
	SELECT
		"retargeted".*,
		md5("retargeted"."target_natural_key") AS "client_hash",
		row_number() OVER (
			PARTITION BY "retargeted"."target_natural_key"
			ORDER BY
				("retargeted"."slack_ts" IS NOT NULL) DESC,
				"retargeted"."created_at" ASC,
				"retargeted"."message_id" ASC
		) AS "duplicate_rank"
	FROM "retargeted_messages" AS "retargeted"
)
INSERT INTO "_migration_0003_message_merge" (
	"message_id", "target_pr_id", "target_natural_key", "target_client_msg_id", "keep"
)
SELECT
	"message_id",
	"target_pr_id",
	"target_natural_key",
	substr("client_hash", 1, 8) || '-' ||
		substr("client_hash", 9, 4) || '-' ||
		substr("client_hash", 13, 4) || '-' ||
		substr("client_hash", 17, 4) || '-' ||
		substr("client_hash", 21, 12),
	"duplicate_rank" = 1
FROM "ranked_messages";--> statement-breakpoint
DELETE FROM "messages" AS "message"
USING "_migration_0003_message_merge" AS "mapping"
WHERE "message"."id" = "mapping"."message_id"
	AND NOT "mapping"."keep";--> statement-breakpoint
UPDATE "messages" AS "message"
SET
	"pr_id" = "mapping"."target_pr_id",
	"natural_key" = "mapping"."target_natural_key",
	"client_msg_id" = "mapping"."target_client_msg_id"
FROM "_migration_0003_message_merge" AS "mapping"
WHERE "message"."id" = "mapping"."message_id"
	AND "mapping"."keep";--> statement-breakpoint
CREATE TEMP TABLE "_migration_0003_reminder_merge" (
	"reminder_id" text PRIMARY KEY,
	"target_id" text NOT NULL,
	"target_pr_id" text NOT NULL,
	"keep" boolean NOT NULL
);--> statement-breakpoint
WITH "ranked_reminders" AS (
	SELECT
		"reminder"."id" AS "reminder_id",
		"mapping"."canonical_id" || '::' || "reminder"."reviewer_github_id"::text AS "target_id",
		"mapping"."canonical_id" AS "target_pr_id",
		row_number() OVER (
			PARTITION BY "mapping"."canonical_id", "reminder"."reviewer_github_id"
			ORDER BY
				"reminder"."due_at" DESC,
				"reminder"."created_at" DESC,
				CASE "reminder"."status"
					WHEN 'sending' THEN 0
					WHEN 'pending' THEN 1
					WHEN 'cancelled' THEN 2
					ELSE 3
				END,
				"reminder"."id" ASC
		) AS "duplicate_rank"
	FROM "reminders" AS "reminder"
	INNER JOIN "_migration_0003_pr_merge" AS "mapping"
		ON "mapping"."member_id" = "reminder"."pr_id"
)
INSERT INTO "_migration_0003_reminder_merge" (
	"reminder_id", "target_id", "target_pr_id", "keep"
)
SELECT "reminder_id", "target_id", "target_pr_id", "duplicate_rank" = 1
FROM "ranked_reminders";--> statement-breakpoint
DELETE FROM "reminders" AS "reminder"
USING "_migration_0003_reminder_merge" AS "mapping"
WHERE "reminder"."id" = "mapping"."reminder_id"
	AND NOT "mapping"."keep";--> statement-breakpoint
UPDATE "reminders" AS "reminder"
SET
	"id" = "mapping"."target_id",
	"pr_id" = "mapping"."target_pr_id"
FROM "_migration_0003_reminder_merge" AS "mapping"
WHERE "reminder"."id" = "mapping"."reminder_id"
	AND "mapping"."keep";--> statement-breakpoint
DELETE FROM "pull_requests" AS "pr"
USING "_migration_0003_pr_merge" AS "mapping"
WHERE "pr"."id" = "mapping"."member_id"
	AND "mapping"."member_id" <> "mapping"."canonical_id";--> statement-breakpoint
UPDATE "pull_requests" AS "pr"
SET
	"repo_full_name" = "mapping"."target_repo_full_name",
	"number" = "mapping"."target_number",
	"current_state" = "mapping"."target_current_state",
	"head_sha" = "mapping"."target_head_sha",
	"channel_id" = "mapping"."target_channel_id",
	"root_message_ts" = "mapping"."target_root_message_ts",
	"updated_at" = "mapping"."target_updated_at"
FROM (
	SELECT DISTINCT
		"canonical_id",
		"target_repo_full_name",
		"target_number",
		"target_current_state",
		"target_head_sha",
		"target_channel_id",
		"target_root_message_ts",
		"target_updated_at"
	FROM "_migration_0003_pr_merge"
) AS "mapping"
WHERE "pr"."id" = "mapping"."canonical_id";--> statement-breakpoint
DROP TABLE "_migration_0003_reminder_merge";--> statement-breakpoint
DROP TABLE "_migration_0003_message_merge";--> statement-breakpoint
DROP TABLE "_migration_0003_pr_merge";--> statement-breakpoint
CREATE UNIQUE INDEX "pr_github_id_unique" ON "pull_requests" USING btree ("github_pr_id");
