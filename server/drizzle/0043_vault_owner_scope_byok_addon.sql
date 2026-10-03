ALTER TABLE "credentials" DROP CONSTRAINT IF EXISTS "credentials_active_key_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "credentials_active_key_idx";
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "byok_addon" boolean DEFAULT false NOT NULL;
