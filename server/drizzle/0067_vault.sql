CREATE TYPE "public"."vault_agent_item_kind" AS ENUM('api_key', 'access_token', 'secret', 'environment_variable', 'ssh_key', 'recovery_code', 'custom');
--> statement-breakpoint
CREATE TYPE "public"."vault_agent_item_scope" AS ENUM('agent', 'task', 'integration');
--> statement-breakpoint
CREATE TABLE "vault_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"username" text NOT NULL,
	"password_encrypted" text,
	"website_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"used_by_agent_id" text,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"tags" text array DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "vault_logins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "vault_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"cardholder_name" text,
	"card_number_encrypted" text NOT NULL,
	"last4" text NOT NULL,
	"expiry" text,
	"cvv_encrypted" text,
	"billing_address" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"used_by_agent_id" text,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"tags" text array DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "vault_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "vault_personal_info" (
	"user_id" text PRIMARY KEY NOT NULL,
	"full_name" text,
	"preferred_name" text,
	"email" text,
	"phone" text,
	"date_of_birth" text,
	"address" text,
	"city" text,
	"state" text,
	"country" text,
	"postal_code" text,
	"company" text,
	"job_title" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vault_personal_info_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "vault_agent_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"kind" "vault_agent_item_kind" NOT NULL,
	"value_encrypted" text,
	"description" text,
	"scope" "vault_agent_item_scope" DEFAULT 'agent' NOT NULL,
	"scope_ref" text,
	"allowed_apps" text array DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"used_by_agent_id" text,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"tags" text array DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "vault_agent_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "vault_logins_owner_label_idx" ON "vault_logins" USING btree ("user_id","label");--> statement-breakpoint
CREATE INDEX "vault_cards_owner_label_idx" ON "vault_cards" USING btree ("user_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_agent_items_owner_label_idx" ON "vault_agent_items" USING btree ("user_id","label");
