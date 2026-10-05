/**
 * When the nightly memory passes are due, as a decision worth testing on its own.
 *
 * Extracted from the loop in `index.ts` for one reason: the bug this shape exists to prevent is
 * invisible in the loop and obvious here. The loop ran the pass behind a single "have I done today"
 * flag and set that flag BEFORE making the request, so a fetch that timed out at 00:00:02 marked
 * the day done and the whole UTC day was lost — no consolidation and, because the morning brief
 * rode inside the same block, no brief either. Nothing retried until the date rolled over. There is
 * no test over the loop that would have caught it, because the loop is never imported by one.
 *
 * A module of its own for the second reason: `index.ts` calls `loadWorkerEnv` at module scope and
 * throws without `WORKER_SHARED_SECRET`, so a test cannot import the loop at all.
 */

/** How long before a failed nightly pass is tried again. */
export const NIGHTLY_RETRY_MS = 60_000;

/** The UTC day, as the flag that records a pass stores it. */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Whether tonight's pass is due.
 *
 * Two questions rather than one, and the split is the fix. "Has this already worked today?" ends
 * the day on success alone. "Has it been tried recently?" bounds the retry, so a consolidation
 * endpoint that is permanently down is asked hourly rather than every 30 seconds for the next
 * twenty-four hours.
 *
 * A pass that failed has not happened, so a day it did not work on is still owed one — which is
 * exactly what marking the day before the request got wrong.
 */
export function shouldRunNightly(
  now: number,
  lastSuccessDay: string,
  lastAttempt: number,
  retryMs: number = NIGHTLY_RETRY_MS,
): boolean {
  if (lastSuccessDay === utcDay(now)) return false;
  return now - lastAttempt >= retryMs;
}
