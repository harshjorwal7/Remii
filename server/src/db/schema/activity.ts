import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./core";

/**
 * What a Bot is doing, and what it handed to.
 *
 * ONE ROW PER RUN, NOT ONE PER STATE CHANGE. That is the whole design, and it is a correction of
 * the obvious version. A run passes through several states — thinking, then a tool, then delegated,
 * then done — and logging each transition would make this table grow with the work rather than with
 * the work's outcomes: a ten-tool audit is one row here and ten in a log. It would also make the
 * interesting question expensive, because "what did Remii do, and to whom" becomes a fold over
 * transitions instead of a scan of runs.
 *
 * THE LIVE VERSION IS NOT HERE. Changes reach the browser over a `pg_notify` topic, which is a
 * moment and evaporates. This is the record that survives it. A reader wants a different thing from
 * each and mixing them is how a roster ends up explaining a run that finished an hour ago.
 *
 * NO TASK TEXT. The words a Bot was asked to do are already durable in `work_items.payload`, with
 * the delegation that carried them. Copying them here would put a second, differently-retained copy
 * of model-written free text into a new table, which is the opposite of what this table is for: it
 * holds ids, states and timestamps. `label` is a short phrase this code writes — "Handed to Research
 * Desk", "Running a command" — never the task.
 */
export type RunActivityState =
  /** Composing, or executing a tool, with no other Bot involved yet. */
  | "thinking"
  /** Handed to another Bot, which is now the one working. */
  | "delegated"
  /** Asked the person something, or asked for a credential or the browser. */
  | "waiting_on_you"
  /** Ended by a person, or by a cap, without failing. */
  | "stopped"
  /** Ended badly, and `error` says why. */
  | "failed"
  /** Finished. */
  | "done";

export const runActivity = pgTable(
  "run_activity",
  {
    /**
     * The run this row is about, and its primary key.
     *
     * A run id names exactly one run, and this table says one thing about it, so the key is the
     * run id and a second row for the same run would be a bug rather than a version. The
     * transition that moves it between states updates the row in place.
     */
    runId: text("run_id").primaryKey(),
    /** Whose run it was. Every read of this table is scoped to one person. */
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Which Bot is running, and whose name a reader should show. */
    botId: text("bot_id").notNull(),
    /**
     * The conversation a person can open, or null when there is none.
     *
     * Nullable on purpose rather than pointing at a scratch thread. A hop runs in a thread with no
     * channel of its own, and that is not a defect — it is the shape of work nobody is watching in
     * a window. A column forced to name one would either lie or refuse the row.
     */
    channelId: text("channel_id"),
    threadId: text("thread_id").notNull(),
    /**
     * The run this one was delegated from, or null for a run a person started.
     *
     * This is the delegation edge, and it is what makes a chain readable: Remii's run has a null
     * parent, Research Desk's run points at it, Coco's at that. The whole chain is one recursive
     * walk from the top, which is the answer to "who did what".
     */
    parentRunId: text("parent_run_id"),
    state: text("state").$type<RunActivityState>().notNull(),
    /**
     * A short phrase this code wrote about what is happening, for the roster and the status line.
     *
     * Never the task. See the note on the table.
     */
    label: text("label"),
    /** The tool being run, when there is one. Shown as detail beside the state, not instead of it. */
    detail: text("detail"),
    /**
     * When the run started. Carried here rather than read from `threads`, so a chain is one table.
     */
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * When it ended, or null while it is still going.
     *
     * Null is the whole query for "what is working right now", which is the roster's only question
     * and the one a live broadcast cannot answer after a reload. It is why this table is worth
     * having rather than being a log of transitions.
     */
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Why it failed, in the words the failure produced. Null unless `state` is `failed`. */
    error: text("error"),
    /**
     * How many state changes this run went through.
     *
     * Not for display: it is the number that says whether the live feed and the row agree, and the
     * guard against a Bot stuck in a loop reading as a healthy long run.
     */
    transitions: integer("transitions").notNull().default(0),
    /**
     * The last moment this run said it was still going, or null if it never has.
     *
     * THIS IS THE HEARTBEAT, AND IT IS WHY THE GHOST CAN BE ENDED AT ALL.
     *
     * A run is alive exactly as long as something keeps saying so. A hop proves it by renewing a
     * `thread_locks` row, which is why `sweepAbandonedRuns` could be written against that table
     * alone — and a person's own chat run takes no lock, so it had nothing to renew and nothing the
     * sweeper could see. A run whose stream died mid-turn therefore stayed `thinking` with a null
     * `ended_at` for ever, and because `thinking` outranks every terminal state in
     * `ACTIVITY_SEVERITY`, that stale row kept winning the roster reduction: a channel pinned open by
     * a run that ended days ago, which no amount of waiting could clear.
     *
     * So the liveness signal is carried here as well, and on every run rather than only on hops.
     *
     * NULLABLE, and that is the honest default rather than an oversight. `defaultNow()` would stamp a
     * heartbeat on every row the migration touched, claiming a liveness nobody observed. Null means
     * exactly what it says — this row has never been seen alive — and the sweeper acts on that
     * difference rather than papering over it: it ends a run whose beat is PRESENT AND LAPSED, and
     * leaves a null beat alone, because absence of a heartbeat is not evidence of death and a
     * sweeper that reads it as death kills live turns. A null-beat row is ended by the finish that
     * reaches a dropped teardown instead. See `activity/abandoned.ts`.
     */
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  },
  (table) => [
    /*
     * THE ROSTER'S QUERY: everything still going, for one person.
     *
     * PARTIAL on `ended_at is null`, which is the point of it. Open runs are a small fraction of
     * the table and they are the only thing a page load asks for, so the index holds exactly the
     * rows that can answer it. A full index over the same columns would be scanned and discarded
     * for every finished run, forever, to answer a question about the present.
     */
    index("run_activity_actor_open_idx")
      .on(table.actorUserId, table.startedAt)
      .where(sql`${table.endedAt} is null`),
    /** The delegation chain, walked from any run to the one a person started. */
    index("run_activity_parent_idx").on(table.parentRunId),
    /** Retention's sweep, which is a range scan on age and nothing else. */
    index("run_activity_started_idx").on(table.startedAt),
    /*
     * THE SWEEPER'S QUERY, and the second reason this column earns its place.
     *
     * Partial on `ended_at is null` for the same reason the roster's is: open runs are the small
     * fraction the sweeper can act on, and holding every finished run in an index to find ghosts
     * would be a permanent cost to clear the occasional one.
     *
     * `last_heartbeat_at` leads because the sweep is a range scan on how stale the beat is, and
     * because open rows are a small fraction of the table — most runs finish — so the partial
     * predicate keeps the index to the only rows the sweeper can act on.
     *
     * Not a `coalesce` to `started_at`. That expression reads better and is worse: the planner cannot
     * turn it into a bounded range, so the sweep degrades to a scan of every open row on every tick
     * instead of an index range over the lapsed ones. The null beats are simply not candidates —
     * see the column's note — and leaving them to the front of the index costs nothing.
     */
    index("run_activity_open_heartbeat_idx")
      .on(table.lastHeartbeatAt)
      .where(sql`${table.endedAt} is null`),
  ],
);
