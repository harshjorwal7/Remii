import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { budgetDebits } from "../src/db/schema/budget";
import { periodEnd, periodStart, spendInPeriod } from "../src/billing/budget";
import { createComputerMeter } from "../src/billing/computer-meter";
import {
  COMPUTER_HOUR_USD,
  DESKTOPS,
  PLANS,
  modelBudgetUsdFor,
} from "../src/billing/plans";
import { testDatabase } from "./support/database";

/**
 * The margin is the product.
 *
 * These tests exist because the numbers in `plans.ts` are a CLAIM — that a $39 plan spends 25% of its
 * price — and a claim that only exists in a comment is a claim nobody checks until the provider bill
 * arrives. So the arithmetic is asserted here, and so is the behaviour that spends it: sessions are
 * charged at the right rate, closed once, and stamped with the period they STARTED in.
 */

let database: Database;
let userId: string;

beforeEach(async () => {
  database = testDatabase();
  const [user] = await database
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      email: `meter-${crypto.randomUUID()}@test.local`,
    })
    .returning({ id: users.id });
  userId = user!.id;
});

afterEach(async () => {
  await database.$client.end({ timeout: 5 });
});

describe("plan arithmetic", () => {
  test("every plan targets 75% gross margin", () => {
    // 25% of price is the whole budget. A tier added without thinking about this is a tier that
    // quietly loses money, and nothing else in the codebase would notice.
    for (const limits of Object.values(PLANS)) {
      expect(limits.monthlyCogsUsd).toBeCloseTo(limits.priceUsd * 0.25, 6);
    }
  });

  test("the computer allowance and the model budget together equal the COGS budget", () => {
    for (const limits of Object.values(PLANS)) {
      const computerUsd = limits.computerHoursPerMonth * COMPUTER_HOUR_USD;
      expect(computerUsd + modelBudgetUsdFor(limits)).toBeCloseTo(
        limits.monthlyCogsUsd,
        6,
      );
    }
  });

  test("one hour of computer is what E2B's rates say, at the spec we ship", () => {
    // 2 vCPU at $0.0504 and 4 GiB at $0.0162, billed per second on the allocation. If this fails, E2B's
    // prices changed OR the machine was resized, and every allowance in this file is wrong — which is
    // exactly what happened when the spec went from 1/2 to 2/4 and the hours silently stopped
    // covering the bill.
    //
    // These are the SAME rates Daytona charged, to the fourth decimal, so moving platforms did not move
    // this number. That is worth a test of its own: the natural assumption on a platform swap is that the
    // unit cost changed and the allowances should be re-derived, and re-deriving them wrongly would move
    // every plan's margin for no reason.
    expect(COMPUTER_HOUR_USD).toBeCloseTo(2 * 0.0504 + 4 * 0.0162, 6);
  });

  test("the spec is one a desktop can actually work on", () => {
    // 2 GiB was the floor, not a target: a full XFCE desktop plus a browser is near a gigabyte before
    // any tab, so the rest of the memory went on staying up rather than working.
    expect(DESKTOPS.memoryGb).toBeGreaterThanOrEqual(4);
    expect(DESKTOPS.vcpu).toBeGreaterThanOrEqual(2);
  });

  test("the hour allowances still cover their share of the budget after the resize", () => {
    // The arithmetic that actually protects the margin: computer hours at the real rate must not
    // exceed the computer's share of the COGS budget.
    for (const limits of Object.values(PLANS)) {
      expect(
        limits.computerHoursPerMonth * COMPUTER_HOUR_USD,
      ).toBeLessThanOrEqual(limits.monthlyCogsUsd);
    }
  });

  test("neither plan gives away more than it keeps", () => {
    // The computer must not exceed the budget on its own, or the model gets a negative budget and the
    // plan is a loss with a nice UI.
    for (const limits of Object.values(PLANS)) {
      expect(modelBudgetUsdFor(limits)).toBeGreaterThan(0);
    }
  });

  test("the expensive plan is worth the price on both axes", () => {
    const pro = PLANS.pro;
    const power = PLANS.power;
    expect(power.computerHoursPerMonth).toBeGreaterThan(
      pro.computerHoursPerMonth * 3,
    );
    expect(modelBudgetUsdFor(power)).toBeGreaterThan(
      modelBudgetUsdFor(pro) * 2,
    );
  });

  test("the idle stop is four minutes, because that is what the prompt tells Remii", () => {
    // The guidance in shared/bot-prompt.ts quotes this number to the model. If one moves and the other
    // does not, Remii is told to expect a machine that behaves differently from the one it has.
    for (const limits of Object.values(PLANS)) {
      expect(limits.idleStopMinutes).toBe(4);
    }
  });
});

