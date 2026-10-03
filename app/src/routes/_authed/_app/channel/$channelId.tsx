import { IconDeviceDesktop, IconSettings } from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { hasUnseenActivity } from "@/components/app-sidebar/app-sidebar";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ActivityLog } from "@/components/computer/activity-log";
import { ComputerView } from "@/components/computer/computer-view";
import { useNeedsYou } from "@/components/computer/needs-you";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { markChannelReadMutationOptions } from "@/lib/channels/mutations";
import type { ChannelActivityBrief } from "@/lib/channels/queries";
import {
  type AgentChannel,
  channelListQueryOptions,
  channelQueryOptions,
  channelRunningQueryOptions,
} from "@/lib/channels/queries";
import { onComputerActivity } from "@/lib/copilot/computer-activity";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

const chatSearchSchema = z.object({
  settings: z.boolean().optional(),
  /** Opens the Bot's screen in the shared detail pane. */
  watch: z.boolean().optional(),
});

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const HEADING_ENTRANCE_SECONDS = 0.18;
const HEADING_ENTRANCE_OFFSET = "translateY(4px)";

/** Shared detail pane width for the live screen view. */
const SCREEN_PANEL_WIDTH = 400;

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  validateSearch: chatSearchSchema,
  component: RouteComponent,
});

/**
 * What the Bot is looking at, and what it is doing.
 *
 * Two surfaces, stacked rather than tabbed. The screen was the only window into a Bot's computer,
 * so a Bot that spent two minutes in a terminal showed a blank browser and nothing else: the honest
 * answer to "what is it doing" was "something, on a machine holding your logins". The activity —
 * the shell and the workspace — sits below the screen, so watching one never costs the other and
 * nothing about what the Bot is doing hides behind a tab nobody clicked.
 */
function ComputerViewPanel({
  agentId,
  name,
  running,
}: {
  agentId: string;
  name?: string;
  /**
   * Whether a run is going in this conversation, which is what decides live stream versus still.
   *
   * Passed in rather than derived here because this component is deliberately ignorant: the route already
   * holds the roster's `activity` for the channel and the running-query answer, and re-deciding "is the
   * Bot working" inside the panel would be a second rule for a question that already has one.
   */
  running: boolean;
}) {
  return (
    <div className="mt-4 px-4">
      <div className="p-4">
        {/*
         * THE SMALL SCREEN, AND WHY IT WAS FROZEN.
         *
         * `active` alone says "keep this surface alive", which is not the same as "the Bot is working" —
         * and reading it as the latter is why this panel sat on one picture for as long as it was open. It
         * had no `toolCallId`, so it was never `settled`, so the only thing deciding what to draw was
         * whether a still frame had arrived: nothing at all until one did, and then that same still
         * indefinitely. A panel whose job is to show what the Bot is doing was sampling a JPEG of a shared
         * desktop once a second and calling it a live view.
         *
         * `followingRun` makes it what it should have been — the live stream, over RFB, attached to the
         * desktop while the Bot drives it, falling back to the still when nothing is running. That is the
         * same surface the full-size view and Take control use, so what the panel shows and what a person
         * can drive are now the same thing rather than two pictures of it.
         *
         * `active` IS DELIBERATELY ABSENT, and that is the other half of the fix. It was doing two
         * unrelated jobs here: keeping the control poll alive — which this panel genuinely needs, because
         * a Bot that falls asleep between turns must still be noticed asking for a credential — and
         * keeping the SCREENSHOT poll alive, which is a full-resolution capture of a shared machine once
         * a second for as long as a person watches an idle conversation, on hardware billed by the hour
         * it is switched on.
         *
         * The control poll is gated on `settled`, which is false here for as long as the panel is open,
         * so dropping `active` costs the prompt detection nothing. The screenshot poll gets one frame
         * and stops, and everything that actually moves comes from the stream instead.
         */}
        <ComputerView computerId={agentId} followingRun={running} name={name} />

        <div className="mt-10">
          <h3 className="mb-2 font-medium text-sm">Activity</h3>
          <ActivityLog computerId={agentId} />
        </div>
      </div>
    </div>
  );
}

/**
 * Where the watch-screen button lands while this deployment has no computer.
 *
 * The button stays where it is so the surface does not rearrange itself around a capability;
 * what changes is the destination. One panel, plain words, no illustration to maintain: the
 * screen it would have shown does not exist, and saying when it comes back beats drawing it.
 */
