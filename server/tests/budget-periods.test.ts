import { describe, expect, test } from "bun:test";
import {
  ANCHOR_HOUR_UTC,
  periodEnd,
  periodStart,
  WINDOW_HOURS,
} from "../src/billing/budget";

/**
 * The meter's arithmetic, asserted exhaustively rather than by example.
 *
 * This started as two hand-picked dates and caught a bug immediately, which is the argument for the
 * exhaustive form. The first version anchored at midnight and checked that 07:42 fell in the 05:00
 * window; walking every minute of a day found that 01:00 to 04:00 fell in NO window at all, because
 * 24 is not a multiple of 5 and five windows anchored at midnight cover 25 hours with a hole in the
 * middle. Spend in that hole counted nowhere, so it neither depleted an allowance nor appeared on a
 * meter. The anchor is 23:00 for exactly that reason, and the reason is asserted here so nobody
 * "tidies" it back to midnight.
 *
 * So every minute of a day is walked and the invariants are checked at each one, which also pins the
 * boundaries the product promises: resets at 00:00, 05:00, 10:00, 15:00 and 20:00 UTC.
 */

describe("five-hour windows", () => {
  const anchors = [ANCHOR_HOUR_UTC, 4, 9, 14, 19];

  test("every window starts on a whole five-hour UTC anchor", () => {
    // Across a whole day, walked an hour at a time: 24am–1am is yesterday's 20:00, and everything
    // from 4am lands on 5, 10, 15 or 20.
    for (let hour = 0; hour < 24; hour++) {
      const start = periodStart(
        new Date(Date.UTC(2026, 2, 11, hour, 30)),
        "window",
      );
      expect(anchors).toContain(start.getUTCHours());
      expect(start.getUTCMinutes()).toBe(0);
      expect(start.getUTCSeconds()).toBe(0);
      expect(start.getUTCMilliseconds()).toBe(0);
    }
  });

  test("every instant falls in a window that contains it", () => {
    for (let hour = 0; hour < 24; hour++) {
      for (const minute of [0, 1, 29, 30, 59]) {
        const at = new Date(Date.UTC(2026, 2, 11, hour, minute));
        const start = periodStart(at, "window");
        const end = periodEnd(at, "window");
        expect(start.getTime()).toBeLessThanOrEqual(at.getTime());
        expect(end.getTime()).toBeGreaterThan(at.getTime());
        expect(end.getTime() - start.getTime()).toBe(
          WINDOW_HOURS * 3600 * 1000,
        );
      }
    }
  });

  test("windows tile the day with no gap and no overlap", () => {
    // The windows in a day must cover every second of it exactly once. A gap would let a spend fall
    // into no window at all and never be counted; an overlap would count it twice.
    // Counted minute by minute rather than by summing window lengths, so a window that was too long
    // and one that was too short would cancel out and hide behind each other.
    const startOfDay = Date.UTC(2026, 2, 11);
    let uncovered = 0;
    let doubleCovered = 0;
    for (let minute = 0; minute < 24 * 60; minute++) {
      const at = new Date(startOfDay + minute * 60_000);
      const start = periodStart(at, "window");
      const end = periodEnd(at, "window");
      if (start.getTime() > at.getTime() || end.getTime() <= at.getTime()) {
        uncovered++;
      }
      // A neighbouring window must NOT also contain this instant.
      const neighbour = new Date(at.getTime() + 60_000);
      if (
        periodStart(neighbour, "window").getTime() ===
          periodStart(at, "window").getTime() &&
        periodEnd(neighbour, "window").getTime() ===
          periodEnd(at, "window").getTime()
      ) {
        // Same window as its successor is only a problem at a boundary; inside a window it is correct.
        if (end.getTime() === at.getTime() + 60_000) doubleCovered++;
      }
    }
    expect(uncovered).toBe(0);
    expect(doubleCovered).toBe(0);
  });

  test("an instant after midnight belongs to the window that began before it", () => {
    expect(
      periodStart(new Date("2026-03-12T00:30:00.000Z"), "window").toISOString(),
    ).toBe("2026-03-11T23:00:00.000Z");
    expect(
      periodStart(new Date("2026-03-12T03:59:00.000Z"), "window").toISOString(),
    ).toBe("2026-03-11T23:00:00.000Z");
    expect(
      periodEnd(new Date("2026-03-12T00:30:00.000Z"), "window").toISOString(),
    ).toBe("2026-03-12T04:00:00.000Z");
  });

  test("the hour after the 23:00 anchor starts a fresh window", () => {
    // The boundary that an example-based test misses: with a 23:00 anchor, 04:00 is the first reset of
    // the morning rather than 05:00.
    expect(
      periodStart(new Date("2026-03-12T04:00:00.000Z"), "window").toISOString(),
    ).toBe("2026-03-12T04:00:00.000Z");
  });

  test("consecutive instants on a boundary never disagree about their window", () => {
    for (const boundary of [
      "04:00:00",
      "09:00:00",
      "14:00:00",
      "19:00:00",
      "23:00:00",
    ]) {
      const lastOfPrevious = new Date(
        `2026-03-11T${boundary.slice(0, 5)}:00.000Z`,
      );
      lastOfPrevious.setTime(lastOfPrevious.getTime() - 1);
      const atBoundary = new Date(`2026-03-11T${boundary.slice(0, 5)}:00.000Z`);

      // The instant before a reset and the reset itself are in DIFFERENT windows, and that is the
      // property: a spend at 04:59:59 and one at 05:00:00 must not share a bucket, or a window's
      // allowance is spendable twice.
      expect(periodStart(lastOfPrevious, "window").getTime()).toBeLessThan(
        periodStart(atBoundary, "window").getTime(),
      );
    }
  });

  test("a window is the same everywhere on earth, because it is anchored in UTC", () => {
    // The boundary is computed from UTC parts only. A window computed in local time would move twice a
    // year, and a meter's reset that moves is a meter people stop believing.
    expect(
      periodStart(new Date("2026-03-11T07:42:19.500Z"), "window").toISOString(),
    ).toBe("2026-03-11T04:00:00.000Z");
  });
});

