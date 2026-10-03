CREATE TABLE "memory_events" (
	"id" text PRIMARY KEY NOT NULL,
	"memory_id" text NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text,
	"kind" text NOT NULL,
	"turn_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "superseded_by" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "recall_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "last_recalled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_events_memory_idx" ON "memory_events" USING btree ("memory_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_events_user_created_idx" ON "memory_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "memories_user_task_idx" ON "memories" USING btree ("user_id","task_id");