function ComputerComingSoon() {
  return (
    <div className="mt-4 px-4">
      <div className="p-4">
        <h3 className="font-medium text-sm">Computer screen — coming soon</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Live browser control is parked while Remii works on your own computer
          instead. Ask Remii to point at things on your screen, or check
          Settings → Voice &amp; Screen to see what is connected.
        </p>
      </div>
    </div>
  );
}

function RouteComponent() {
  const { channelId } = Route.useParams();
  const { settings, watch } = Route.useSearch();
  const channel = useQuery(channelQueryOptions(channelId));
  /*
   * The same roster row the sidebar draws, so the line above the composer and the mark on the row
   * can never disagree. Read from the roster cache rather than fetched: the roster is already loaded
   * and already patched by the socket, and a second request for one field of a row that is on screen
   * would be a second answer to a question with only one right answer.
   */

  const navigate = Route.useNavigate();
  const isSettingsOpen = settings === true;
  const prefersReducedMotion = useReducedMotion();
  const isWatching = watch === true;
  /** Channel routing currently supports one coworker. */
  const agentId = channel.data?.agentIds[0];
  /** Absent while capabilities load reads as no computer: the screen it would open does not exist. */
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const computerOn = capabilities?.computer === true;
  /** Only polled while the screen is closed; the screen panel polls control itself. */
  const needsYou = useNeedsYou(agentId, !isWatching && computerOn);

  const queryClient = useQueryClient();
  const markRead = useMutation(markChannelReadMutationOptions(queryClient));
  /*
   * This channel's roster summary, read out of the same infinite query the sidebar renders.
   * The detail query deliberately knows nothing about activity; the roster is where the socket
   * keeps lastMessageAt live, so it is the one honest source for "has something new been said".
   */
  const roster = useInfiniteQuery(channelListQueryOptions());
  const summary = roster.data?.find((row) => row.id === channelId);
  /*
   * The line above the composer, read from the same row the sidebar draws its mark from — one
   * answer, patched by one socket event, so the two cannot disagree about what is running.
   */
  const activity = summary?.activity ?? null;

  /*
   * IS SOMETHING ACTUALLY HAPPENING IN THIS CONVERSATION, polled rather than taken from the roster.
   *
   * `activity` above is the socket's answer, which is the right one for a surface that has been open the
   * whole time and the wrong one here: the socket only carries events as they happen, so a person who
   * started a run, went away and came back finds a roster that never saw it and says nothing is running.
   * The screen panel then draws a still frame from whenever it last polled, which is the "stuck on one
   * computer frame" symptom — and, in the conversation itself, a composer with no Stop button.
   *
   * The two are OR-ed rather than the poll replacing the roster: the roster is patched the instant a run
   * starts, so it is strictly better while it is keeping up, and the poll covers only the case it cannot
   * see. Either alone is wrong in a different direction — the roster alone misses runs from before this
   * mount, and the poll alone would be up to an interval late for everything.
   */
  const { data: polledRun } = useQuery(channelRunningQueryOptions(channelId));
  /*
   * `busy` is the roster's socket flag, held true for as long as a turn is in flight here — which,
   * unlike the persisted `activity` and the polled run, does NOT flicker off when a turn ends at a
   * browser-executed computer tool and the browser starts the next one carrying the result. That is
   * exactly the window in which the screen would otherwise fall back to a settled still, frozen for
   * the life of each computer action. It is transient and refetch-cleared, so OR-ing it in can only
   * over-claim by one refetch; the other two still answer for a conversation opened mid-turn.
   */
  const isRunLive =
    Boolean(activity) || Boolean(polledRun) || Boolean(summary?.busy);

  /*
   * Opening the channel marks it read; the Bot replying while it is open marks it read again.
   * One effect covers both: the dep changes on navigation and on every activity patch, and the
   * unseen check keeps it from writing a row per render. No dependency on the mutation object —
   * its identity changes per render and the effect must not re-fire for that.
   *
   * Keyed on primitives, deliberately. The optimistic mark-read patch changes the summary OBJECT's
   * identity without changing these values, so an object dep would re-fire the effect on its own
   * write — and when lastMessageAt sits ahead of this browser's clock (another device wrote it),
   * that re-fire loops into a PUT per render. Primitives hold still under the patch: one PUT.
   */
  const unseen = summary !== undefined && hasUnseenActivity(summary);
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (unseen) {
      markReadMutate(channelId);
    }
  }, [channelId, unseen, markReadMutate]);

  /*
   * Dismissal state for the auto-open, declared before the effect that reads it.
   *
   * The browser-activity effect below already has a rule for "do not reopen what this person
   * dismissed": it records the epoch it was told about and skips any event for the same one. A
   * needs-you prompt is the same question asked by a different signal, and it needs the same
   * answer.
   */
  const dismissedEpoch = useRef<number | null>(null);
  const runEpoch = useRef<number | null>(null);
  // Browser activity may auto-open the screen once per run unless this run was dismissed.
  useEffect(() => {
    if (!agentId) return;
    return onComputerActivity((activity) => {
      if (activity.botId !== agentId) return;
      runEpoch.current = activity.epoch;
      if (dismissedEpoch.current === activity.epoch) return;
      navigate({
        search: (previous) =>
          previous.watch === true || previous.settings === true
            ? previous
            : { ...previous, settings: undefined, watch: true },
      });
    });
  }, [agentId, navigate]);

  /*
   * Whether the person has closed the panel during the CURRENT needs-you episode.
   *
   * An episode, rather than a boolean, because the answer has to expire: a Bot that asks, is
   * dismissed, and then asks again minutes later is a new request and should open the panel. So
   * the flag is cleared as soon as the Bot stops needing anything, which is what makes the next
   * request a fresh one.
   */
  const dismissedForNeed = useRef(false);

  // Settings and watch share one pane; opening either clears the other URL flag.
  const show = (next: "settings" | "watch" | null) => {
    // Dismissal applies only to the current browser-activity run.
    if (next !== "watch" && isWatching)
      dismissedEpoch.current = runEpoch.current;
    /*
     * AND TO THE CURRENT NEEDS-YOU EPISODE, so closing the panel is a decision the auto-open
     * respects rather than one it undoes a moment later. Recorded here rather than in the close
     * handler so that every route to a closed panel — the ✕, the toolbar button, a navigation that
     * drops the URL flag — is the same decision.
     */
    if (next !== "watch" && needsYou) dismissedForNeed.current = true;
    return navigate({
      search: (previous) => ({
        ...previous,
        settings: next === "settings" ? true : undefined,
        watch: next === "watch" ? true : undefined,
      }),
    });
  };

  /*
   * Needs-you prompts auto-open the screen panel, because the prompt with the reason on it — the
   * amber "the assistant needs you" row, and the masked field for a credential — is drawn on the
   * screen card in that panel. Nothing about a stuck Bot is actionable until this pane is open.
   *
   * IT USED TO HAVE NO DEPENDENCY ARRAY, which made the close button inert. `needsYou` is polled
   * only while the panel is CLOSED, so the sequence was: prompt arrives, panel opens, polling stops
   * and the flag clears; the person closes the panel, polling resumes, the flag comes straight back,
   * and an effect that runs after every render reopened what they had just closed. There was no way
   * to keep it shut while a Bot waited.
   *
   * So dismissal is honoured, and the episode is tracked, and the effect depends on the two values
   * it actually reads rather than on every render in the channel.
   */
  useEffect(() => {
    // The Bot stopped needing anything: the next request is a new one and may open the panel again.
    if (!needsYou) dismissedForNeed.current = false;
  }, [needsYou]);

  const showRef = useRef(show);
  showRef.current = show;
  useEffect(() => {
    if (!needsYou || dismissedForNeed.current) return;
    void showRef.current("watch");
  }, [needsYou]);

  return (
    <DetailPanel
      onClose={() => show(null)}
      open={(isSettingsOpen || isWatching) && agentId !== undefined}
      detailWidth={isWatching ? SCREEN_PANEL_WIDTH : undefined}
      detail={
        agentId === undefined ? null : isWatching ? (
          computerOn ? (
            // Manual watch remains active even when there is no current browser action.
            <ComputerViewPanel
              agentId={agentId}
              name={channel?.data?.name}
              running={isRunLive}
            />
          ) : (
            <ComputerComingSoon />
          )
        ) : (
          <AgentProfile agentId={agentId} />
        )
      }
    >
      <div className="flex flex-col">
        <div className="h-12 border-b border-border sticky top-0 flex flex-row items-center justify-between px-3 gap-2">
          {/* Keyed on the displayed name so cold channel loads animate the resolved name, not the id. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <SidebarToggle />
            <motion.div
              animate={{ opacity: 1 }}
              className="shrink-0"
              initial={{ opacity: 0 }}
              key={`avatar:${channel.data?.name ?? channelId}`}
              transition={{
                duration: HEADING_ENTRANCE_SECONDS,
                ease: EASE_OUT,
              }}
            >
              <ChannelAvatar
                participantIds={channel.data?.agentIds ?? []}
                mascots={channel.data?.mascots}
                size={22}
              />
            </motion.div>
            <motion.span
              animate={
                prefersReducedMotion
                  ? { opacity: 1 }
                  : { opacity: 1, transform: "translateY(0px)" }
              }
              className="min-w-0 text-sm tracking-tight truncate"
              initial={
                prefersReducedMotion
                  ? { opacity: 0 }
                  : { opacity: 0, transform: HEADING_ENTRANCE_OFFSET }
              }
              key={`name:${channel.data?.name ?? channelId}`}
              transition={{
                duration: HEADING_ENTRANCE_SECONDS,
                ease: EASE_OUT,
              }}
            >
              {channel.data?.name ?? "Channel"}
            </motion.span>
          </div>
          <div className="flex flex-row gap-1.5">
            <Button
              aria-label={
                computerOn
                  ? needsYou
                    ? "This Bot is waiting for you. Open its screen"
                    : "Watch this Bot's screen"
                  : "Computer screen — coming soon"
              }
              aria-pressed={isWatching}
              className={`relative ${isWatching ? "bg-foreground/5" : ""}`}
              disabled={agentId === undefined}
              onClick={() => show(isWatching ? null : "watch")}
              variant="ghost"
              size="icon"
            >
              <IconDeviceDesktop />
              {/* Mirrors needs-you state outside the hidden screen pane. */}
              {needsYou ? (
                <span className="absolute right-1 top-1 size-2 rounded-full bg-amber-500" />
              ) : null}
            </Button>
            <Button
              aria-label="Channel coworker"
              aria-pressed={isSettingsOpen}
              className={isSettingsOpen ? "bg-foreground/5" : undefined}
              disabled={agentId === undefined}
              onClick={() => show(isSettingsOpen ? null : "settings")}
              variant="ghost"
              size="icon"
            >
              <IconSettings />
            </Button>
          </div>
        </div>
      </div>
      <ChannelBody
        activity={activity ?? null}
        channel={channel.data}
        isPending={channel.isPending}
        hasError={Boolean(channel.error)}
      />
    </DetailPanel>
  );
}

