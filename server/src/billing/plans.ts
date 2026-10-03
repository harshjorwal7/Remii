/**
 * What each plan buys, and what one computer hour costs.
 *
 * TWO PLANS, NO TRIAL, NO CREDITS. A person sees a percentage of what they bought and when it resets;
 * behind that are these numbers, and they are chosen from one number: the cost of running a computer
 * for an hour, which is what makes a flat monthly price either honest or quietly bankrupt.
 *
 * THE ARITHMETIC, because it is the whole design and it is easy to break by accident.
 *
 * E2B bills ALLOCATED resources by the second: $0.0504 per vCPU-hour and $0.0162 per GiB-hour of
 * memory, with disk included. A desktop is 2 vCPU and 4 GiB, so {@link COMPUTER_HOUR_USD} is $0.1656.
 *
 * Those rates are the same ones Daytona charged, to the fourth decimal, so this migration did not move
 * a single number in this file — worth stating because the temptation on a platform swap is to assume
 * the cost changed and quietly re-derive the allowances.
 *
 * A PAUSED sandbox is not billed, and neither is a killed one. That is the whole reason the idle policy
 * is a pause rather than a stop: it takes the machine's cost to zero without taking the person's desktop
 * away, and it comes back with its windows still open.
 *
 * So the hour allowance is still the thing that has to be right. A machine that is switched off costs
 * nothing, which is why the idle stop exists and why the computer allowance is expressed in hours
 * rather than in "always available".
 *
 * ONE FIXED COST THIS PLATFORM ADDS, and it is not per-desktop: E2B's Pro tier is a $150/month floor,
 * where Daytona had none. It does not change a single number here — it is spread over however many
 * desktops the deployment runs, so it makes the FIRST few hundred people expensive and the next few
 * thousand cheap. It is recorded here rather than in this repository's margin maths because the plan
 * prices are the product's decision and a platform floor is the deployment's.
 *
 * The target is 75% gross margin, so a plan spends 25% of its price:
 *
 *   $39  -> $9.75 a month: $4.97 of computer (30 hours) and $4.78 of model.
 *   $129 -> $32.25 a month: $19.87 of computer (120 hours) and $12.38 of model.
 *
 * Computer hours are set so the split lands exactly on the margin, and the model budget takes whatever
 * the computer does not. Raising a plan's computer allowance without lowering the model budget raises
 * the margin loss, and that is the single most likely way this file is broken by somebody adding a
 * tier.
 *
 * The hours are a CAP and not an expectation. A person who uses a tenth of their allowance costs a tenth
 * of the budget and earns a much better margin, which is what makes the worst case the thing that has
 * to be right: at the cap the margin is exactly 75%, and below it the margin is better.
 *
 * WHY ONE COMPUTER AND NOT ONE PER BOT. A computer is billed by the hour it is switched on, so a
 * computer per Bot makes the price of the product depend on how many coworkers a person happened to
 * create — which is not a thing to sell. One computer per person, held by Remii, and every Bot is
 * unlimited at no marginal cost, because they use connected apps.
 */

export const DESKTOPS = { vcpu: 2, memoryGb: 4 } as const;

/**
 * What one hour of a running desktop costs, from E2B's published per-second rates.
 *
 * 2 vCPU and 4 GiB. 4GiB because 2GiB cannot finish ordinary work — a full desktop plus a browser is
 * near a gigabyte before any tab, and the rest was spent staying up rather than working — and 2 vCPU
 * because a browser that is waiting on one core is the difference between work that finishes and work
 * that is merely started.
 *
 * Exactly DOUBLE the cost of the 1 vCPU / 2 GiB machine this replaced, which is why the hour allowances
 * in {@link PLANS} are half what they were when they were chosen. That is the whole trade and it is
 * stated rather than absorbed quietly: a person gets a machine that does the job, or twice the hours on
 * one that does not, at the same price. This buys the machine.
 */
import { DESKTOP_IDLE_STOP_MINUTES } from "../../../shared/desktop-idle";

export const COMPUTER_HOUR_USD =
  DESKTOPS.vcpu * 0.0504 + DESKTOPS.memoryGb * 0.0162;

export type PlanTier = "pro" | "power";

export type PlanLimits = {
  tier: PlanTier;
  name: string;
  priceUsd: number;
  /** Total spend the plan may incur in a month before the margin target is breached. 25% of price. */
  monthlyCogsUsd: number;
  /** Desktop hours included per month. The rest of the COGS budget goes to the model. */
  computerHoursPerMonth: number;
  /**
   * Minutes of nothing happening after which the desktop is switched off.
   *
   * Not a preference. It is the single number that decides what the product costs to run, and it is
   * why the guidance tells Remii to finish a job in one sitting rather than leaving the machine awake
   * across a pause.
   */
  idleStopMinutes: number;
  /**
   * The longest one stretch of computer time, in minutes.
   *
   * A ceiling rather than a target: a run that is still making progress is not cut off, but nothing
   * can hold a machine open for hours by nudging it, and the meter cannot be surprised by a session
   * that never ends.
   */
  maxSessionMinutes: number;
};

const plan = (
  tier: PlanTier,
  name: string,
  priceUsd: number,
  computerHoursPerMonth: number,
): PlanLimits => {
  const monthlyCogsUsd = priceUsd * 0.25;
  return {
    tier,
    name,
    priceUsd,
    monthlyCogsUsd,
    computerHoursPerMonth,
    idleStopMinutes: DESKTOP_IDLE_STOP_MINUTES,
    maxSessionMinutes: 20,
  };
};

/**
 * The two plans.
 *
 * `pro` is $39 for one computer for two hours a day and a small model budget; `power` is $129 for one
 * computer for eight hours a day and six times the model budget. Neither caps the number of Bots,
 * because a Bot without a computer costs nothing and a limit on them would be a limit on nothing.
 */
export const PLANS: Record<PlanTier, PlanLimits> = {
  pro: plan("pro", "Pro", 39, 30),
  power: plan("power", "Power", 129, 120),
};

/**
 * The model budget for a plan: whatever the computer does not use.
 *
 * Derived rather than stated, so the two cannot disagree. `power` looks like it gets a lot more model
 * than `pro` and that is true — it is also six times the computer, so the margin is the same.
 */
export function modelBudgetUsdFor(limits: PlanLimits): number {
  return Math.max(
    0,
    limits.monthlyCogsUsd - limits.computerHoursPerMonth * COMPUTER_HOUR_USD,
  );
}

/**
 * The 5-hour window, in hours and in dollar terms.
 *
 * A month divided into weeks and then into five-hour blocks, which is the shape the meter is shown
 * against. Expressed as a division rather than a number so a change to the price or the month moves it.
 *
 * Weeks per month is 52/12 and windows per week is 7 × 24 / 5, rather than rounded to 4 and 4, because
 * rounding them is how a plan ends up 8% over its own margin without anybody noticing.
 */
export function weeklyWindowUsdFor(limits: PlanLimits): number {
  return modelBudgetUsdFor(limits) / ((52 / 12) * ((7 * 24) / 5));
}

/** The plan a subscription is on, defaulting to the cheaper one for anyone not on a plan. */
export function limitsFor(tier: string | null | undefined): PlanLimits {
  return PLANS[(tier ?? "") as PlanTier] ?? PLANS.pro;
}
