CREATE TABLE "memory_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text DEFAULT 'topic' NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entity_links" (
	"memory_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_entity_links_memory_id_entity_id_pk" PRIMARY KEY("memory_id","entity_id")
);
--> statement-breakpoint
ALTER TABLE "memory_entities" ADD CONSTRAINT "memory_entities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entity_links" ADD CONSTRAINT "memory_entity_links_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entity_links" ADD CONSTRAINT "memory_entity_links_entity_id_memory_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."memory_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_entities_user_name_idx" ON "memory_entities" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "memory_entities_user_idx" ON "memory_entities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memory_entity_links_entity_idx" ON "memory_entity_links" USING btree ("entity_id");