CREATE TABLE "remi_instances" (
	"user_id" text PRIMARY KEY NOT NULL,
	"model_slug" text,
	"model_provider" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "remi_instances" ADD CONSTRAINT "remi_instances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;