import type { AIState } from "@/components/agents/orb/ai-core";
import type { ChannelActivityBrief } from "@/lib/channels/queries";

/**
 * What a run's state looks like, in one place, for every surface that draws one.
 *
 * The roster row and the line above the composer both answer "is this Bot working, waiting on me, or
 * broken", and if they answer it separately they will disagree within a release. One table, one
 * component, and a state that is not in the table falls back to showing nothing rather than to
 * something invented.
 *
 * The order of {@link ACTIVITY_LOOK} is the severity ladder the server ranks by, highest first. It
 * is a judgement about what a person is looking for: a run blocked on their answer outranks one
 * that broke, because the answer is the only thing that unblocks it.
 */
type Look = {
  /** The word beside the mark. Short enough for a roster row. */
  text: (activity: ChannelActivityBrief) => string;
  /** A pulse, for a run that is moving by itself. */
  pulse: boolean;
  /** The mark's colour, as a class, so it themes with everything else. */
  className: string;
  /** What a screen reader is told. Never the bare word. */
  announce: (activity: ChannelActivityBrief) => string;
  /**
   * Draw nothing.
   *
   * Set on the fallback as well as on `done`, which is what makes a state this build has never heard
   * of degrade to nothing rather than to an alarm. A server ahead of the browser is the normal
   * cause — a newer replica announcing a state an older tab has no row for — and inventing a mark
   * for it would put a false indicator on a roster because the two were built on different days.
   */
  hidden: boolean;
};

const BY_STATE: Record<ChannelActivityBrief["state"], Look> = {
  /*
   * Needs a person. The only state where the run is not going to move and the reader is the thing
   * that has to move it, so it is the only one drawn in the foreground colour rather than muted.
   */
  waiting_on_you: {
    text: () => "Waiting on you",
    pulse: false,
    className: "bg-primary",
    announce: (a) => `Waiting on you${a.label ? `: ${a.label}` : ""}`,
    hidden: false,
  },

  /*
   * Broken. Not attention in the sense of waiting, but the only other state a person has to do
   * something about, and it is shown in the destructive colour because it did not finish.
   */
  failed: {
    text: () => "Failed",
    pulse: false,
    className: "bg-destructive",
    announce: (a) => `Failed${a.detail ? `: ${a.detail}` : ""}`,
    hidden: false,
  },

  /*
   * Working. The only pulsing state, and the pulse is what says "this will change without you".
   */
  thinking: {
    text: (a) => a.label ?? "Working",
    pulse: true,
    className: "bg-primary",
    announce: (a) => `Working${a.label ? `: ${a.label}` : ""}`,
    hidden: false,
  },

  /*
   * Waiting on a coworker. Calm on purpose: this is the ordinary state of a supervisor, and drawing
   * it like an alarm would make every delegation look like a problem.
   */
  delegated: {
    text: (a) => a.label ?? "With a coworker",
    pulse: false,
    className: "bg-muted-foreground/60",
    announce: (a) =>
      a.label ? `Delegated: ${a.label}` : "Delegated to a coworker",
    hidden: false,
  },

  /*
   * Stopped on purpose. Nobody asked, so it is a fact about a run rather than a problem, and it is
   * the quietest mark there is.
   */
  stopped: {
    text: () => "Stopped",
    pulse: false,
    className: "bg-muted-foreground/40",
    announce: () => "Stopped",
    hidden: false,
  },

  /*
   * A run that ended. A roster should not draw it — a finished run is the absence of activity — but
   * the state exists in the table so that a row which somehow carries one degrades to nothing
   * instead of to an alarm.
   */
  done: {
    text: () => "",
    pulse: false,
    className: "bg-muted-foreground/30",
    announce: () => "Finished",
    hidden: true,
  },
};

/** Exported for tests and for the status line, which needs the same word the roster uses. */
export function readActivityLook(activity: ChannelActivityBrief): Look {
  return BY_STATE[activity.state] ?? BY_STATE.done;
}

/**
 * The same run, as the product-wide work state every AI surface speaks.
 *
 * `ai-core.tsx` defines six states and asks each surface to express one in its own material, and this
 * table is the join between the server's six run states and those six. It lives next to `BY_STATE`
 * rather than in the mascot because both are the same question asked twice — what is this Bot doing —
 * and a state that meant one thing to the roster and another to the avatar would be a bug nobody
 * would look for.
 *
 * Two mappings are not one-to-one and both are deliberate:
 *
 * - `waiting_on_you` is `listening`, not `thinking`. A run blocked on a person's answer is not working,
 *   it is waiting to be spoken to, and `listening` is the state that reads that way.
 * - `delegated` is `thinking`. The run is still alive and has simply handed the work to a coworker, and
 *   there is no state for "handed off"; inventing one would show a person a sixth thing the rest of the
 *   product has never heard of.
 *
 * `stopped` is `idle` because the activity brief keeps a stopped run around to explain itself, and an
 * avatar winding down for a run nobody stopped would be the mascot disagreeing with reality. `done` is
 * `done` and lasts as long as the brief does, which is the same lifetime `ActivityMark` gives it — the
 * two say the same thing, and neither invents a state the other lacks.
 */
const AI_STATE_FOR_RUN: Record<ChannelActivityBrief["state"], AIState> = {
  thinking: "thinking",
  delegated: "thinking",
  waiting_on_you: "listening",
  stopped: "idle",
  failed: "error",
  done: "done",
};

/**
 * The work state a channel's avatar should wear, or `idle` when nothing is running.
 *
 * A total function over the two things a row knows: the brief, which names what is running, and
 * `busy`, which is the socket-only flag that covers a turn the server has not reduced to a brief yet.
 * A brief outranks `busy` — it is the more specific answer — and `busy` with no brief is a turn whose
 * shape this tab has not been told, which is as close to "working" as it can honestly get.
 */
export function aiStateForChannel(
  activity: ChannelActivityBrief | null | undefined,
  busy: boolean,
): AIState {
  if (activity) return AI_STATE_FOR_RUN[activity.state] ?? "idle";
  return busy ? "thinking" : "idle";
}

/**
 * A run's mark: a dot, and optionally a word.
 *
 * `withText` is for the line above the composer, where there is room and the reader is waiting for
 * an answer. The roster row passes nothing, because a roster is scanned and a word on every row
 * turns a list into a column of sentences.
 *
 * `className` on the wrapper is how the status line centres and pads itself; the mark itself is
 * laid out by the caller's flex row.
 */
export function ActivityMark({
  activity,
  withText = false,
}: {
  activity: ChannelActivityBrief;
  withText?: boolean;
}) {
  const look = readActivityLook(activity);
  if (look.hidden) return null;

  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
      title={look.announce(activity)}
    >
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${look.className}${
          look.pulse ? " motion-safe:animate-pulse" : ""
        }`}
      />
      {withText ? (
        <span className="truncate">
          <span className="sr-only">{look.announce(activity)}</span>
          <span aria-hidden>{look.text(activity)}</span>
        </span>
      ) : null}
    </span>
  );
}
