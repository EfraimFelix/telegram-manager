CREATE TYPE "public"."moderation_action_type" AS ENUM('ALLOW', 'REVIEW', 'DELETE');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"username" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"webhook_secret_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_connections_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "communities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bot_connection_id" uuid NOT NULL,
	"platform" text DEFAULT 'telegram' NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"username" text,
	"status" text DEFAULT 'active' NOT NULL,
	"moderation_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"action" "moderation_action_type" NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"external_result" jsonb,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_actions_decision_id_unique" UNIQUE("decision_id")
);
--> statement-breakpoint
CREATE TABLE "moderation_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"action" "moderation_action_type" NOT NULL,
	"winning_rule_id" uuid,
	"reason" text NOT NULL,
	"policy_version" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"evaluated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_decisions_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "moderation_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"expected_action" "moderation_action_type" NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"community_id" uuid NOT NULL,
	"platform_message_id" text NOT NULL,
	"platform_user_id" text,
	"revision" integer NOT NULL,
	"text" text NOT NULL,
	"message_type" text DEFAULT 'text' NOT NULL,
	"processing_status" text DEFAULT 'RECEIVED' NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_rule_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_text" text NOT NULL,
	"rule_name" text NOT NULL,
	"configured_action" "moderation_action_type" NOT NULL,
	"priority" integer NOT NULL,
	"probability" double precision NOT NULL,
	"matched" boolean NOT NULL,
	"provider" text DEFAULT 'jev' NOT NULL,
	"provider_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "valid_probability" CHECK ("moderation_rule_evaluations"."probability" >= 0 AND "moderation_rule_evaluations"."probability" <= 1)
);
--> statement-breakpoint
CREATE TABLE "moderation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"community_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rule_text" text NOT NULL,
	"action" "moderation_action_type" NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	CONSTRAINT "organization_members_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_owner_user_id_unique" UNIQUE("owner_user_id")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" double precision NOT NULL,
	CONSTRAINT "rate_limits_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "rule_test_usage" (
	"organization_id" uuid NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rule_test_usage_organization_id_day_pk" PRIMARY KEY("organization_id","day")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_id" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "usage_monthly" (
	"organization_id" uuid NOT NULL,
	"year_month" date NOT NULL,
	"messages_received" integer DEFAULT 0 NOT NULL,
	"messages_moderated" integer DEFAULT 0 NOT NULL,
	"jev_requests" integer DEFAULT 0 NOT NULL,
	"jev_input_tokens" integer DEFAULT 0 NOT NULL,
	"rule_evaluations" integer DEFAULT 0 NOT NULL,
	"actions_delete" integer DEFAULT 0 NOT NULL,
	"actions_review" integer DEFAULT 0 NOT NULL,
	"actions_allow" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_monthly_organization_id_year_month_pk" PRIMARY KEY("organization_id","year_month")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_connections" ADD CONSTRAINT "bot_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communities" ADD CONSTRAINT "communities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communities" ADD CONSTRAINT "communities_bot_connection_id_bot_connections_id_fk" FOREIGN KEY ("bot_connection_id") REFERENCES "public"."bot_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_decision_id_moderation_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."moderation_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD CONSTRAINT "moderation_decisions_message_id_moderation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."moderation_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD CONSTRAINT "moderation_decisions_winning_rule_id_moderation_rules_id_fk" FOREIGN KEY ("winning_rule_id") REFERENCES "public"."moderation_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_feedback" ADD CONSTRAINT "moderation_feedback_decision_id_moderation_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."moderation_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_feedback" ADD CONSTRAINT "moderation_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_messages" ADD CONSTRAINT "moderation_messages_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_rule_evaluations" ADD CONSTRAINT "moderation_rule_evaluations_message_id_moderation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."moderation_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_rule_evaluations" ADD CONSTRAINT "moderation_rule_evaluations_rule_id_moderation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."moderation_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_rules" ADD CONSTRAINT "moderation_rules_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_rules" ADD CONSTRAINT "moderation_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_test_usage" ADD CONSTRAINT "rule_test_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_monthly" ADD CONSTRAINT "usage_monthly_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_idx" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_bot_per_organization" ON "bot_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "community_external_idx" ON "communities" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX "community_org_idx" ON "communities" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_decision_user_idx" ON "moderation_feedback" USING btree ("decision_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_version_idx" ON "moderation_messages" USING btree ("community_id","platform_message_id","revision");--> statement-breakpoint
CREATE INDEX "messages_community_time_idx" ON "moderation_messages" USING btree ("community_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_message_rule_idx" ON "moderation_rule_evaluations" USING btree ("message_id","rule_id");--> statement-breakpoint
CREATE INDEX "rules_community_idx" ON "moderation_rules" USING btree ("community_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_workspace_per_user" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");