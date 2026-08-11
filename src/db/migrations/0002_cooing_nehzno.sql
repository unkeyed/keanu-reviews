CREATE TYPE "public"."message_status" AS ENUM('pending', 'sending', 'sent');--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "natural_key" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "status" "message_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_msg_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "messages"
SET "natural_key" = length("pr_id") || ':' || "pr_id" || '|' || length("kind") || ':' || "kind" || '|' || length(COALESCE("github_event_ref", "kind")) || ':' || COALESCE("github_event_ref", "kind"),
    "client_msg_id" = "id",
    "status" = CASE WHEN "slack_ts" = '-' THEN 'pending'::"message_status" ELSE 'sent'::"message_status" END,
    "slack_ts" = NULLIF("slack_ts", '-');--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "natural_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "client_msg_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "slack_ts" DROP NOT NULL;--> statement-breakpoint
DROP INDEX "messages_pr_kind_event_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "messages_natural_key_unique" ON "messages" USING btree ("natural_key");--> statement-breakpoint
CREATE INDEX "messages_status_claimed_idx" ON "messages" USING btree ("status","claimed_at");
