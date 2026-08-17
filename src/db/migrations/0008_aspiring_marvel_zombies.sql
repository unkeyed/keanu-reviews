CREATE TABLE "slack_user_tokens" (
	"slack_user_id" text PRIMARY KEY NOT NULL,
	"slack_team_id" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"scopes" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "slack_user_tokens_team_idx" ON "slack_user_tokens" USING btree ("slack_team_id");