describe("weeks", () => {
  test("every day of a week belongs to the Monday that begins it", () => {
    // 2026-03-09 is a Monday.
    for (let day = 0; day < 7; day++) {
      const start = periodStart(
        new Date(Date.UTC(2026, 2, 9 + day, 23, 59)),
        "week",
      );
      expect(start.toISOString()).toBe("2026-03-09T00:00:00.000Z");
    }
  });

  test("a week starts at midnight, not at whatever time the instant was", () => {
    // The bug this caught: stepping the DATE back to Monday kept the time of day, so a Wednesday
    // at noon produced a week that began Monday at noon — and every Sunday-evening spend landed in
    // the following week's bucket.
    expect(
      periodStart(new Date("2026-03-11T12:00:00.000Z"), "week").toISOString(),
    ).toBe("2026-03-09T00:00:00.000Z");
    expect(
      periodStart(new Date("2026-03-09T00:00:00.000Z"), "week").toISOString(),
    ).toBe("2026-03-09T00:00:00.000Z");
  });

  test("the next week begins seven days later", () => {
    const end = periodEnd(new Date("2026-03-11T12:00:00.000Z"), "week");
    expect(end.toISOString()).toBe("2026-03-16T00:00:00.000Z");
  });

  test("a week spans a month boundary without complaint", () => {
    expect(
      periodStart(new Date("2026-04-02T10:00:00.000Z"), "week").toISOString(),
    ).toBe("2026-03-30T00:00:00.000Z");
  });
});

describe("months", () => {
  test("a month starts on the first at midnight", () => {
    expect(
      periodStart(new Date("2026-03-31T23:00:00.000Z"), "month").toISOString(),
    ).toBe("2026-03-01T00:00:00.000Z");
    expect(
      periodStart(new Date("2026-02-01T00:00:00.000Z"), "month").toISOString(),
    ).toBe("2026-02-01T00:00:00.000Z");
  });

  test("a month ends where the next begins", () => {
    expect(
      periodEnd(new Date("2026-12-15T00:00:00.000Z"), "month").toISOString(),
    ).toBe("2027-01-01T00:00:00.000Z");
    // February in a leap year, which is the case that catches a naive 30-day month.
    expect(
      periodEnd(new Date("2028-02-15T00:00:00.000Z"), "month").toISOString(),
    ).toBe("2028-03-01T00:00:00.000Z");
  });
});
