ALTER TABLE "pull_requests" ADD COLUMN "applied_state" "pr_state";--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "applied_channel_name" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "source_updated_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_github_id_unique" ON "pull_requests" USING btree ("github_pr_id");