export type SubscriptionTier = "free" | "starter" | "pro" | "power" | "byok";
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "unpaid";

export type Subscription = {
  id: string;
  userId: string;
  stripeCustomerId: string | null;
  dodoCustomerId: string | null;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  monthlyCreditsIncluded: number;
  byokAddon: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TrialInfo = { active: true; endsAt: string } | { active: false };

export type WindowUsage = {
  used5h: number;
  allowance5h: number;
  pct5h: number;
  used7d: number;
  allowance7d: number;
  pct7d: number;
};

export type BillingDetails = {
  subscription: Subscription;
  creditBalance: number;
  trial: TrialInfo;
  windows: WindowUsage | null;
};

export type CreditLedgerEntry = {
  id: string;
  userId: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  channelId?: string | null;
  createdAt: string;
};

/**
 * What is left of something that was bought, and when it comes back.
 *
 * NO CREDITS, and no balance. A credit is a unit a person cannot see the conversion for, and the
 * conversion is the thing they would want to argue with — so spend is shown as a percentage of what was
 * bought, and the computer as the hours those percentages came from.
 */
export type MeterReading = {
  /** 0–100, floored and clamped, so an overage cannot render as a negative bar. */
  percentRemaining: number;
  /** What was bought. Hours for the computer, dollars for the model. */
  allowance: number;
  /** What has been used, same unit. */
  used: number;
  /**
   * When this reading goes back to full.
   *
   * An absolute instant rather than "in 3 hours", because it is the only form that survives being read
   * by two people in the same conversation and meaning the same thing.
   */
  resetsAt: string;
};

export type Meters = {
  plan: { tier: string; name: string; priceUsd: number; resetsAt: string };
  model: MeterReading;
  computer: MeterReading;
};

export type UsageRecord = {
  id: string;
  userId: string;
  channelId: string;
  agentId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  browserDurationSeconds: number;
  creditsDeducted: number;
  createdAt: string;
};

/** Five-hour free trial, full product, clock starts at signup. */
export const TRIAL_HOURS = 5;

/**
 * The two plans, priced from what one computer hour costs.
 *
 * A desktop at 2 vCPU and 4 GiB runs at $0.1656 an hour on E2B and nothing at all while it is PAUSED,
 * so these numbers are the computer allowance times that rate plus a model budget, sized to leave 75% of
 * the price as margin. (E2B charges the same per-second rates Daytona did, so moving platforms did not
 * move this number — but the SPEC did move, from 1/2 to 2/4, and this copy said otherwise.) They live here as well as in `server/src/billing/plans.ts` because the pricing
 * screen has to render without a round trip, and a plan page that disagrees with what is charged is
 * worse than a slow one — the server's copy is the authority and these are what it says.
 *
 * Both plans include a computer. Neither caps the number of Bots, because a Bot without a computer costs
 * nothing to run and a limit on them would be a limit on nothing.
 */
export const PRO_PLAN = {
  tier: "pro" as const,
  name: "Pro",
  price: "$39",
  period: "/ month",
  description:
    "One computer for your Remii — 2 CPUs, 4 GB — with an hour a day included. Unlimited Bots and channels. Your model allowance resets every 5 hours, with a weekly allowance on top.",
} as const;

export const POWER_PLAN = {
  tier: "power" as const,
  name: "Power",
  price: "$129",
  period: "/ month",
  description:
    "One computer for your Remii — 2 CPUs, 4 GB — with four hours a day included, and six times the model allowance. Everything in Pro, for people running several coworkers.",
} as const;

export const PLANS = [PRO_PLAN, POWER_PLAN] as const;

/**
 * Hours of computer time a plan buys, for the plan card. Matches `plans.ts`.
 *
 * Half what they were before the machine went from 1 vCPU / 2 GiB to 2 vCPU / 4 GiB, because an hour
 * of the larger one costs exactly twice as much. The machine doubled and the hours halved at the same
 * price; the machine is the half worth having.
 */
export const PLAN_COMPUTER_HOURS: Record<string, number> = {
  pro: 30,
  power: 120,
};

/** The spec every person's computer gets. Shown on the plan card so the hours mean something. */
export const PLAN_COMPUTER_SPEC = { vcpu: 2, memoryGb: 4 } as const;

export const BYOK_ADDON = {
  tier: "byok" as const,
  name: "BYOK Add-on",
  price: "$7",
  period: "/ month",
  description:
    "Bring your own model key and pay model spend directly. The add-on covers your computer and workspace.",
} as const;
