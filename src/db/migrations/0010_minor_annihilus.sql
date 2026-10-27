CREATE TABLE "review_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"pr_id" text NOT NULL,
	"reviewer_github_id" bigint NOT NULL,
	"reviewer_login" text NOT NULL,
	"effect_ref" text NOT NULL,
	"status" text NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"source_version" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_alerts" ADD CONSTRAINT "review_alerts_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_alerts_pr_status_idx" ON "review_alerts" USING btree ("pr_id","status");