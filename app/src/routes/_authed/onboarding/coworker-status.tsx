import { ActivityMark } from "@/components/channels/activity-mark";
import type { ChannelActivityBrief } from "@/lib/channels/queries";
import { MascotAvatar } from "@/mascot/mascot-avatar";
import { REMII_AGENT_NAME } from "../../../../../shared/remii";
import { aiStateForDemo, COPY, type DemoPhase } from "./demo";

/**
 * The coworker, and what it is doing, above the screen.
 *
 * This is the part of the demo a person remembers, and it is deliberately the only moving thing on the
 * page. The old wizard had three live mascots on the roster step and no face at all on the step that
 * mattered: `onboarding.tsx` passed `animated={false}` and said why, which was a sound reason about
 * three mascots competing with three names for attention — and then applied it to the one screen where
 * somebody decides whether they like the product. The mascot is the product's cast; introducing a
 * product through its cast rather than through its feature list is most of what makes an introduction
 * worth remembering.
 *
 * `aiStateForDemo` decides the face, so the mascot is wearing whatever the run is actually doing rather
 * than whatever the wizard hopes it is doing. A face driven by a script would be the old animation with
 * a face on it.
 */
export function CoworkerStatus({
  activity,
  name,
  phase,
  seed,
}: {
  /** The run brief, polled. What makes the face and the word agree with the server. */
  activity: ChannelActivityBrief | null;
  /** The coworker's name. Defaults to Remii, which is the one that holds the computer. */
  name?: string;
  phase: DemoPhase;
  /** The avatar seed, so the face is this coworker's own and the same one as everywhere else. */
  seed: string;
}) {
  /*
   * `false` FOR `busy`, ALWAYS, and that is not a stub — it is the truth about this screen.
   *
   * `busy` is the socket-only flag that covers a turn the server has not yet reduced to a brief, and it
   * is published by `useChannelEvents`, which is mounted in exactly one place in this app: the sidebar,
   * inside `_app`. The onboarding route is deliberately outside `_app`, so there is no socket here to
   * publish it. Rather than mount a roster subscription a wizard has no roster for, the brief alone
   * answers — and it is the better answer anyway, because it names what is running rather than only that
   * something is.
   */
  const state = aiStateForDemo(phase, activity, false);
  const who = name ?? REMII_AGENT_NAME;

  return (
    <div className="flex w-full max-w-lg flex-col items-center gap-3">
      {/*
       * HERO TIER, AND AT 64px RATHER THAN THE 72 THE WELCOME SCREEN USES.
       *
       * `mascot-avatar.tsx:94` splits the engine's tiers at 20px, 48px and native, and the measurements
       * in `bloub` were taken at the native size — which is why 48px and up is the only tier that should be
       * left alone. It is also why this is bigger than the welcome orb's companion: it is the subject of
       * the screen here rather than decoration above a paragraph, and a mascot at 40px would have been
       * silently downgraded to the enlarged-eye tier, which is a different drawing.
       */}
      <MascotAvatar name={who} seed={seed} size={64} state={state} />

      <p className="sr-only" role="status">
        {who} is{" "}
        {phase === "failed"
          ? "having a problem with the run"
          : activity?.state === "waiting_on_you"
            ? "waiting on you"
            : phase}
        .
      </p>

      {/*
       * THE ACTIVITY MARK, WITH ITS WORD. The one place in the product that shows both, and chosen here
       * because it is the same component the line above a real conversation's composer draws — so the
       * sentence a person reads during onboarding is the sentence they will recognise later, rather than
       * an onboarding-shaped paraphrase of it. `withText` is what the roster row omits and this is what it
       * is for: a roster is scanned, and one row here is waited on.
       */}
      <div className="flex h-5 items-center">
        {activity ? (
          <ActivityMark activity={activity} withText />
        ) : (
          <span className="text-sm text-muted-foreground">
            {standingWord(phase)}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The word for a phase the server has not reduced to a brief.
 *
 * Present because the brief is polled at four seconds and this screen begins before it has ever been
 * asked, and a header with no line under it for the first four seconds of a person's first screen reads
 * as a mistake rather than as a pause. Kept in the past tense for the finished beats — "it worked", not
 * "working" — because a run that is over being described in the present is the specific wrongness this
 * screen exists not to commit.
 */
function standingWord(phase: DemoPhase): string {
  switch (phase) {
    case "preparing":
      return COPY.waking;
    case "needs-you":
      return "It needs you";
    case "settled":
      return "Done";
    case "over-time":
      return "Still working";
    case "failed":
      return "It had a problem";
    case "working":
      return "Working";
  }
}

/**
 * The invitation, under the screen.
 *
 * COPY AND NOTHING ELSE, and the absence of a button here is the decision. `ComputerView` already draws
 * its own — a `Take control` button that is present on every beat rather than appearing when something
 * asks (`computer-view.tsx`, the full-size footer), and a frame that is itself a button for opening the
 * screen full size. Two affordances saying the same thing on one screen teaches a person to hesitate
 * between them, and the one underneath is the real one: it calls the same `takeControl` this wizard
 * would have called, against the same state, on the same desktop.
 *
 * What is added here is the sentence the built-in button has no room for. The button says what you can
 * do; this says that you are allowed to do it at any moment, including while it is mid-run, which is
 * the part that makes the difference between a demo and a thing somebody is being trusted with. It is
 * also the only line on the screen that is addressed to the person rather than about the coworker.
 */
export function HandoffInvitation() {
  return (
    <p className="max-w-sm text-center text-sm text-muted-foreground text-balance">
      {COPY.handoffHint}
    </p>
  );
}
