ALTER TABLE "action_policy" DROP CONSTRAINT IF EXISTS "action_policy_user_id_users_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credentials_active_key_idx" ON "credentials" USING btree (coalesce("user_id", '~deployment'),"kind","provider","key_id") WHERE "revoked_at" IS NULL;
