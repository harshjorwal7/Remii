CREATE EXTENSION IF NOT EXISTS "vector";
--> statement-breakpoint
CREATE TYPE "public"."remi_task_importance" AS ENUM('HIGH', 'MEDIUM', 'LOW');--> statement-breakpoint
CREATE TYPE "public"."remi_task_status" AS ENUM('OPEN', 'IN_PROGRESS', 'NEEDS_REVIEW', 'DONE', 'DISMISSED');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"mime_type" text,
	"size" integer,
	"extracted_text" text,
	"source" text DEFAULT 'agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cron_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text,
	"name" text NOT NULL,
	"expression" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"trigger_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1024),
	"scope" text DEFAULT 'chat' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"category" text,
	"importance" integer DEFAULT 5 NOT NULL,
	"source" text DEFAULT 'explicit' NOT NULL,
	"expires_at" timestamp with time zone,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sender_verdicts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_app" text NOT NULL,
	"sender_key" text NOT NULL,
	"verdict" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"raw_snippet" text,
	"source_app" text,
	"source_account" text,
	"sender_key" text,
	"source_ref" text,
	"status" "remi_task_status" DEFAULT 'OPEN' NOT NULL,
	"importance" "remi_task_importance" DEFAULT 'MEDIUM' NOT NULL,
	"urgency_score" integer DEFAULT 1 NOT NULL,
	"created_via" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"result_summary" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "telegram_links" (
	"user_id" text NOT NULL,
	"chat_id" text,
	"link_token" text,
	"link_token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_links_chat_id_unique" UNIQUE("chat_id"),
	CONSTRAINT "telegram_links_link_token_unique" UNIQUE("link_token")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_username" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_verdicts" ADD CONSTRAINT "sender_verdicts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_user_created_idx" ON "artifacts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "cron_jobs_next_run_idx" ON "cron_jobs" USING btree ("next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memories_user_bot_hash_idx" ON "memories" USING btree ("user_id","bot_id","content_hash");--> statement-breakpoint
CREATE INDEX "memories_user_idx" ON "memories" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sender_verdicts_user_app_sender_idx" ON "sender_verdicts" USING btree ("user_id","source_app","sender_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_user_source_ref_idx" ON "tasks" USING btree ("user_id","source_ref");--> statement-breakpoint
CREATE INDEX "tasks_user_status_idx" ON "tasks" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_links_user_idx" ON "telegram_links" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_unique" UNIQUE("username");