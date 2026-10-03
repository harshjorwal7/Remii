/**
 * The three periods the meter is read against, and the dollars spent against each.
 *
 * THREE PERIODS BECAUSE THE PERSON SEES THREE NUMBERS. A 5-hour window stops one long burst eating a
 * month; a week stops a sustained week eating a month; the month is the ceiling underneath both and
 * the only one that is really a limit. All three are stamped by the writer when the money is spent, so
 * a row cannot be counted into a period it did not happen in, and all three start at UTC clock
 * boundaries rather than at first use.
 *
 * The clock boundaries are the part that matters for a person. If a window began when you first opened
 * the app, two people in the same conversation would see different resets for the same spend, and the
 * number on the screen would stop meaning anything. Anchored, everybody's reset is the same instant.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { budgetDebits } from "../db/schema/budget";

/** How long a window runs for. Claude-shaped, which is the shape people already recognise. */
export const WINDOW_HOURS = 5;

/**
 * The UTC hour the day's windows are anchored to.
 *
 * 23, and not 0, because 24 is not a multiple of 5. See the arithmetic in {@link periodStart}: five
 * five-hour windows tile a day only when the first begins an hour before midnight.
 */
export const ANCHOR_HOUR_UTC = 23;

export type PeriodKind = "window" | "week" | "month";

/**
 * The start of the period `at` falls in.
 *
 * UTC, and always on a boundary. A window is floored to the nearest 5-hour mark from midnight, a week
 * to the Monday, a month to the 1st. Daylight saving cannot move any of them, which is not true of a
 * window computed in local time — and a meter's reset that moves twice a year is a meter people stop
 * believing.
 */
export function periodStart(at: Date, kind: PeriodKind): Date {
  const start = new Date(
    Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate(),
      at.getUTCHours(),
      at.getUTCMinutes(),
      at.getUTCSeconds(),
      at.getUTCMilliseconds(),
    ),
  );

  if (kind === "month") {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  }
  if (kind === "week") {
    /*
     * Midnight is part of the answer, so it is rebuilt rather than moved.
     *
     * `setUTCDate` keeps the time of day, so stepping the date back to Monday left 12:00 on the
     * Monday. A week that started at noon would have put a Sunday-evening spend in the NEXT week's
     * bucket — half a day of every week attributed to the wrong one, and a reset that landed at
     * lunchtime for anyone reading it.
     */
    const dayOfWeek = start.getUTCDay();
    const sinceMonday = (dayOfWeek + 6) % 7;
    return new Date(
      Date.UTC(
        at.getUTCFullYear(),
        at.getUTCMonth(),
        at.getUTCDate() - sinceMonday,
      ),
    );
  }
  /*
   * WHERE THE DAY DOES NOT DIVIDE EVENLY, AND WHAT THAT FORCES.
   *
   * 24 is not a multiple of 5. Five windows anchored at 00/05/10/15/20 cover 25 hours, and the extra
   * one leaves 01:00–04:00 inside NO window at all: spend at 02:00 was counted nowhere, so it neither
   * depleted an allowance nor appeared on a meter. An exhaustive test caught this where two example
   * dates had not.
   *
   * Five windows can only tile a day if the FIRST one begins an hour before midnight, because
   * 5 × 5 = 25 = 24 + 1: the sequence of starts is s, s+5, s+10, s+15, s+20, and the wrap from s+25
   * back to s is exactly the one hour that makes it close. Anchoring at 23:00 gives the five starts
   * 23:00, 04:00, 09:00, 14:00 and 19:00 UTC, and those tile the day with no gap and no overlap.
   *
   * Every window is a full five hours, which is the part that cannot be compromised: a shorter window
   * would let the same allowance be spent twice as fast.
   */
  const windowMs = WINDOW_HOURS * 3_600_000;
  const midnight = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
  );
  // Today's anchor, and yesterday's when this instant is before it — which is every hour from
  // midnight to 23:00, because the day's windows begin in the evening.
  const anchorToday = midnight + ANCHOR_HOUR_UTC * 3_600_000;
  const anchor =
    at.getTime() >= anchorToday ? anchorToday : anchorToday - 86_400_000;
  // Whole windows FORWARD from that anchor, floored. Forward because the anchor is the most recent
  // one at or before this instant, so the window containing it lies after it — 07:42 is eight and a
  // half hours past 23:00 the evening before, which is one whole window on.
  const windowsOn = Math.floor((at.getTime() - anchor) / windowMs);
  return new Date(anchor + windowsOn * windowMs);
}

/** The start of the period AFTER the one `at` falls in. What a meter shows as "resets at". */
export function periodEnd(at: Date, kind: PeriodKind): Date {
  const start = periodStart(at, kind);
  if (kind === "month") {
    return new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
    );
  }
  if (kind === "week") {
    return new Date(start.getTime() + 7 * 24 * 3600 * 1000);
  }
  return new Date(start.getTime() + WINDOW_HOURS * 3600 * 1000);
}

export type Spend = {
  /** US dollars spent in the period. */
  usd: number;
  /** Of which computer time. Shown separately because running out of one is a different problem. */
  computerUsd: number;
};

/** Dollars spent by one person in one period, split by what spent them. */
export async function spendInPeriod(
  database: Database,
  userId: string,
  kind: PeriodKind,
  at: Date = new Date(),
  filter?: { debitKind?: "llm" | "computer" },
): Promise<Spend> {
  const start = periodStart(at, kind);
  const column =
    kind === "month"
      ? budgetDebits.monthStart
      : kind === "week"
        ? budgetDebits.weekStart
        : budgetDebits.windowStart;

  const rows = await database
    .select({
      usd: sql<string>`coalesce(sum(${budgetDebits.costUsd}), 0)`,
      computerUsd: sql<string>`coalesce(sum(${budgetDebits.costUsd}) filter (where ${budgetDebits.kind} = 'computer'), 0)`,
    })
    .from(budgetDebits)
    .where(
      and(
        eq(budgetDebits.userId, userId),
        eq(column, start),
        filter?.debitKind ? eq(budgetDebits.kind, filter.debitKind) : undefined,
      ),
    );

  const row = rows[0];
  return {
    usd: Number(row?.usd ?? 0),
    computerUsd: Number(row?.computerUsd ?? 0),
  };
}

/**
 * Dollars spent since a moment, which is how an open computer session is charged before it closes.
 *
 * A separate read rather than an argument to {@link spendInPeriod}, because a session's cost belongs to
 * whichever period it started in. A machine switched on at 23:50 and stopped at 00:10 must be charged
 * wholly to the day it started on, or a person can be billed for a month's last ten minutes twice.
 */
export async function spendSince(
  database: Database,
  userId: string,
  since: Date,
): Promise<number> {
  const rows = await database
    .select({
      usd: sql<string>`coalesce(sum(${budgetDebits.costUsd}), 0)`,
    })
    .from(budgetDebits)
    .where(
      and(
        eq(budgetDebits.userId, userId),
        eq(budgetDebits.kind, "computer"),
        gte(budgetDebits.createdAt, since),
      ),
    );
  return Number(rows[0]?.usd ?? 0);
}
