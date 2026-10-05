import { createUnpooledConnection } from "./db/unpooled";

/**
 * Keep `run_activity` to a window.
 *
 * The audit trail has its own retention and its own reasons: it is the record of who did what, kept
 * because an incident may be looked into long after it happened. This table is not that. It answers
 * "what is working right now", and it answers that question from the rows that have not ended — so
 * the finished ones are a cost with no reader behind them once the roster has moved on.
 *
 * THE REUSE, AND WHY IT IS ONLY A REUSE. Everything structural here comes from the audit sweep: the
 * advisory lock so several replicas do not contend, `ctid` batches so a big table stays writable,
 * and a dedicated connection released whatever happens. What differs is the subject, and that this
 * table has no append-only trigger to stand down for — a run is updated in place as it moves between
 * states, which is the whole design, so there is nothing to exempt.
 */

export type ActivitySweepResult = { deleted: number | null };

/** Rows per statement, and statements per sweep. The same bounds the audit sweep uses. */
const BATCH = 5_000;
const MAX_BATCHES = 20;

/**
 * The same lock the audit sweep takes, for the same reason.
 *
 * ONE LOCK FOR BOTH, NOT TWO. A deployment with several replicas fires both sweeps in the same
 * second, and two locks would let them run concurrently — each taking batches from different tables
 * and holding connections while the other waits for nothing. One lock means they take turns, which
 * is the outcome both of them would have chosen.
 */
const SWEEP_LOCK = 827_164_051;

/**
 * Remove finished runs older than the window.
 *
 * ONLY FINISHED ONES. A run that has not ended is the roster's answer to "what is working now", and
 * a sweep that removed one would make a working Bot look idle — on a clock, with no way to tell the
 * difference between quiet and swept. `ended_at is null` is therefore in the predicate and not
 * incidental to it.
 */
export async function sweepRunActivity(
  databaseUrl: string,
  retentionDays: number,
): Promise<ActivitySweepResult> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    return { deleted: null };
  }

  const connection = createUnpooledConnection(databaseUrl);

  try {
    const [lock] = await connection`
      select pg_try_advisory_lock(${SWEEP_LOCK}) as held
    `;
    if (!lock?.held) return { deleted: null };

    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const removed = await connection.begin(
        async (tx) => tx`
        delete from run_activity where ctid in (
          select ctid from run_activity
          where ended_at is not null
            and started_at < now() - (${retentionDays} || ' days')::interval
          limit ${BATCH}
        )
      `,
      );

      const count = removed.count ?? 0;
      deleted += count;
      if (count < BATCH) break;
    }

    return { deleted };
  } finally {
    await connection.end({ timeout: 5 }).catch(() => undefined);
  }
}

export type ActivitySweeper = { stop: () => void };

/**
 * Sweep on an interval, starting shortly after boot.
 *
 * The audit sweeper's own reasons apply unchanged: not at boot, because a rolling deployment would
 * have every replica contend for the lock in the same second, and the winner would compete with
 * start-up for the database.
 */
export function startActivitySweeps(
  databaseUrl: string,
  retentionDays: number | undefined,
  options: { intervalMs?: number; firstRunMs?: number } = {},
): ActivitySweeper {
  const intervalMs = options.intervalMs ?? 60 * 60_000;
  const firstRunMs = options.firstRunMs ?? intervalMs;
  const timers: ReturnType<typeof setTimeout>[] = [];

  if (!Number.isInteger(retentionDays) || (retentionDays ?? 0) < 1) {
    return { stop: () => undefined };
  }

  const run = () => {
    void sweepRunActivity(databaseUrl, retentionDays as number)
      .then((result) => {
        if (result.deleted) {
          console.log(
            JSON.stringify({
              type: "run_activity_retention_swept",
              deleted: result.deleted,
              retentionDays,
            }),
          );
        }
      })
      .catch((error: unknown) => {
        // A sweep that fails is a table that is not shrinking. Nothing about the product stops
        // working, so it is reported and the next tick tries again.
        console.warn(
          JSON.stringify({
            type: "run_activity_retention_sweep_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      })
      .finally(() => {
        if (timers.length > 0) {
          const timer = setTimeout(run, intervalMs);
          timer.unref?.();
          timers.push(timer);
        }
      });
  };

  const first = setTimeout(run, firstRunMs);
  first.unref?.();
  timers.push(first);

  return {
    stop: () => {
      for (const timer of timers.splice(0)) {
        clearTimeout(timer);
      }
    },
  };
}
