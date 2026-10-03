import type { Database } from "../db/client";
import { sweepAbandonedRuns } from "./abandoned";
import type { RunActivityEvent } from "./store";

/**
 * RUN THE ABANDONED-RUN SWEEP ON A TIMER, AND ANNOUNCE WHAT IT SETTLED.
 *
 * Separate from the retention sweeper on purpose, and the reason is who is harmed by a delay. The
 * retention sweep deleting old rows is housekeeping: nothing is broken while it waits, and a day late
 * costs a row. This sweep is the only thing that clears a run nobody is running, and a roster row
 * that says "Working" for a run that ended days ago is a lie somebody is looking at. So it runs on
 * its own short interval, starts soon after boot, and is independent of the retention configuration —
 * a deployment that sets `ACTIVITY_RETENTION_DAYS=0` to keep everything still needs this, because
 * keeping a row is not the same as a row being true.
 *
 * The interval is a minute because the grace period is a minute: sweeping much less often than the
 * thing it sweeps adds nothing but latency to clearing a ghost.
 */
export function startAbandonedRunSweeps(
  database: Database,
  publish: (event: RunActivityEvent) => Promise<void>,
  options: { intervalMs?: number; firstRunMs?: number } = {},
): { stop: () => void } {
  const intervalMs = options.intervalMs ?? 60_000;
  const firstRunMs = options.firstRunMs ?? 15_000;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const run = () => {
    void sweepAbandonedRuns(database)
      .then((result) => {
        /*
         * ANNOUNCED BEFORE THE COUNT IS LOGGED, because the announcement is the point and the log is
         * for an operator who is already looking.
         *
         * One failure does not stop the rest: a mark that clears for four of five ghosts is worth
         * more than a mark that clears for none because the fifth threw, and the next tick picks the
         * fifth up because its row is still open.
         */
        for (const row of result.ended) {
          void publish({
            runId: row.runId,
            actorUserId: row.actorUserId,
            botId: row.botId,
            channelId: row.channelId,
            state: "stopped",
            label: row.label,
            // The reason is what the roster's `title` reads, and it is the only place a person is
            // told that a run ended because the connection went rather than because it finished.
            detail: "The connection was closed before the run finished.",
            startedAt: row.startedAt.toISOString(),
            parentRunId: row.parentRunId,
          }).catch(() => {});
        }
        if (result.ended.length > 0) {
          console.log(
            JSON.stringify({
              type: "abandoned_runs_swept",
              ended: result.ended.length,
              locksReleased: result.locksReleased,
            }),
          );
        }
      })
      .catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            type: "abandoned_run_sweep_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      })
      .finally(() => {
        const timer = setTimeout(run, intervalMs);
        timer.unref?.();
        timers.push(timer);
      });
  };

  const first = setTimeout(run, firstRunMs);
  first.unref?.();
  timers.push(first);

  return {
    stop: () => {
      for (const timer of timers.splice(0)) clearTimeout(timer);
    },
  };
}
