import { IconCheck, IconClock, IconKey } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  checkoutMutationOptions,
  portalMutationOptions,
} from "@/lib/billing/mutations";
import { billingQueryOptions, metersQueryOptions } from "@/lib/billing/queries";
import {
  BYOK_ADDON,
  type MeterReading,
  PLAN_COMPUTER_HOURS,
  PLAN_COMPUTER_SPEC,
  PLANS,
  POWER_PLAN,
  PRO_PLAN,
} from "@/lib/billing/types";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/billing")({
  component: BillingPage,
});

/**
 * "in 3h 12m" rather than a clock time, and not a bare date either.
 *
 * A person's next reset is the only thing on this page they are likely to act on, and "resets at
 * 14:00" is useless to somebody reading this at 21:00 in their own timezone. So the distance is the
 * primary form, with the instant underneath for when the two disagree — which is exactly the case where
 * the distance is worth checking.
 */
function untilResets(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** "1h 20m" — an hours figure a person can plan a work session around. */
function asDuration(hours: number): string {
  const total = Math.round(hours * 60);
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

/**
 * One meter, as a bar and the two numbers that matter.
 *
 * PERCENTAGE REMAINING, not percentage used. The question a person opens this page with is "how much is
 * left", and a bar that fills as you spend invites them to read it as a cost so far — which is the
 * opposite of the reassurance it should give at 40% left.
 *
 * The bar is deliberately not red. Turning the interface into a warning as somebody approaches their
 * allowance teaches them that the product is punishing them for working, and the thing they should be
 * reading instead is the reset time.
 */
function Meter({
  title,
  reading,
  /** What "used" means in this meter's own unit, which is not a percentage. */
  detail,
}: {
  title: string;
  reading: MeterReading | null;
  detail: string;
}) {
  const percent = reading?.percentRemaining ?? 0;
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {title}
        </span>
        <span className="text-2xl font-bold tabular-nums tracking-tight">
          {percent}%
        </span>
      </div>
      <div
        className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={`${title}: ${percent}% remaining`}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            // The warning fill is a solid block, so unlike a tinted chip it has no
            // `dark:` text to rescue: at 500 it glows on a dark surface. 400 is the
            // readable equivalent there, and it is the same token at the same weight.
            percent <= 15 ? "bg-amber-500 dark:bg-amber-400" : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">{detail}</p>
      {reading && (
        <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <IconClock className="size-3" />
          Resets {untilResets(reading.resetsAt)}
        </p>
      )}
    </div>
  );
}

function PlanCard({
  name,
  price,
  period,
  description,
  hours,
  vcpu,
  memoryGb,
  current,
  pending,
  onUpgrade,
}: {
  name: string;
  price: string;
  period: string;
  description: string;
  hours: number;
  vcpu: number;
  memoryGb: number;
  current: boolean;
  pending: boolean;
  onUpgrade: () => void;
}) {
  return (
    <div
      className={cn(
        "relative flex flex-col justify-between rounded-xl border p-5",
        current
          ? "border-primary bg-primary/[0.03] ring-1 ring-primary/20"
          : "border-border bg-card",
      )}
    >
      {current && (
        <span className="absolute -top-2.5 right-4 rounded-full bg-foreground px-2 py-0.5 text-[10px] font-semibold tracking-wider text-background uppercase">
          Current
        </span>
      )}
      <div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-base font-semibold">{name}</span>
          <span className="text-2xl font-bold tracking-tight">{price}</span>
          <span className="text-xs text-muted-foreground">{period}</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
        <p className="mt-2 text-[11px] font-medium text-muted-foreground">
          {vcpu} CPUs, {memoryGb} GB memory · {hours} hours of computer time a
          month
        </p>
      </div>
      <div className="mt-6 flex gap-2">
        {!current && (
          <Button
            className="flex-1"
            disabled={pending}
            onClick={onUpgrade}
            size="sm"
          >
            {pending ? "Opening checkout..." : `Choose ${name}`}
          </Button>
        )}
      </div>
    </div>
  );
}

function BillingPage() {
  const {
    data: billing,
    isPending: loading,
    isError: billingFailed,
  } = useQuery(billingQueryOptions());
  /*
   * The meters are a SEPARATE query from the subscription.
   *
   * They move while somebody is watching them, and folding them into the subscription read would mean
   * re-fetching the plan — and re-running its checkout-eligibility work — every time the number changed.
   * Two reads, each about one thing, and a failure in either is visible as its own state.
   */
  const meters = useQuery(metersQueryOptions());
  const checkout = useMutation(checkoutMutationOptions(queryClient));
  const portal = useMutation(portalMutationOptions());

  const tier = billing?.subscription?.tier ?? "free";
  const hasByok = billing?.subscription?.byokAddon === true || tier === "byok";
  const onPlan = tier === "pro" || tier === "power";

  return (
    <PageShell
      description="One computer for your Remii, as many Bots and channels as you like."
      title="Billing"
      width="wide"
    >
      {loading ? (
        <Skeleton className="mt-4 h-[320px] w-full rounded-xl" />
      ) : billingFailed && billing === undefined ? (
        /*
         * A FAILED READ MUST NOT BECOME "YOU ARE ON THE FREE PLAN".
         *
         * `loading` goes false on failure and `billing` is then undefined, so this page used to render
         * as a free account — an upgrade button, offered to the paying customer whose own request had
         * just failed, alongside usage figures that were invented rather than wrong.
         *
         * So a failure is its own state, and it offers nothing. `undefined` is what separates "we could
         * not ask" from "we asked and they are on free".
         */
        <p className="text-muted-foreground mt-4 text-sm" role="alert">
          Your billing details could not be loaded, so this page cannot show
          your plan. Nothing has been changed. Reload to try again.
        </p>
      ) : (
        <>
          <PageSection
            description="What is left of what you bought, and when each part refills. Your Bots and channels are never counted."
            title="Usage"
          >
            {meters.data ? (
              <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Meter
                  detail={`${meters.data.plan.name} · resets every 5 hours, with a weekly allowance on top`}
                  reading={meters.data.model}
                  title="Model allowance"
                />
                <Meter
                  detail={`${asDuration(meters.data.computer.used)} of ${asDuration(meters.data.computer.allowance)} used this month`}
                  reading={meters.data.computer}
                  title="Computer time"
                />
              </div>
            ) : meters.isError ? (
              <p className="text-muted-foreground mt-4 text-sm" role="alert">
                Your usage could not be read just now. Your plan is unchanged
                and nothing has been spent — this is only the display.
              </p>
            ) : (
              <Skeleton className="mt-4 h-[104px] w-full rounded-xl" />
            )}
            {meters.data && meters.data.computer.percentRemaining <= 15 && (
              <p className="text-muted-foreground mt-3 text-xs">
                Your computer is switched off automatically after 4 minutes of
                inactivity, and comes back on its own when you need it.
              </p>
            )}
          </PageSection>

          <PageSection
            description="Both plans include a computer. Neither limits how many Bots you make."
            title="Plans"
          >
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <PlanCard
                current={tier === "pro"}
                description={PRO_PLAN.description}
                hours={PLAN_COMPUTER_HOURS.pro ?? 30}
                memoryGb={PLAN_COMPUTER_SPEC.memoryGb}
                vcpu={PLAN_COMPUTER_SPEC.vcpu}
                name={PRO_PLAN.name}
                onUpgrade={() => checkout.mutate({ tier: "pro" })}
                pending={checkout.isPending}
                period={PRO_PLAN.period}
                price={PRO_PLAN.price}
              />
              <PlanCard
                current={tier === "power"}
                description={POWER_PLAN.description}
                hours={PLAN_COMPUTER_HOURS.power ?? 120}
                memoryGb={PLAN_COMPUTER_SPEC.memoryGb}
                vcpu={PLAN_COMPUTER_SPEC.vcpu}
                name={POWER_PLAN.name}
                onUpgrade={() => checkout.mutate({ tier: "power" })}
                pending={checkout.isPending}
                period={POWER_PLAN.period}
                price={POWER_PLAN.price}
              />
            </div>

            <div className="mt-4 flex flex-col gap-4 rounded-xl border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <IconKey className="size-4 text-muted-foreground" />
                <span className="text-base font-semibold">
                  {BYOK_ADDON.name}
                </span>
                <span className="text-sm font-bold">{BYOK_ADDON.price}</span>
                <span className="text-xs text-muted-foreground">
                  {BYOK_ADDON.period}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {BYOK_ADDON.description}
              </p>
              {hasByok ? (
                <p className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-500">
                  <IconCheck className="size-3.5" /> Active
                </p>
              ) : (
                <Button
                  disabled={checkout.isPending}
                  onClick={() => checkout.mutate({ tier: "byok" })}
                  size="sm"
                  variant="outline"
                >
                  {checkout.isPending ? "Opening checkout..." : "Add BYOK"}
                </Button>
              )}
            </div>

            {onPlan && (
              <div className="mt-4">
                <Button
                  disabled={portal.isPending}
                  onClick={() => portal.mutate()}
                  size="sm"
                  variant="outline"
                >
                  {portal.isPending ? "Opening..." : "Manage subscription"}
                </Button>
              </div>
            )}
          </PageSection>

          <p className="text-muted-foreground mt-6 text-xs">
            {PLANS.length} plans. Both include one computer for Remii; a Bot
            without a computer does the rest through your connected apps, and
            asks Remii when a job needs a screen.
          </p>
        </>
      )}
    </PageShell>
  );
}
