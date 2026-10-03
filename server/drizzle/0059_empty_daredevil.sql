CREATE TABLE "computer_scopes" (
	"key" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"owner" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "computer_scopes_owner_idx" ON "computer_scopes" USING btree ("owner");