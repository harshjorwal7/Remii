ALTER TABLE "sandboxed_components" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "sandboxed_components" ADD CONSTRAINT "sandboxed_components_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "sandboxed_components" AS sc SET "owner_user_id" = u."id" FROM "public"."users" AS u WHERE sc."owner_user_id" IS NULL AND sc."authored_by" IS NOT NULL AND lower(u."email") = lower(sc."authored_by");
