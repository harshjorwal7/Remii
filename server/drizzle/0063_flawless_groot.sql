CREATE TABLE "user_computers" (
	"id" text PRIMARY KEY NOT NULL,
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
	CONSTRAINT "user_computers_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "user_computers" ADD CONSTRAINT "user_computers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_computers_sandbox_idx" ON "user_computers" USING btree ("sandbox_id");