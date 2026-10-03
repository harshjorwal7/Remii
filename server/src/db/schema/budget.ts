/**
 * What a person has spent, and what they have got left — in dollars, not credits.
 *
 * THE SHAPE OF THE PRODUCT. A credit is an abstraction nobody outside the code can reason about: a
 * person told "3 of 100 credits" has to trust a conversion they cannot see, and the conversion is the
 * thing they would want to argue with. So spend is recorded in the currency it happens in — US dollars
 * of model tokens and US dollars of computer time — and the meter shows a percentage of what was
 * bought. What a person spends, they can check.
 *
 * ONE TABLE, NOT A BALANCE. There is no balance to maintain, no ledger to reconcile and no
 * double-entry to get wrong: what is left is `SUM(cost_usd)` over the period, and the period is named
 * by the three timestamps below. A balance column would drift from the rows that justify it, and a
 * drifted balance is a number a person notices.
 *
 * THREE PERIODS ON EVERY ROW, because the meter is shown against all three and re-deriving them at
 * read time from one timestamp is how a reset happens at 4am for someone whose day starts at 9. They
 * are stamped by the writer, once, so a row cannot be counted into a window it did not happen in.
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./core";

/**
 * One metered thing that cost money.
 *
 * Append-only. There is no update and no delete in the code that writes this table, and that is the
 * point: a meter that can be edited is not a meter. Retention is a sweep, like every other table's.
 */
export const budgetDebits = pgTable(
  "budget_debits",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Which Bot incurred it. Null for spend that is not a Bot's — a prewarm, a sweep. */
    botId: text("bot_id"),
    /**
     * `llm` or `computer`. Both debit the same wallet, because both are real cost, but they are
     * counted separately in the UI: a person who has run out of one has a different problem from a
     * person who has run out of the other, and "you are out" is not an answer either of them can act on.
     */
    kind: text("kind").notNull(),

    /* The three periods this row counts against. Stamped by the writer. */

    /** Start of the 5-hour window. Anchored to UTC clock hours, not to first use. */
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    /** Start of the week. Monday 00:00 UTC. */
    weekStart: timestamp("week_start", { withTimezone: true }).notNull(),
    /** Start of the month. The 1st, 00:00 UTC. */
    monthStart: timestamp("month_start", { withTimezone: true }).notNull(),

    /* What it cost, in the shape of the thing that cost it. */

    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    model: text("model"),
    /** Billed seconds of a switched-on computer. 60 is one minute. */
    billableSeconds: integer("billable_seconds"),
    /**
     * The money. `numeric` and not a float: this is a sum of many small irrational-looking divisions,
     * and a float accumulation drifts far enough to matter by the end of a month.
     */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull(),
    /**
     * Why the row exists, in words. For an audit that reads as a sentence, and for the meter when
     * somebody asks where their money went.
     */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The two reads that decide whether a turn may start, so both are indexed on the person and the
    // period rather than filtered on the way past.
    index("budget_debits_user_window_idx").on(table.userId, table.windowStart),
    index("budget_debits_user_week_idx").on(table.userId, table.weekStart),
    index("budget_debits_user_month_idx").on(table.userId, table.monthStart),
    index("budget_debits_user_kind_idx").on(table.userId, table.kind),
  ],
);

/**
 * One stretch of time a person's computer was switched on and being paid for.
 *
 * E2B bills a running sandbox by the second, so a session that was switched on but idle is still
 * money. That is the number the plan is sized on and the number nobody could previously obtain: before
 * this, a deployment could look at its provider bill and not at what any of it was for.
 *
 * Opened when the sandbox comes up and closed when it is paused or falls idle. A row with a null
 * `endedAt` is an OPEN session, which is a real state and not an oversight — it is how the meter knows
 * to charge for time that has happened but not yet been written off.
 */
export const computerSessions = pgTable(
  "computer_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The sandbox this was. The provider's own id, kept so a session can be matched to a machine. */
    sandboxId: text("sandbox_id"),
    /** When it was switched on. The start of everything billable. */
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** When it stopped being paid for. Null while it is still on. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** The interval, written on close. Null while open, which is not the same as zero. */
    billableSeconds: integer("billable_seconds"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    /**
     * Why it ended: `idle` (the four-minute sweep), `session_cap` (the twenty-minute run limit),
     * `quota` (out of allowance), `shutdown`, or `person`. Recorded because "it stopped" and "it was
     * reclaimed because nobody was using it" are different things to a person reading their meter.
     */
    endedReason: text("ended_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The meter: everything this person has spent, per period.
    index("computer_sessions_user_idx").on(table.userId),
    // The idle sweep's query: who is switched on and might be reclaimable. Partial, because open
    // sessions are a small minority of the table and the sweep runs every few seconds.
    index("computer_sessions_open_idx")
      .on(table.userId, table.startedAt)
      .where(sql`${table.endedAt} is null`),
  ],
);
