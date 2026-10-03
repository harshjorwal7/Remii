CREATE TABLE "run_activity" (
	"run_id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"channel_id" text,
	"thread_id" text NOT NULL,
	"parent_run_id" text,
	"state" text NOT NULL,
	"label" text,
	"detail" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"error" text,
	"transitions" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_activity" ADD CONSTRAINT "run_activity_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_activity_actor_open_idx" ON "run_activity" USING btree ("actor_user_id","started_at") WHERE "run_activity"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "run_activity_parent_idx" ON "run_activity" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "run_activity_started_idx" ON "run_activity" USING btree ("started_at");