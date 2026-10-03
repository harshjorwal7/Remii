/**
 * Computer time: when it starts being paid for, when it stops, and the sweep that stops it.
 *
 * An E2B sandbox costs $0.0828 an hour from the moment it is created until the moment it is paused,
 * whether or not anything is happening on it — billed on ALLOCATION, not on use, so an idle desktop is
 * exactly as expensive as a busy one. That makes the idle pause the single number the whole price rests
 * on.
 *
 * The rate is unchanged from Daytona, so nothing here had to move; what changed is that the platform's
 * OWN answer is now worse than ours. E2B does not stop a sandbox for idleness on its own initiative in
 * any way we can rely on — a sandbox is kept alive until `timeoutMs`, which is a ceiling on continuous
 * runtime (one hour on Hobby, 24 on Pro) and not an idle policy. So a Bot driving the machine over the
 * API looks like activity from every side, and without a sweep here a person who had gone to lunch would
 * still be paying.
 *
 * So the four-minute stop is a sweep in this file, keyed on when the computer was last touched, and
 * E2B_AUTOSTOP_MINUTES is left longer as a backstop for the case where this process is the thing that
 * died.
 *
 * Sessions are recorded because before this nobody could say what any of the platform bill was FOR. The
 * meter a person sees is a claim about their money, and it has to be answerable from rows.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { budgetDebits, computerSessions } from "../db/schema/budget";
import { periodStart } from "./budget";
import { COMPUTER_HOUR_USD } from "./plans";

/** Why a session ended. Recorded because "it stopped" and "we reclaimed it" are different to a reader. */
export type SessionEndReason =
  | "idle"
  | "session_cap"
  | "quota"
  | "shutdown"
  | "person";

export function createComputerMeter(database: Database) {
  return {
    /**
     * Open a session, unless one is already open for this computer.
     *
     * Idempotent by open row rather than by a lock, because the failure it prevents is paying twice
     * for the same machine: a prewarm and a tool call racing would otherwise open two rows for one
     * interval, and the sum would be double the real cost. A partial index on open sessions makes the
     * loser a visible no-op.
     */
    async open(input: {
      userId: string;
      sandboxId: string | null;
    }): Promise<{ id: string } | null> {
      const existing = await database
        .select({ id: computerSessions.id })
        .from(computerSessions)
        .where(
          and(
            eq(computerSessions.userId, input.userId),
            isNull(computerSessions.endedAt),
          ),
        )
        .limit(1);
      if (existing[0]) return null;

      const id = crypto.randomUUID();
      const inserted = await database
        .insert(computerSessions)
        .values({
          id,
          userId: input.userId,
          sandboxId: input.sandboxId,
          startedAt: new Date(),
        })
        .returning({ id: computerSessions.id })
        .catch(() => null);
      return inserted?.[0] ?? null;
    },

    /**
     * Close the open session and charge for it.
     *
     * The charge goes in as a `budget_debits` row stamped with the periods the session STARTED in, not
     * the ones it ended in. A machine switched on at 23:50 and stopped at 00:10 belongs wholly to the
     * day it started on: charging it to the day it ended would put those twenty minutes in two months
     * and make both meters wrong by a visible amount.
     *
     * Billable seconds are computed from the row's own `startedAt` rather than from `Date.now() - now`,
     * which would be the same thing today and wrong the moment a session is closed by a sweep that
     * noticed it had been idle rather than by a stop.
     */
    async close(input: {
      userId: string;
      reason: SessionEndReason;
      endedAt?: Date;
    }): Promise<{ seconds: number; costUsd: number } | null> {
      const endedAt = input.endedAt ?? new Date();
      const [open] = await database
        .select()
        .from(computerSessions)
        .where(
          and(
            eq(computerSessions.userId, input.userId),
            isNull(computerSessions.endedAt),
          ),
        )
        .limit(1);
      if (!open) return null;

      const seconds = Math.max(
        0,
        Math.round((endedAt.getTime() - open.startedAt.getTime()) / 1000),
      );
      const costUsd = (seconds / 3600) * COMPUTER_HOUR_USD;
      const startedAt = open.startedAt;

      await database
        .update(computerSessions)
        .set({
          endedAt,
          billableSeconds: seconds,
          costUsd: costUsd.toFixed(6),
          endedReason: input.reason,
        })
        .where(eq(computerSessions.id, open.id))
        .catch(() => undefined);

      if (seconds > 0) {
        await database
          .insert(budgetDebits)
          .values({
            id: crypto.randomUUID(),
            userId: input.userId,
            kind: "computer",
            windowStart: periodStart(startedAt, "window"),
            weekStart: periodStart(startedAt, "week"),
            monthStart: periodStart(startedAt, "month"),
            billableSeconds: seconds,
            costUsd: costUsd.toFixed(6),
            reason: `computer ${input.reason}`,
            createdAt: endedAt,
          })
          .catch(() => undefined);
      }

      return { seconds, costUsd };
    },

    /** Hours already charged to this person this month, which is what the computer meter shows. */
    async hoursThisMonth(
      userId: string,
      at: Date = new Date(),
    ): Promise<number> {
      const rows = await database
        .select({
          seconds: sql<string>`coalesce(sum(${budgetDebits.billableSeconds}), 0)`,
        })
        .from(budgetDebits)
        .where(
          and(
            eq(budgetDebits.userId, userId),
            eq(budgetDebits.kind, "computer"),
            eq(budgetDebits.monthStart, periodStart(at, "month")),
          ),
        );
      return Number(rows[0]?.seconds ?? 0) / 3600;
    },
  };
}

