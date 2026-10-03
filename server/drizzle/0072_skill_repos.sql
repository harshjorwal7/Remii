CREATE TABLE "skill_repos" (
	"skill_id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"ref" text,
	"path" text DEFAULT '' NOT NULL,
	"default_ref" text,
	"tree_sha" text,
	"indexed_at" timestamp with time zone,
	"index" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_repos_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "skill_repos_owner_repo_idx" ON "skill_repos" USING btree ("owner","repo");