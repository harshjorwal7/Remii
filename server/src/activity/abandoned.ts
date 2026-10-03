import { and, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { runActivity } from "../db/schema";
import { threadLocks } from "../db/schema/threads";

/**
 * END THE RUNS NOBODY IS STILL RUNNING.
 *
 * A run's activity row is ended by the run's own settlement — the one place that knows it finished,
 * was stopped, or broke. That covers every run that ends while its process is alive, and it covers
 * none of the runs that do not: a browser closed mid-answer, a pod killed mid-run, a laptop lid shut
 * on a streaming response. In all of those the run is over and nothing says so.
 *
 * THE CONSEQUENCE IS A GHOST, AND IT IS THE ONE THING A ROSTER MUST NEVER SHOW. The row stays
 * `thinking`, so the channel keeps its working pulse for ever, the line above the composer says
 * "Working" for ever, and the roster reduction keeps picking that run as the most urgent one — so a
 * channel can be pinned open by a run that ended days ago and can never be cleared by any amount of
 * waiting. Retention does not save it either: the default is thirty days, so the ghost lasts a month.
 *
 * WHY THE LOCK IS THE SIGNAL, and why not a timeout on the row alone. A run is alive exactly as long
 * as it holds its thread's lock, and the lock is renewed on a heartbeat while the run works. So a
 * run whose lock has expired is a run nothing is renewing: either it died or it is between renewals.
 * A GRACE PERIOD is the part that keeps the second case out — a run whose heartbeat is merely late
 * gets its lock back and must not be reported dead — so nothing here acts on a lock that expired
 * within the window, only on one that has been gone long enough that the run is certainly over.
 *
 * This is the same signal `ThreadLock.sweepExpired` already computes and then throws away with a
 * `void rows`. That function had no caller at all, so nothing swept a stale lock either. It is left
 * in place for whoever owns the lock table; this module does the sweep it was written for, because
 * the consequence of skipping it lands in the run activity table and nowhere else.
 */

/**
 * How long a run may be unrenewed before it is called over.
 *
 * A minute is many times the heartbeat interval and comfortably longer than any pause between
 * renewals on a busy run, so this cannot fire on a run that is merely slow. It is short enough that
 * a closed tab stops showing a ghost within a minute rather than at the next deploy.
 */
export const ABANDONED_RUN_GRACE_MS = 60_000;

export type AbandonedRunSweep = {
  /**
   * The runs it finished, with everything a listener needs to redraw them.
   *
   * The whole row rather than a count, because a sweep whose whole job is to clear a mark that is
   * currently on somebody's screen has to be able to say what the mark should become. A count would
   * leave the caller to fetch each one, which is a query per ghost.
   */
  ended: {
    runId: string;
    actorUserId: string;
    botId: string;
    channelId: string | null;
    label: string | null;
    startedAt: Date;
    parentRunId: string | null;
  }[];
  /** Lock rows removed at the same time, so a stale lock cannot linger either. */
  locksReleased: number;
};

/**
 * Finish every run that is not being renewed, and release the lock rows that prove it.
 *
 * The two happen together and in one transaction because they are the same statement: a run is over
 * when its lock is gone, so the rows that say so and the rows that record it are the same fact.
 */
export async function sweepAbandonedRuns(
  database: Database,
  options: { graceMs?: number; now?: Date; batch?: number } = {},
): Promise<AbandonedRunSweep> {
  const graceMs = options.graceMs ?? ABANDONED_RUN_GRACE_MS;
  const now = options.now ?? new Date();
  const batch = options.batch ?? 500;
  const expiredBefore = new Date(now.getTime() - graceMs);

  /*
   * The candidate set, taken FIRST and without deleting anything.
   *
   * A run that is between renewals has a lock that expired a moment ago, and this grace period is
   * what keeps that run out of the set. The lock row is deleted in the same transaction as the
   * activity row is finished, so there is no window in which a run is reported dead and its lock is
   * still held — which would be the one ordering that could kill a live run.
   *
   * LOCKS ONLY, AND THAT IS A LIMITATION RATHER THAN AN OVERSIGHT.
   *
   * A hop proves it is alive by renewing a lock row, so an expired lock is real evidence that it is
   * not. A CHAT RUN DOES NOT TAKE A LOCK ROW AT ALL — it runs through the runtime — so this sweep
   * cannot see a person's own conversation, and a chat whose process was killed leaves its
   * activity row `thinking` with no `ended_at` that nothing will ever move.
   *
   * Treating "an open activity row with no lock" as evidence of death was tried and reverted, and
   * the reason is the whole contract of this function: absence of a heartbeat is not evidence that
   * a run has stopped. It is the same absence that describes a run between renewals, and a sweeper
   * that reads it as death will kill live turns. The test `is left alone, however long its lock has
   * been gone` is that guarantee, and it outranks the ghost it was aimed at.
   *
   * So the ghost is fixed where it can be fixed honestly — by giving a chat run a heartbeat to be
   * absent from — and not here.
   */
  const lockCandidates = await database
    .select({ runId: threadLocks.runId })
    .from(threadLocks)
    .where(lt(threadLocks.expiresAt, expiredBefore))
    .limit(batch);

  const candidates = [...lockCandidates];
  if (candidates.length === 0) return { ended: [], locksReleased: 0 };

  const runIds = [
    ...new Set(
      candidates
        .map((row) => row.runId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (runIds.length === 0) return { ended: [], locksReleased: 0 };

  const ended = await database.transaction(async (transaction) => {
    /*
     * ONLY ROWS THAT HAVE NOT ENDED, and only the `stopped` state.
     *
     * `ended_at is null` is the guard that makes this safe to run on a timer: a run that finished
     * normally keeps the record it earned, and a re-sweep cannot overwrite a `failed` with a
     * `stopped` — the same reason `finish` guards on it, and the reason a periodic sweeper is more
     * dangerous than a one-off repair.
     *
     * `stopped` rather than `done`, because nobody stopped this. A person closing a tab is not a
     * decision about the run, and saying "done" would put a false claim on a run that never answered.
     */
    const updated = await transaction
      .update(runActivity)
      .set({
        state: "stopped",
        endedAt: now,
        // The reason is said, because a person looking at a channel that stopped working on its own
        // deserves to know it was not a decision they made.
        detail: "The connection was closed before the run finished.",
        transitions: sql`${runActivity.transitions} + 1`,
      })
      .where(
        and(inArray(runActivity.runId, runIds), isNull(runActivity.endedAt)),
      )
      .returning({
        runId: runActivity.runId,
        actorUserId: runActivity.actorUserId,
        botId: runActivity.botId,
        channelId: runActivity.channelId,
        label: runActivity.label,
        startedAt: runActivity.startedAt,
        parentRunId: runActivity.parentRunId,
      });

    /*
     * And the lock goes, in the same transaction, so the next run on that thread is not told to wait.
     *
     * RE-ASSERTED EXPIRED INSIDE THE TRANSACTION, because the candidate list was read before it. A
     * run that was 61 seconds late on its heartbeat — the grace is 60 and the beat is 30 — can renew
     * in the gap between that read and this commit, and a delete that did not check would then take
     * the lock out from under a run that is very much alive and let a second run into the
     * conversation while the first is still writing to it. The condition is the same one the select
     * used, applied by the database, so the only rows that go are the ones that were already stale
     * when they were chosen.
     */
    const released = await transaction
      .delete(threadLocks)
      .where(
        and(
          inArray(threadLocks.runId, runIds),
          lt(threadLocks.expiresAt, expiredBefore),
        ),
      )
      .returning({ runId: threadLocks.runId });

    return { updated, locksReleased: released.length };
  });

  return { ended: ended.updated, locksReleased: ended.locksReleased };
}
