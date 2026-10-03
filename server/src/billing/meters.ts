/**
 * What the person sees: a percentage of what they bought, and when it resets.
 *
 * TWO METERS, NOT ONE WALETTE, and the split is the point.
 *
 * A person who has used up their model allowance and a person who has used up their computer hours
 * have different problems and different remedies — one can be helped by finishing a sentence, the other
 * by coming back tomorrow. "You are out" is not an answer either of them can act on, so the two are
 * read separately and each is read against the period it belongs to.
 *
 * NO CREDITS ANYWHERE IN THIS FILE, and that is a decision rather than an omission. A credit is a unit
 * the person cannot see the conversion for, and the conversion is the thing they would want to argue
 * with. Everything here is either a percentage or a number of hours, and the dollars behind them are
 * only ever shown to whoever is administering the deployment.
 */

import { eq } from "drizzle-orm";
import { subscriptions } from "../db/schema";
import { periodEnd, spendInPeriod } from "./budget";
import type { ComputerMeter } from "./computer-meter";
import {
  limitsFor as limitsForTier,
  modelBudgetUsdFor,
  PLANS,
  type PlanLimits,
  weeklyWindowUsdFor,
} from "./plans";

/**
 * The plan one person is on, or the default where there is not one.
 *
 * PER PERSON, not per deployment. The computer allowance is a property of a subscription, so two people
 * on different plans have different computer allowances against the same deployment and the same provider
 * account — and reading it from configuration would give both of them whichever plan the operator
 * deployed.
 *
 * Reads through, because it is on the path of every computer tool call: a query per click would be absurd,
 * and a value captured at boot would still be showing a cancelled plan a month later.
 */
export async function limitsForUser(
  database: Parameters<typeof spendInPeriod>[0],
  userId: string,
): Promise<PlanLimits> {
  const [row] = await database
    .select({ tier: subscriptions.tier, byokAddon: subscriptions.byokAddon })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1)
    .catch(() => [] as Array<{ tier: string; byokAddon: boolean }>);

  // A BYOK subscriber pays their own model spend, so their computer allowance is the whole of their
  // COGS budget and the model meter is not theirs to read.
  if (row?.byokAddon)
    // A BYOK subscriber pays model spend directly, so their computer allowance is the whole
    // budget and the model meter is not theirs to read. `byok` is not a purchasable plan — it is the
    // add-on on top of one — so it falls back to the entry plan's computer hours.
    return limitsForTier("byok" in PLANS ? "byok" : "pro");
  return limitsForTier(row?.tier);
}

export type MeterReading = {
  /** 0–100, floored, and clamped so an overage cannot render as a negative bar. */
  percentRemaining: number;
  /** What was bought, in the unit this meter is denominated in. Hours for the computer. */
  allowance: number;
  /** What has been used, same unit. */
  used: number;
  /** When this reading goes back to full. Always an absolute instant, never "in 3 hours". */
  resetsAt: string;
};

/**
 * How much of this window is left, and when it refills.
 *
 * Three periods and the tightest one wins, because that is the one that will actually refuse work. The
 * month is included so the number a person reads is the real ceiling rather than a window they could
 * exhaust four times over — a meter showing "100% left" while the month is spent is worse than no
 * meter, because it is a promise the enforcement will break.
 */
