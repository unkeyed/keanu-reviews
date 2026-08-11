ALTER TYPE "public"."reminder_status" ADD VALUE 'sending' BEFORE 'sent';--> statement-breakpoint
DROP INDEX "jobs_status_created_idx";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_delivery_unique" ON "jobs" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "jobs_status_created_idx" ON "jobs" USING btree ("status","available_at","created_at");