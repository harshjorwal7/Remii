-- A coworker's mascot: a body silhouette, a colour and a resting expression.
--
-- Three nullable columns, and nullable is the point rather than an oversight. A null axis means "not
-- chosen", which is what every existing row says, and the client fills it from `avatar_seed`. That is
-- why this ships as three empty columns and no data backfill: the whole existing roster gains a
-- different mascot out of 1,536 combinations, without a migration reading or rewriting a single row.
--
-- Three columns and not one serialised choice, so a partial choice is expressible. Somebody who has
-- only ever picked a colour should still see their coworkers differ in shape, and a single blob could
-- not say that.
--
-- WHY THIS FILE IS NARROWER THAN WHAT drizzle-kit GENERATED.
--
-- `bun run db:generate` produced this migration together with a full `CREATE TABLE bot_computers` and
-- its two indexes. That is a pre-existing gap in the snapshot chain, not something this change caused:
-- 0065 was hand-written and committed without a `meta/0065_snapshot.json`, so the generator fell back
-- to 0064, had never seen `bot_computers`, and wrote it out as though it were new. Running that file
-- against a database where 0065 had already run fails on the first statement.
--
-- So the table creation is dropped and the three column additions are kept, which is what this
-- migration was for. The generated `meta/0066_snapshot.json` is left alone: it is a correct and
-- complete picture of the schema, `bot_computers` included, so the next `generate` compares against
-- reality and does not offer to create that table again. `drizzle-kit migrate` reads `_journal.json`
-- and the `.sql` files and never consults the snapshots, so this correction is invisible to it.
--
-- The `IF NOT EXISTS` is deliberate rather than belt-and-braces: it matches the style of 0065 and
-- makes the migration safe to re-run against a database that already has the columns.
ALTER TABLE "agent_profiles" ADD COLUMN IF NOT EXISTS "mascot_shape" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN IF NOT EXISTS "mascot_color" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN IF NOT EXISTS "mascot_expression" text;