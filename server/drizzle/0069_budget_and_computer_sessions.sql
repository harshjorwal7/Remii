CREATE TABLE "budget_debits" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text,
	"kind" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	"month_start" timestamp with time zone NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"model" text,
	"billable_seconds" integer,
	"cost_usd" numeric(12, 6) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "computer_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"sandbox_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"billable_seconds" integer,
	"cost_usd" numeric(12, 6),
	"ended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_debits" ADD CONSTRAINT "budget_debits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_sessions" ADD CONSTRAINT "computer_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_debits_user_window_idx" ON "budget_debits" USING btree ("user_id","window_start");--> statement-breakpoint
CREATE INDEX "budget_debits_user_week_idx" ON "budget_debits" USING btree ("user_id","week_start");--> statement-breakpoint
CREATE INDEX "budget_debits_user_month_idx" ON "budget_debits" USING btree ("user_id","month_start");--> statement-breakpoint
CREATE INDEX "budget_debits_user_kind_idx" ON "budget_debits" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "computer_sessions_user_idx" ON "computer_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "computer_sessions_open_idx" ON "computer_sessions" USING btree ("user_id","started_at") WHERE "computer_sessions"."ended_at" is null;