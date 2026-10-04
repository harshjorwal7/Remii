-- A coworker can be paused.
--
-- Remii is the chief of staff over the roster, and there are two things it could not do about a
-- coworker it was not happy with: it could not halt work already in flight, and it could not put a
-- coworker on hold at all. `bot_pause` and `bot_resume` are the second of those, and this is where
-- the switch lives.
--
-- A nullable timestamp rather than a boolean, for the same reason `mascot_shape` is one: null is a
-- fact the reader can act on without knowing whether the column was added before or after its row
-- was written. A boolean defaulting to false cannot distinguish "never paused" from "written before
-- the column existed", and that difference is the whole question when you are deciding whether a
-- coworker that is not working is paused or simply idle.
--
-- `paused_reason` is not bookkeeping. A roster with a paused coworker and no reason is a roster
-- somebody has to ask about, and the answer is usually one line of a past conversation. The reason
-- is cleared with the pause, never left behind to describe a pause that has ended.

ALTER TABLE "agent_profiles" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "paused_reason" text;