/**
 * A channel holds exactly one coworker. More than one is not supported yet, and rendering a shared
 * transcript for several agents before the runtime can route between them would look like it works.
 */
function ChannelBody({
  activity,
  channel,
  isPending,
  hasError,
}: {
  activity: ChannelActivityBrief | null;
  channel: AgentChannel | undefined;
  isPending: boolean;
  hasError: boolean;
}) {
  // Nothing while the channel loads: a placeholder inside a local round-trip is a flicker.
  if (isPending) return null;
  if (hasError || !channel) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        Could not load this channel.
      </p>
    );
  }

  const runtimeAgentId =
    channel.agentIds.length === 1 ? channel.agentIds[0] : undefined;
  if (!runtimeAgentId) {
    /*
     * TWO DIFFERENT NOTHINGS, AND THIS PAGE SHOWED NEITHER.
     *
     * A channel with no coworker at all is what is left behind when one is removed: the row naming
     * it can outlive the agent, and the channel stays in the roster. It used to be reported here as
     * "more than one coworker", which is the wrong sentence for the only case that was actually
     * reachable, and when the stale id did resolve to exactly one entry the guard passed and the
     * chat below rendered with no agent behind it — a blank page with no composer and nothing to say
     * why.
     *
     * So the two are separated, and each says what happened. A channel with no coworker names the
     * fix, which is a real one the person can take.
     */
    if (channel.agentIds.length === 0) {
      return (
        <p className="p-8 text-sm text-muted-foreground" role="status">
          This conversation belongs to a coworker that is no longer on the
          workspace. Delete the channel from the sidebar, or hire the coworker
          again and start a new conversation.
        </p>
      );
    }
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This channel has more than one coworker, which is not supported yet.
      </p>
    );
  }

  // Remount on channel changes so CopilotKit agent/thread state cannot leak between channels.
  return (
    <ChannelChat
      activity={activity ?? null}
      channel={channel}
      key={channel.id}
      runtimeAgentId={runtimeAgentId}
    />
  );
}
