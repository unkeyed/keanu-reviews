ALTER TYPE "public"."reminder_status" ADD VALUE 'failed';--> statement-breakpoint
CREATE TABLE "pull_request_lifecycle_claims" (
	"github_pr_id" bigint PRIMARY KEY NOT NULL,
	"claim_token" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP INDEX "reminders_due_status_idx";--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "source_arrival_key" text;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "available_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "source_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "source_version" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "reminders"
SET "available_at" = "due_at",
    "source_updated_at" = "created_at";--> statement-breakpoint
ALTER TABLE "reminders" ALTER COLUMN "available_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ALTER COLUMN "source_updated_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "reminders_due_status_idx" ON "reminders" USING btree ("status","available_at","created_at");
