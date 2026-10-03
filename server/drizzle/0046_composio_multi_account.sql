ALTER TABLE "composio_connections" ADD COLUMN IF NOT EXISTS "id" text NOT NULL DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "composio_connections" ADD COLUMN IF NOT EXISTS "account_id" text;
--> statement-breakpoint
ALTER TABLE "composio_connections" ADD COLUMN IF NOT EXISTS "label" text;
--> statement-breakpoint
ALTER TABLE "composio_connections" DROP CONSTRAINT IF EXISTS "composio_connections_toolkit_user_id_pk";
--> statement-breakpoint
ALTER TABLE "composio_connections" ADD CONSTRAINT "composio_connections_pkey" PRIMARY KEY ("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "composio_connections_user_toolkit_idx" ON "composio_connections" USING btree ("user_id", "toolkit");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "composio_account_grants" (
	"connection_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "composio_account_grants_pk" PRIMARY KEY("connection_id","agent_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "composio_account_grants_agent_idx" ON "composio_account_grants" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "composio_account_grants_user_idx" ON "composio_account_grants" USING btree ("user_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "composio_account_grants" ADD CONSTRAINT "composio_account_grants_connection_id_composio_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."composio_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "composio_account_grants" ADD CONSTRAINT "composio_account_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