export type ComputerMeter = ReturnType<typeof createComputerMeter>;

/**
 * One person's computer, last touched at some point, and whether it should be reclaimed.
 *
 * Returned rather than acted on, because stopping a sandbox is the provisioner's business and this
 * module has no platform handle. Deciding here and stopping there keeps the price policy in one file and
 * the mechanics in the one that already knows how to stop a machine.
 */
export type IdleCandidate = {
  userId: string;
  sandboxId: string;
  idleSeconds: number;
};

/**
 * Who has a computer switched on and has not touched it for longer than `idleMinutes`.
 *
 * Driven by the `user_computers.last_seen_at` the provisioner already touches on every use, so this
 * needs no new write path: every code path that acts on the desktop already records that it did.
 *
 * COALESCE, and this is a fix rather than a nicety. The column is NULL on a row that has just been
 * provisioned — `last_seen_at` is written by `touch()` on the NEXT use, never at creation — and reading
 * NULL as "idle since forever" made the sweep reclaim every freshly started machine within a minute of
 * it coming up. The symptom was a desktop that provisioned, served one turn, and was then stopped,
 * over and over, which reads exactly like a desktop that does not work at all.
 *
 * So the reference is the newest of the three timestamps that describe when this machine was last
 * wanted: last seen, last started, or created. A machine that has never been touched is judged from
 * when it started, which is the only thing that can be known about it.
 */
export async function idleCandidates(
  database: Database,
  idleMinutes: number,
  now: Date = new Date(),
): Promise<IdleCandidate[]> {
  const cutoff = new Date(now.getTime() - idleMinutes * 60_000);
  const rows = await database.execute(sql`
    select
      user_id,
      sandbox_id,
      extract(epoch from (
        ${now} - coalesce(last_seen_at, last_started_at, created_at)
      ))::bigint as idle_seconds
    from user_computers
    where status not in ('STOPPED', 'DELETED', 'ERROR')
      and sandbox_id is not null
      and coalesce(last_seen_at, last_started_at, created_at) < ${cutoff}
  `);
  return (
    rows as unknown as Array<{
      user_id: string;
      sandbox_id: string;
      idle_seconds: string | number;
    }>
  ).map((row) => ({
    userId: row.user_id,
    sandboxId: row.sandbox_id,
    idleSeconds: Number(row.idle_seconds ?? 0),
  }));
}

/**
 * The sweep, on an interval rather than a per-request check.
 *
 * A timer because the check is "is anybody idle", which is not a question any one request can answer —
 * and a per-request check would mean a database read on the path of every screenshot to notice that a
 * machine somebody else is using has gone quiet.
 */
export function startIdleSweeps(options: {
  database: Database;
  idleMinutes: number;
  intervalMs?: number;
  onIdle: (candidate: IdleCandidate) => Promise<void> | void;
  onLog?: (line: string) => void;
}): () => void {
  const intervalMs = options.intervalMs ?? 60_000;

  const sweep = async () => {
    const candidates = await idleCandidates(
      options.database,
      options.idleMinutes,
    ).catch(() => [] as IdleCandidate[]);
    for (const candidate of candidates) {
      // One person's failure must not stop the sweep, and one bad row must not stop the rest: a
      // deployment where stopping a machine errors is a deployment paying for machines nobody is using.
      await Promise.resolve()
        .then(() => options.onIdle(candidate))
        .catch((error: unknown) => {
          options.onLog?.(
            `idle sweep failed for one computer: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  };

  const timer = setInterval(() => void sweep(), intervalMs);
  void sweep();
  return () => clearInterval(timer);
}
