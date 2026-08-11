CREATE TYPE "public"."message_status" AS ENUM('pending', 'sending', 'sent');--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "natural_key" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "status" "message_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_msg_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "slack_ts" DROP NOT NULL;--> statement-breakpoint
-- Legacy rows represent effects that the old service already attempted. Never
-- replay them during the upgrade, even when '-' was used as a missing-ts
-- placeholder. Multiple NULL event refs were permitted by the old unique index;
-- deterministically retain the row with a real Slack timestamp when they fold
-- onto the same natural key.
WITH "keyed_legacy_messages" AS (
	SELECT
		"id",
		"slack_ts",
		"created_at",
		length("pr_id") || ':' || "pr_id" || '|' ||
		length("kind") || ':' || "kind" || '|' ||
		length(COALESCE("github_event_ref", "kind")) || ':' ||
		COALESCE("github_event_ref", "kind") AS "legacy_natural_key"
	FROM "messages"
),
"ranked_legacy_messages" AS (
	SELECT
		"id",
		"legacy_natural_key",
		md5("legacy_natural_key") AS "client_hash",
		row_number() OVER (
			PARTITION BY "legacy_natural_key"
			ORDER BY ("slack_ts" <> '-') DESC, "created_at" ASC, "id" ASC
		) AS "duplicate_rank"
	FROM "keyed_legacy_messages"
),
"deleted_legacy_duplicates" AS (
	DELETE FROM "messages" AS "message"
	USING "ranked_legacy_messages" AS "ranked"
	WHERE "message"."id" = "ranked"."id"
		AND "ranked"."duplicate_rank" > 1
	RETURNING "message"."id"
)
UPDATE "messages" AS "message"
SET
	"natural_key" = "ranked"."legacy_natural_key",
	"client_msg_id" = substr("ranked"."client_hash", 1, 8) || '-' ||
		substr("ranked"."client_hash", 9, 4) || '-' ||
		substr("ranked"."client_hash", 13, 4) || '-' ||
		substr("ranked"."client_hash", 17, 4) || '-' ||
		substr("ranked"."client_hash", 21, 12),
	"status" = 'sent'::"message_status",
	"slack_ts" = NULLIF("message"."slack_ts", '-')
FROM "ranked_legacy_messages" AS "ranked"
WHERE "message"."id" = "ranked"."id"
	AND "ranked"."duplicate_rank" = 1;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "natural_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "client_msg_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "messages_pr_kind_event_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "messages_natural_key_unique" ON "messages" USING btree ("natural_key");--> statement-breakpoint
CREATE INDEX "messages_status_claimed_idx" ON "messages" USING btree ("status","claimed_at");