describe("meter periods", () => {
  test("a window starts on a five-hour boundary in UTC", () => {
    // Anchored at 23:00, so the boundaries are 23/04/09/14/19. See budget-periods.test.ts for why the
    // anchor is not midnight: five five-hour windows cannot tile a day from 00:00 without a hole.
    const at = new Date("2026-03-11T07:42:19.500Z");
    expect(periodStart(at, "window").toISOString()).toBe(
      "2026-03-11T04:00:00.000Z",
    );
  });

  test("windows are exactly five hours apart", () => {
    const at = new Date("2026-03-11T07:42:19.500Z");
    const start = periodStart(at, "window");
    const end = periodEnd(at, "window");
    expect(end.getTime() - start.getTime()).toBe(5 * 3600 * 1000);
  });

  test("a week starts on Monday, not Sunday", () => {
    // 2026-03-11 is a Wednesday. A Sunday-start week would have put this in the one before.
    const wednesday = new Date("2026-03-11T12:00:00.000Z");
    expect(periodStart(wednesday, "week").toISOString()).toBe(
      "2026-03-09T00:00:00.000Z",
    );
    // A Sunday must land on the Monday FIVE days earlier, not the Monday after.
    const sunday = new Date("2026-03-15T23:59:00.000Z");
    expect(periodStart(sunday, "week").toISOString()).toBe(
      "2026-03-09T00:00:00.000Z",
    );
  });

  test("a month starts on the first", () => {
    expect(
      periodStart(new Date("2026-03-31T23:00:00.000Z"), "month").toISOString(),
    ).toBe("2026-03-01T00:00:00.000Z");
  });

  test("a window ends where the next one begins, and every one is a full five hours", () => {
    // The last window of a day straddles midnight: 19:00 to 00:00 is five hours, and the one before
    // it began at 14:00. Asserted so a later change to the anchoring cannot quietly shorten a window
    // and make the same allowance spendable twice as fast.
    const evening = new Date("2026-03-11T22:00:00.000Z");
    expect(periodStart(evening, "window").toISOString()).toBe(
      "2026-03-11T19:00:00.000Z",
    );
    expect(periodEnd(evening, "window").toISOString()).toBe(
      "2026-03-12T00:00:00.000Z",
    );
  });
});

describe("computer sessions", () => {
  test("an hour on the clock is charged at the hourly rate", async () => {
    const meter = createComputerMeter(database);
    await meter.open({ userId, sandboxId: "sbx-1" });

    const closed = await meter.close({
      userId,
      reason: "person",
      endedAt: new Date(Date.now() + 3600 * 1000),
    });

    expect(closed?.seconds).toBe(3600);
    expect(closed?.costUsd).toBeCloseTo(COMPUTER_HOUR_USD, 6);
  });

  test("the charge lands in the month and shows on the meter", async () => {
    const meter = createComputerMeter(database);
    await meter.open({ userId, sandboxId: "sbx-2" });
    await meter.close({
      userId,
      reason: "person",
      endedAt: new Date(Date.now() + 1800 * 1000),
    });

    expect(await meter.hoursThisMonth(userId)).toBeCloseTo(0.5, 3);
  });

  test("a session is charged once, however many times it is closed", async () => {
    // The sweep and a person stopping the machine at the same moment both call close. Charging twice
    // would bill two hours for one, and the meter would be wrong in the direction that costs money.
    const meter = createComputerMeter(database);
    await meter.open({ userId, sandboxId: "sbx-3" });

    const first = await meter.close({ userId, reason: "idle" });
    const second = await meter.close({ userId, reason: "person" });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("a second open while one is running does not double-charge", async () => {
    // A prewarm and a tool call racing. The loser must be a no-op, or the same interval is written
    // twice and the bill is doubled.
    const meter = createComputerMeter(database);
    expect(await meter.open({ userId, sandboxId: "sbx-4" })).not.toBeNull();
    expect(await meter.open({ userId, sandboxId: "sbx-4" })).toBeNull();
  });

  test("a month boundary separates spend, and the straddling session is not double-counted", async () => {
    /*
     * The risk is a machine switched on at 23:50 on the last day of a month and stopped at 00:10:
     * those twenty minutes belong wholly to the old month. Charging them to the new one puts them in
     * two months and makes both meters wrong by a visible amount.
     *
     * Tested against a row stamped for March and read with a March anchor, because what can break here
     * is the anchoring of the read — the stamping is `close()`'s job and is covered above.
     */
    const costUsd = (1200 / 3600) * COMPUTER_HOUR_USD;
    await database.insert(budgetDebits).values({
      id: crypto.randomUUID(),
      userId,
      kind: "computer",
      windowStart: periodStart(new Date("2026-03-31T23:50:00.000Z"), "window"),
      weekStart: periodStart(new Date("2026-03-31T23:50:00.000Z"), "week"),
      monthStart: periodStart(new Date("2026-03-31T23:50:00.000Z"), "month"),
      billableSeconds: 1200,
      costUsd: costUsd.toFixed(6),
      reason: "computer idle",
      createdAt: new Date("2026-04-01T00:10:00.000Z"),
    });

    const inMarch = await spendInPeriod(
      database,
      userId,
      "month",
      new Date("2026-03-31T23:59:00.000Z"),
    );
    expect(inMarch.computerUsd).toBeCloseTo(costUsd, 6);

    // April reads nothing, so the twenty minutes are in exactly one month.
    const inApril = await spendInPeriod(
      database,
      userId,
      "month",
      new Date("2026-04-01T00:30:00.000Z"),
    );
    expect(inApril.computerUsd).toBe(0);
  });

  test("spend is split so computer time can be metered on its own", async () => {
    const meter = createComputerMeter(database);
    await meter.open({ userId, sandboxId: "sbx-6" });
    await meter.close({
      userId,
      reason: "person",
      endedAt: new Date(Date.now() + 600 * 1000),
    });

    const all = await spendInPeriod(database, userId, "month");
    const computerOnly = await spendInPeriod(
      database,
      userId,
      "month",
      undefined,
      {
        debitKind: "computer",
      },
    );
    expect(computerOnly.usd).toBeCloseTo(all.computerUsd, 6);
    expect(all.computerUsd).toBeGreaterThan(0);
  });
});
