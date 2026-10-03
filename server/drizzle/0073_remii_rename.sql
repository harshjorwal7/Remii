-- Remii, the chief of staff, was `general-assistant`.
--
-- This is a RENAME of a primary key, which is why it is a migration and not an edit to a seed file.
-- `general-assistant` was a poor name for the Bot that holds the computer and hands work to every other
-- Bot here: the generic name made the centre of the product read as an also-ran. The id is a database key
-- and a product promise at the same time, so changing what a person sees means changing the key too.
--
-- WHY THE CONSTRAINTS COME OFF FIRST. Ten foreign keys point at `agents.id` or `agent_profiles.agent_id`,
-- and none of them is `ON UPDATE CASCADE` — they are all `ON DELETE`. PostgreSQL enforces a foreign key
-- immediately, so a plain `UPDATE ... SET agent_id = 'remii'` is refused while any child row still names
-- the old value. Dropping, rewriting and restoring in that order is the only sequence that works without
-- `DEFERRABLE`, which none of these are.
--
-- `agent_profiles` is updated BEFORE `agents` because it is itself a child of `agents`, and the reverse
-- order would break the constraint that was just restored.
--
-- EVERY TABLE THAT NAMES A BOT IS HERE, including the ones with no foreign key. `memories.bot_id`,
-- `run_activity.bot_id`, `artifacts.bot_id` and the rest are plain text columns: nothing enforces them,
-- so a forgotten one is not an error — it is a Bot whose entire history silently belongs to an id that no
-- longer exists. The list was taken from `information_schema.columns` rather than from the schema files,
-- precisely because a column with no constraint is invisible to a constraint-driven search.
--> statement-breakpoint
ALTER TABLE "channel_agents" DROP CONSTRAINT "channel_agents_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_last_message_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_preferences" DROP CONSTRAINT "agent_preferences_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_profiles" DROP CONSTRAINT "agent_profiles_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "component_exclusions" DROP CONSTRAINT "component_exclusions_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "plugin_grants" DROP CONSTRAINT "plugin_grants_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "routines" DROP CONSTRAINT "routines_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "composio_account_grants" DROP CONSTRAINT "composio_account_grants_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "plugin_revocations" DROP CONSTRAINT "plugin_revocations_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "bot_computers" DROP CONSTRAINT "bot_computers_bot_id_agents_agent_id_fk";
--> statement-breakpoint

-- THE PARENT KEY FIRST, and this is the statement the whole migration exists for.
--
-- `agents.id` is the primary key every other row points at, and it is what is actually being renamed. An
-- earlier draft of this file updated `agents.name` here and forgot `agents.id`, which fails in a way worth
-- recording: the children below move to `remii` while the parent is still `general-assistant`, so the
-- foreign key is violated on the FIRST child update and the migration stops — having already renamed
-- nothing. The error names `channel_agents` and says nothing about the actual mistake, because from the
-- constraint's point of view it is entirely correct: a row really was about to name a Bot that is not
-- there.
UPDATE "agents" SET "id" = 'remii', "name" = 'Remii', "updated_at" = now() WHERE "id" = 'general-assistant';
--> statement-breakpoint

-- Its profile, which is a child of `agents` and so still names the old key at this point. Both the label a
-- person reads and the seed are corrected here; the seed in particular is cosmetic rather than cosmetic —
-- `avatar_seed` decides which mascot a coworker is drawn as, so leaving it would show the old face.
UPDATE "agent_profiles" SET "title" = 'Chief of Staff', "role_description" = 'Remii, chief of staff. Runs the day: holds the computer, keeps track of what is owed, and hands work to other coworkers when they are the better fit.', "avatar_seed" = 'remii', "updated_at" = now() WHERE "agent_id" = 'general-assistant';
--> statement-breakpoint

-- Children of `agents`, which now have no constraint to satisfy.
UPDATE "channel_agents" SET "agent_id" = 'remii' WHERE "agent_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "channels" SET "last_message_agent_id" = 'remii' WHERE "last_message_agent_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "agent_preferences" SET "agent_id" = 'remii' WHERE "agent_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "agent_profiles" SET "agent_id" = 'remii' WHERE "agent_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "component_exclusions" SET "agent_id" = 'remii' WHERE "agent_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "plugin_grants" SET "agent_id" = 'remii' WHERE "agent_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "routines" SET "agent_id" = 'remii' WHERE "agent_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "composio_account_grants" SET "agent_id" = 'remii' WHERE "agent_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "plugin_revocations" SET "agent_id" = 'remii' WHERE "agent_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "bot_computers" SET "bot_id" = 'remii' WHERE "bot_id" = 'general-assistant';
--> statement-breakpoint

-- Columns with NO foreign key on them, which is why nothing would have complained about leaving them.
--
-- These carry a Bot's entire history. A row left naming `general-assistant` is not rejected, not warned
-- about and not visible as broken: it is a conversation, a memory or a run record attributed to an id that
-- no longer resolves. `run_activity` in particular still drives the roster's working indicator, so a
-- stranded row there is a conversation that says it is thinking forever.
UPDATE "memories" SET "bot_id" = 'remii' WHERE "bot_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "memory_events" SET "bot_id" = 'remii' WHERE "bot_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "run_activity" SET "bot_id" = 'remii' WHERE "bot_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "artifacts" SET "bot_id" = 'remii' WHERE "bot_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "automations" SET "bot_id" = 'remii' WHERE "bot_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "cron_jobs" SET "bot_id" = 'remii' WHERE "bot_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "computer_scopes" SET "bot_id" = 'remii' WHERE "bot_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "budget_debits" SET "bot_id" = 'remii' WHERE "bot_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "usage_records" SET "agent_id" = 'remii' WHERE "agent_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "threads" SET "agent_id" = 'remii' WHERE "agent_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "vault_agent_items" SET "used_by_agent_id" = 'remii' WHERE "used_by_agent_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "vault_cards" SET "used_by_agent_id" = 'remii' WHERE "used_by_agent_id" = 'general-assistant';
--> statement-breakpoint
UPDATE "vault_logins" SET "used_by_agent_id" = 'remii' WHERE "used_by_agent_id" = 'general-assistant';
--> statement-breakpoint

-- Back, byte-identical to what was dropped. `ON DELETE` semantics are restored rather than improved: a
-- rename is not the place to change what happens when a coworker is deleted.
ALTER TABLE "channel_agents" ADD CONSTRAINT "channel_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_last_message_agent_id_agents_id_fk" FOREIGN KEY ("last_message_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "agent_preferences" ADD CONSTRAINT "agent_preferences_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "component_exclusions" ADD CONSTRAINT "component_exclusions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "plugin_grants" ADD CONSTRAINT "plugin_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "composio_account_grants" ADD CONSTRAINT "composio_account_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "plugin_revocations" ADD CONSTRAINT "plugin_revocations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "bot_computers" ADD CONSTRAINT "bot_computers_bot_id_agents_agent_id_fk" FOREIGN KEY ("bot_id") REFERENCES "agent_profiles"("agent_id") ON DELETE CASCADE;