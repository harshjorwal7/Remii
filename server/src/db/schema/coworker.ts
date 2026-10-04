/**
 * Coworker tables: bots, skills, routines, bot-to-bot handoff.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or computer.ts to do it.
 */
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const agentVisibility = pgEnum("agent_visibility", [
  "public",
  "private",
]);

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    isSystemTemplate: boolean("is_system_template").default(false),
    title: text("title").notNull(),
    roleDescription: text("role_description").notNull(),
    avatarSeed: text("avatar_seed").notNull(),
    /*
     * The mascot a coworker wears: a body silhouette and a colour.
     *
     * Both are nullable, and null is not "unset, fill in a default" — it is "not chosen", and it
     * is what every row written before this feature says. The client fills a null axis from
     * `avatar_seed`, so each seeded agent lands on a different mascot out of 96 and the whole
     * existing roster gains variety without a backfill migration touching a single row.
     *
     * Storing two nullable columns rather than one serialised choice is what makes a partial choice
     * expressible: somebody who has only ever picked a colour should still see their coworkers differ
     * in shape. The ids come from `shared/mascot-ids.ts`, which the app and the server both read, and
     * the values are ours in English rather than the engine's French — see that file and
     * `app/src/mascot/bloub/UPSTREAM.md`.
     *
     * There was a third column, `mascot_expression`, and migration 0070 drops it. A face was never a
     * thing to choose: it is what the coworker is doing, so it is derived from its state in the app
     * and there is nothing here for it to live in.
     */
    mascotShape: text("mascot_shape"),
    mascotColor: text("mascot_color"),
    /*
     * Whether the Bot is paused. A null timestamp is the common case — not paused — the same "null
     * means not chosen" reading the mascot columns use. Set means a coworker that will not take
     * work until resumed; see `bot_pause`/`bot_resume`.
     */
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedReason: text("paused_reason"),
    visibility: agentVisibility("visibility").notNull(),
    /*
     * The credential this Bot's agent presents when it calls a tool back.
     *
     * A hash, never the token. We issue it, the agent's owner holds it, and this side only ever needs
     * to check one: storing the token itself would mean a database dump is a set of working
     * credentials for every registered agent.
     *
     * Null means the agent has not been issued one and may not call tools back, which is the right
     * default: a URL somebody pasted gets no capability until an administrator hands it one.
     */
    callbackTokenHash: text("callback_token_hash"),
    callbackTokenIssuedAt: timestamp("callback_token_issued_at", {
      withTimezone: true,
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("agent_profiles_visibility_deleted_idx").on(
      table.visibility,
      table.deletedAt,
    ),
  ],
);

export const agentPreferences = pgTable(
  "agent_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);

export const routineRunStatus = pgEnum("routine_run_status", [
  "succeeded",
  "failed",
  "skipped",
]);

/**
 * A standing instruction one person gave one Bot, on a schedule.
 *
 * Owned rows all the way down: the owner is who the headless turn runs as, so the routine can do
 * exactly what its owner could do in chat and nothing more. The channel is where the reply lands.
 */
export const routines = pgTable(
  "routines",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * Not a foreign key. Channels soft-delete (`channels.deletedAt`), and a routine pointing at a
     * deleted channel must survive to be shown as broken rather than vanish in a cascade.
     */
    channelId: text("channel_id").notNull(),
    instruction: text("instruction").notNull(),
    /** Five-field cron. Validated at the tool boundary; never parsed by the client. */
    cron: text("cron").notNull(),
    /** IANA zone the cron is read in. UTC when the person never said otherwise. */
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    /** The sweep's read target. Recomputed on every write and CAS-advanced by the sweep. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    /**
     * The last occurrence stamp the sweep advanced past — fired OR silently drained as stale.
     * Not "when this last ran": the run history lives in routine_runs, and everything a person
     * sees reads that table. This is the scheduler's own bookmark, kept because a CAS needs the
     * value it compared against recorded somewhere a human can inspect when a clock looks wrong.
     */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("routines_due_idx").on(table.enabled, table.nextRunAt),
    /** Owner-scoped reads and writes: listFor, countEnabled, and the users cascade all hit this. */
    index("routines_by_owner_idx").on(table.ownerUserId, table.enabled),
  ],
);

export const routineSweeps = pgTable("routine_sweeps", {
  id: text("id").primaryKey(),
  sweptAt: timestamp("swept_at", { withTimezone: true }).notNull().defaultNow(),
  owner: text("owner"),
});

/** One row per firing, which is what the page's "last ran" and the fatigue rule read. */
export const routineRuns = pgTable(
  "routine_runs",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Null means the firing is still in flight; only a finished run has succeeded/failed/skipped. */
    status: routineRunStatus("status"),
    /** The refusal or the throw, capped like audit payloads. Never shown raw to a person. */
    error: text("error"),
    creditsConsumed: integer("credits_consumed").notNull().default(0),
  },
  (table) => [
    index("routine_runs_by_routine_idx").on(table.routineId, table.startedAt),
  ],
);
