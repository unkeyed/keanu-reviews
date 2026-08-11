CREATE TYPE "public"."identity_source" AS ENUM('self-link', 'admin-import', 'email-match');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'processing', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."pr_state" AS ENUM('draft', 'pr', 'closed', 'merged');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('pending', 'sent', 'cancelled');--> statement-breakpoint
CREATE TABLE "identities" (
	"github_user_id" bigint PRIMARY KEY NOT NULL,
	"github_login" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"source" "identity_source" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"installation_id" bigint PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"raw" jsonb,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"pr_id" text NOT NULL,
	"github_event_ref" text,
	"slack_ts" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"number" integer NOT NULL,
	"github_pr_id" bigint NOT NULL,
	"channel_id" text,
	"current_state" "pr_state" NOT NULL,
	"head_sha" text,
	"root_message_ts" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" text PRIMARY KEY NOT NULL,
	"pr_id" text NOT NULL,
	"reviewer_github_id" bigint NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "reminder_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_status_created_idx" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_pr_kind_event_unique" ON "messages" USING btree ("pr_id","kind","github_event_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_repo_number_unique" ON "pull_requests" USING btree ("repo_full_name","number");--> statement-breakpoint
CREATE INDEX "pr_head_sha_idx" ON "pull_requests" USING btree ("head_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "reminders_pr_reviewer_unique" ON "reminders" USING btree ("pr_id","reviewer_github_id");--> statement-breakpoint
CREATE INDEX "reminders_due_status_idx" ON "reminders" USING btree ("status","due_at");