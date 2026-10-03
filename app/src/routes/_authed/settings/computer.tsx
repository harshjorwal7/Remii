import { IconClock, IconDeviceDesktop } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ComputerView } from "@/components/computer/computer-view";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { REMII_AGENT_ID } from "@/lib/agents/default-agent";
import { PLAN_COMPUTER_HOURS } from "@/lib/billing/types";
import { desktopStateQueryOptions } from "@/lib/computers/queries";

export const Route = createFileRoute("/_authed/settings/computer")({
  component: RouteComponent,
});

/**
 * "12m" and "1h 40m" — an hours figure somebody can plan a day around.
 *
 * A percentage is what the billing page shows, because there the number is abstract. Here the number
 * is the whole allowance and it is worth saying in the unit it is spent in.
 */
function asDuration(hours: number): string {
  const minutes = Math.round(hours * 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** How long ago, in words a person would use. "just now" and "3m ago" rather than a timestamp. */
function since(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Your computer, and what Remii is doing on it.
 *
 * ONE computer, held by Remii — and this page used to be the opposite of that. It listed a computer per
 * Bot, from an endpoint reading a table nothing has written since the per-Bot provisioner was removed,
 * so it drew a row for every coworker with no machine behind it while the one real desktop, in a row
 * the endpoint never read, went unmentioned. Every Bot also showed "asleep", because the page asked
 * the endpoint for a `running` flag the endpoint has never sent.
 *
 * So the list is gone and there is one screen here, the one there is, with the two facts a person
 * opening this page has: is it up, and how much of the month's computer time is left.
 *
 * The screen is mounted only once. `LiveScreen` opens its socket as soon as it mounts and the desktop
 * allows one viewer, so a tile per Bot would open a socket per Bot and evict itself.
 */
function RouteComponent() {
  const state = useQuery(
    // Polled while a start is in flight so the page leaves "Starting…" on its own. A cold boot is up
    // to two minutes of nothing happening, and a page that shows a spinner forever reads as a hang.
    desktopStateQueryOptions({ refetchInterval: 3_000 }),
  );

  const description =
    "Remii's computer. It wakes when Remii needs it and switches itself off four minutes after it stops.";

  if (state.isPending) {
    return (
      <PageShell description={description} title="Computer">
        <PageEmpty>Reading your computer…</PageEmpty>
      </PageShell>
    );
  }

  /*
   * A failed read is NOT "you have no computer". It said the computer could not be asked, which is a
   * different answer from there being none, and rendering an empty state here would report a healthy
   * deployment with no computer on it.
   */
  if (state.isError) {
    return (
      <PageShell description={description} title="Computer">
        <PageEmpty>
          Your computer could not be read. That is a failure to reach it, not an
          absence — try again shortly.
        </PageEmpty>
      </PageShell>
    );
  }

  const row = state.data?.computer ?? null;

  if (!row) {
    return (
      <PageShell
        description={description}
        icon={<IconDeviceDesktop className="size-5" />}
        title="Computer"
      >
        <PageSection>
          <PageEmpty>
            Remii has not needed a computer yet, so there is nothing to watch.
            It is started the first time a piece of work needs a screen, and it
            switches itself off four minutes after that work finishes.
          </PageEmpty>
        </PageSection>
      </PageShell>
    );
  }

  /*
   * THE ALLOWANCE IS THE PLAN'S, AND THE PLAN'S NUMBER IS THE FALLBACK — NOT ZERO.
   *
   * `hoursIncluded` arrived from the server beside `hoursUsed`, so the two were read as a pair and a
   * missing one became `0` through `?? 0`. For a person on Pro that renders "0m of computer time
   * left this month" against thirty paid hours, on the one number on this page somebody plans their
   * day around. It is wrong in the direction that costs them money.
   *
   * Pro is the right fallback because it is the server's own: `limitsForUser` resolves the plan from
   * the database and, if that fails, returns Pro rather than nothing. Falling back here to the same
   * figure the server would have sent means a missing number shows the ordinary plan instead of an
   * alarming zero — and shows the same number in both places, which is the whole point of one plan
   * table.
   */
  const included = state.data?.hoursIncluded ?? PLAN_COMPUTER_HOURS.pro;
  const used = state.data?.hoursUsed ?? 0;
  const left = Math.max(0, included - used);
  const lastSeen = since(row.lastSeenAt);
  const running = row.status === "RUNNING" || row.status === "READY";
  /*
   * STARTING IS A THIRD STATE, and rendering it as "Asleep" is what made this page feel broken.
   *
   * A cold start is a VM boot: the machine can be two minutes away from usable while the row says
   * `STOPPED` the whole time. "Asleep" is a settled, confident, and false answer — it tells the
   * reader their click did nothing and invites them to press Start again. So the transient status
   * gets its own words.
   *
   * `PROVISIONING` is what the provisioner writes the instant a start begins, before the wait, which
   * is the only way this page can know. It is polled rather than pushed, so `refetchInterval` below is
   * what makes the transition visible at all.
   */
  const starting = row.status === "PROVISIONING";

  return (
    <PageShell
      description={description}
      icon={<IconDeviceDesktop className="size-5" />}
      title="Computer"
      width="wide"
    >
      <PageSection>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={`size-2 rounded-full ${
                running
                  ? "bg-emerald-500"
                  : starting
                    ? "animate-pulse bg-amber-500"
                    : "bg-muted-foreground"
              }`}
            />
            {running ? "Awake" : starting ? "Starting…" : "Asleep"}
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <IconClock className="size-3.5" />
            {asDuration(left)} of computer time left this month
          </span>
          {lastSeen ? (
            <span className="text-muted-foreground">Last used {lastSeen}</span>
          ) : null}
          {row.displayWidth && row.displayHeight ? (
            <span className="text-muted-foreground tabular-nums">
              {row.displayWidth}×{row.displayHeight}
            </span>
          ) : null}
        </div>
      </PageSection>

      <PageSection>
        {/*
          Remii's REAL id, with the name Remii goes by. The id is what the badge looks the
          avatar up by, so passing a made-up one drew a blank circle beside a name — and the
          same id is what the per-person control and screen endpoints are addressed by.
        */}
        <ComputerView active computerId={REMII_AGENT_ID} name="Remii" />
      </PageSection>
    </PageShell>
  );
}
