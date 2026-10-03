CREATE TABLE IF NOT EXISTS "plugin_revocations" (
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"agent_id" text NOT NULL,
	"revoked_by" text,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_revocations_pk" PRIMARY KEY("kind","ref","agent_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_revocations_agent_idx" ON "plugin_revocations" USING btree ("agent_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plugin_revocations" ADD CONSTRAINT "plugin_revocations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
