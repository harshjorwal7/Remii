import { describe, expect, test } from "bun:test";
import { NIGHTLY_RETRY_MS, shouldRunNightly } from "../src/nightly";

/**
 * The nightly cadence, tested as the decision it is rather than through the loop.
 *
 * `worker/src/index.ts` cannot be imported by a test at all: it calls `loadWorkerEnv` at module
 * scope and throws without `WORKER_SHARED_SECRET`. That is exactly why the bug this covers went
 * unnoticed — the flag that recorded an attempt before making it lived inside a module no test can
 * reach, and its failure mode is a whole UTC day quietly going missing rather than a thrown error.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** 2026-03-14T00:00:30Z — a little after midnight UTC, where this is decided. */
const JUST_AFTER_MIDNIGHT = Date.UTC(2026, 2, 14, 0, 0, 30);
const TODAY = "2026-03-14";
const YESTERDAY = "2026-03-13";

describe("shouldRunNightly", () => {
  test("runs on the first tick of a day nothing has run on", () => {
    expect(shouldRunNightly(JUST_AFTER_MIDNIGHT, "", 0)).toBe(true);
  });

  test("does not run twice on a day it has already worked", () => {
    expect(
      shouldRunNightly(JUST_AFTER_MIDNIGHT, TODAY, JUST_AFTER_MIDNIGHT),
    ).toBe(false);
  });

  test("runs again the next day", () => {
    const tomorrow = JUST_AFTER_MIDNIGHT + DAY;
    expect(shouldRunNightly(tomorrow, TODAY, JUST_AFTER_MIDNIGHT)).toBe(true);
  });

  /*
   * The regression. A pass that failed has not happened, so the day it failed on is still owed
   * one — and the retry lands inside the same day rather than at the next boundary.
   */
  test("retries within the same day after a failed pass", () => {
    const retryAt = JUST_AFTER_MIDNIGHT + NIGHTLY_RETRY_MS;
    expect(shouldRunNightly(retryAt, YESTERDAY, JUST_AFTER_MIDNIGHT)).toBe(
      true,
    );
  });

  test("bounds the retry, so a down endpoint is not asked every tick", () => {
    // A second since the last attempt: too soon.
    expect(
      shouldRunNightly(
        JUST_AFTER_MIDNIGHT + 1_000,
        YESTERDAY,
        JUST_AFTER_MIDNIGHT,
      ),
    ).toBe(false);
  });

  test("retries even when the failed attempt was on an earlier day", () => {
    // Started yesterday, never succeeded, and it is a minute past the retry window now.
    expect(
      shouldRunNightly(
        JUST_AFTER_MIDNIGHT,
        YESTERDAY,
        JUST_AFTER_MIDNIGHT - NIGHTLY_RETRY_MS - 1_000,
      ),
    ).toBe(true);
  });

  test("honours a caller-supplied retry window", () => {
    expect(
      shouldRunNightly(JUST_AFTER_MIDNIGHT, YESTERDAY, JUST_AFTER_MIDNIGHT, 0),
    ).toBe(true);
    expect(
      shouldRunNightly(
        JUST_AFTER_MIDNIGHT,
        YESTERDAY,
        JUST_AFTER_MIDNIGHT,
        HOUR,
      ),
    ).toBe(false);
  });
});
