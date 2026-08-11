CREATE TABLE "github_link_confirmations" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_state_nonces" (
	"nonce_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "github_link_confirmations_expires_at_idx" ON "github_link_confirmations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "github_link_confirmations_slack_owner_idx" ON "github_link_confirmations" USING btree ("slack_team_id","slack_user_id");--> statement-breakpoint
CREATE INDEX "oauth_state_nonces_expires_at_idx" ON "oauth_state_nonces" USING btree ("expires_at");