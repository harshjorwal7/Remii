-- A run says it is still going.
--
-- `run_activity.ended_at` being null is what the roster reads as "working", and until now the only
-- thing that ever moved a run out of that state was the run's own settlement. A settlement that was
-- dropped — a chat turn whose teardown was discarded, a process killed mid-turn — left a row
-- `thinking` for ever, and because `thinking` outranks every terminal state in `ACTIVITY_SEVERITY`
-- that stale row went on winning the roster reduction. The symptom was a conversation that kept a
-- working pulse and a Stop button days after the work ended, unclearable by any amount of waiting.
--
-- `last_heartbeat_at` is the liveness signal that makes those rows sweepable. `sweepAbandonedRuns`
-- could already see a hop, because a hop renews a `thread_locks` row; a person's own chat run takes
-- no lock at all, so for the runs a person actually watches there was nothing to read. A run now
-- carries its first beat with its row and renews while it works, and the sweeper treats a beat that
-- is present and lapsed as evidence while still refusing to treat a merely absent one as death —
-- the same grace period and the same contract, applied to the runs that had no signal before.
--
-- NULLABLE, deliberately, and the backfill below is why that matters. `defaultNow()` would stamp a
-- beat on every row the migration touched, claiming a liveness nobody observed. Null means what it
-- says — this row has never been seen alive — so the sweeper can tell "never beat" apart from "beat
-- long ago" and refuse to guess about the first.
--
-- THE BACKFILL: open rows only, stamped with their own start time.
--
-- It has to be the open rows, because they are the only ones this column can still rescue. A finished
-- row's beat is never read by anything.
--
-- It has to be `started_at` rather than `now()`. The sweeper compares this column against a grace
-- period, so stamping the current time would tell it every one of these ghosts beat moments ago, and
-- it would then wait out the full grace before ending them — trading a permanent lie for a minute of
-- grace. Backdating to when the run started makes each row immediately and honestly ancient, which is
-- the true fact: nobody has beaten for any of them since before this column existed.
--
-- EVERY open row, with no state or age condition. An open row at the moment this column is added is
-- a row whose run has already stopped — there was nothing to beat before the column existed — so every
-- one of them is a ghost by definition, and the only question is how old, which `started_at` answers
-- exactly. Conditioning on `transitions` or on recency here would leave the commonest shape behind:
-- a run whose row was written and whose turn died in the same instant has no transitions at all, and
-- those are precisely the rows a stuck "Working" indicator is made of.
--
-- `last_heartbeat_at is null` keeps the statement re-runnable, so applying it to a database that has
-- already been stamped changes nothing rather than resetting a beat a live run has since sent.

ALTER TABLE "run_activity" ADD COLUMN "last_heartbeat_at" timestamp with time zone;--> statement-breakpoint
UPDATE "run_activity"
SET "last_heartbeat_at" = "started_at"
WHERE "ended_at" IS NULL
  AND "last_heartbeat_at" IS NULL;--> statement-breakpoint
CREATE INDEX "run_activity_open_heartbeat_idx" ON "run_activity" USING btree ("last_heartbeat_at") WHERE "run_activity"."ended_at" is null;
