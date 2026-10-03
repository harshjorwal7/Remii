-- An owner's profile is theirs, and a deleted owner takes it with them.
--
-- `agent_profiles.owner_user_id` was installed as ON DELETE SET NULL, while the schema has always said
-- CASCADE. SET NULL is not a neutral default here, because it is exactly the value that means
-- "nobody owns this": `accessFilter` admits a row when `systemOwned OR ownerUserId === actor.id`, and
-- a profile with a null owner is a SYSTEM TEMPLATE — reachable by every caller and managed by them.
--
-- So deleting one user promoted every personal Bot they owned into a template the whole deployment
-- could read and edit, and left the rows behind. CASCADE removes them with their owner, which is the
-- only direction that is safe when null carries meaning.
--
-- The constraint is dropped and re-added rather than altered, which is the only portable spelling:
-- `ALTER TABLE ... ALTER CONSTRAINT` does not exist, and every database this runs on spells the new
-- rule by dropping and re-adding the DO-block below.
ALTER TABLE "agent_profiles" DROP CONSTRAINT IF EXISTS "agent_profiles_owner_user_id_users_id_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