export async function readWindow(
  database: Parameters<typeof spendInPeriod>[0],
  userId: string,
  plan: PlanLimits,
  at: Date = new Date(),
): Promise<MeterReading> {
  const [window, week, month] = await Promise.all([
    spendInPeriod(database, userId, "window", at, { debitKind: "llm" }),
    spendInPeriod(database, userId, "week", at, { debitKind: "llm" }),
    spendInPeriod(database, userId, "month", at, { debitKind: "llm" }),
  ]);

  /*
   * Window and week allowances are slices of the same monthly model budget, and the month is the whole
   * of it. The month is measured against the WHOLE monthly budget rather than the model slice, because
   * the computer is drawing on the same 25% — a month that is 90% gone on computer time must not report
   * the model as fully available.
   */
  const weekAllowance = modelBudgetUsdFor(plan) / (52 / 12);

  const periods = [
    fractionRemaining(window.usd, windowAllowanceUsd(plan), "window", at),
    fractionRemaining(week.usd, weekAllowance, "week", at),
    fractionRemaining(
      month.usd + month.computerUsd,
      plan.monthlyCogsUsd,
      "month",
      at,
    ),
  ].sort((a, b) => a.fraction - b.fraction);

  /*
   * The tightest of the three, which is the one that will actually refuse work.
   *
   * A non-null assertion rather than a default, because a missing reading here would silently report a
   * percentage with no reset time attached — the number would look right and the sentence under it would
   * be missing. The array is a literal of three, so this cannot be reached.
   */
  const remaining = periods[0];
  if (!remaining) {
    throw new Error(
      "No periods were compared, so there is no meter to report.",
    );
  }

  return {
    percentRemaining: Math.max(0, Math.floor(remaining.fraction * 100)),
    allowance: remaining.allowance,
    used: remaining.spent,
    resetsAt: remaining.resetsAt,
  };
}

/** The dollar allowance of one five-hour window, from the plan's model budget. */
function windowAllowanceUsd(plan: PlanLimits): number {
  return weeklyWindowUsdFor(plan);
}

/**
 * How much of one period is left.
 *
 * The reset is derived from the spend's own period rather than from a fresh `new Date()`, because the
 * caller may be asking about a moment that is not now — a test, or a replay — and a reset time computed
 * from the wrong clock is a reset that lies.
 */
function fractionRemaining(
  spent: number,
  allowance: number,
  kind: "window" | "week" | "month",
  at: Date,
) {
  return {
    fraction: allowance > 0 ? Math.max(0, 1 - spent / allowance) : 0,
    allowance,
    spent,
    resetsAt: periodEnd(at, kind).toISOString(),
  };
}

/**
 * The computer meter: hours used this month against the hours the plan bought.
 *
 * Hours rather than a percentage, because hours are what a person can plan around — "you have 40
 * minutes of computer left this month" is actionable and "you have 23% remaining" is not. The
 * percentage is still on it, for the shape the other meter uses.
 */
export async function readComputerMeter(
  meter: ComputerMeter,
  userId: string,
  plan: PlanLimits,
  at: Date = new Date(),
): Promise<MeterReading> {
  const used = await meter.hoursThisMonth(userId, at);
  const allowance = plan.computerHoursPerMonth;
  return {
    percentRemaining:
      allowance > 0 ? Math.max(0, Math.floor((1 - used / allowance) * 100)) : 0,
    allowance,
    used: Math.round(used * 100) / 100,
    resetsAt: periodEnd(at, "month").toISOString(),
  };
}

/** Both meters, in the shape a route hands to the browser. */
export async function readMeters(
  database: Parameters<typeof spendInPeriod>[0],
  meter: ComputerMeter,
  userId: string,
  tier: string | null | undefined,
  at: Date = new Date(),
): Promise<{
  plan: { tier: string; name: string; priceUsd: number; resetsAt: string };
  model: MeterReading;
  computer: MeterReading;
}> {
  const plan = limitsForTier(tier);
  const [model, computer] = await Promise.all([
    readWindow(database, userId, plan, at),
    readComputerMeter(meter, userId, plan, at),
  ]);
  return {
    plan: {
      tier: plan.tier,
      name: plan.name,
      priceUsd: plan.priceUsd,
      resetsAt: periodEnd(at, "month").toISOString(),
    },
    model,
    computer,
  };
}

/**
 * What a Bot is told when there is nothing left, as a sentence rather than a number.
 *
 * Named because it is the string a person reads through their assistant, and because "quota exceeded"
 * is a sentence that describes a system rather than helping anybody. It says what stopped, and when it
 * comes back, because the alternative — a Bot reporting a failure — costs more support than the sentence.
 */
export function outOfAllowance(
  what: "model" | "computer",
  resetsAt: Date,
): string {
  const when = resetsAt.toISOString().slice(0, 10);
  if (what === "computer") {
    return `Your computer time for this month is used up. It is available again on ${when}. Until then I can still do work through your connected apps.`;
  }
  return `Your model allowance for this period is used up, and it resets on ${when}. Your computer time is unaffected.`;
}
