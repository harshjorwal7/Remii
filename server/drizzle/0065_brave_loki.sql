-- One desktop per Bot, on the person's shared disk.
--
-- The disk is shared and the screen is not. A Bot that shares files with its siblings but has its own
-- display, mouse and keyboard can hand work to another Bot without the two fighting over one
-- pointer — the collision that made a person and a Bot on one desktop unsafe.
--
-- `user_id` is carried rather than joined because two different questions are asked of this row:
-- "whose disk does this Bot share" is user_id and picks the volume subpath, while "whose machine is
-- this" is bot_id and is what makes the desktop separate. Reading one from the other is how a Bot
-- ends up on a stranger's disk.
--
-- The unique index on bot_id, not a check in the handler: two requests for a Bot with no desktop
-- both read "none" and both provision, so the loser must fail to insert and use the winner's sandbox.
CREATE TABLE IF NOT EXISTS "bot_computers" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text DEFAULT 'daytona' NOT NULL,
	"sandbox_id" text,
	"status" text DEFAULT 'NONE' NOT NULL,
	"desired_status" text DEFAULT 'RUNNING' NOT NULL,
	"display_width" integer,
	"display_height" integer,
	"image_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"control_holder" text DEFAULT 'bot' NOT NULL,
	"control_since" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_computers_bot_id_unique" UNIQUE("bot_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bot_computers" ADD CONSTRAINT "bot_computers_bot_id_agents_agent_id_fk" FOREIGN KEY ("bot_id") REFERENCES "agent_profiles"("agent_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bot_computers" ADD CONSTRAINT "bot_computers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_computers_sandbox_idx" ON "bot_computers" ("sandbox_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_computers_user_idx" ON "bot_computers" ("user_id");
