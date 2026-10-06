import { IconCheck, IconCopy, IconRefresh } from "@tabler/icons-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as React from "react";
import { Streamdown } from "streamdown";
import { ComputerView } from "@/components/computer/computer-view";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import type {
  AgentChannel,
  ChannelActivityBrief,
} from "@/lib/channels/queries";
import { capMarkdown, markdownComponents } from "@/lib/markdown";
import { REMII_AGENT_ID, REMII_AGENT_NAME } from "../../../../../shared/remii";
import { CoworkerStatus, HandoffInvitation } from "./coworker-status";
import { COPY, type DemoAvailability, type DemoPhase } from "./demo";
import { DemoTurn, type DemoRunReport } from "./demo-run";
import {
  HOLD_MS,
  nextStoryBeat,
  PHASE_FOR_BEAT,
  STORY_BEATS,
  STORY_FINAL_BEAT,
  type StoryBeat,
} from "./story-beats";
import { StoryDesktop } from "./story-desktop";

export { PHASE_FOR_BEAT };

/**
 * The story's clock, and the reason it lives here rather than in the drawing.
 *
 * `motion/react` binds its reduced-motion query when the module is evaluated and bun runs every test file
 * in one process, so a drawing that decided its own starting beat from `useReducedMotion` could not be
 * tested except alone — its test passed on its own and failed in the suite for reasons that had nothing to
 * do with the code. Keeping the clock beside the screen makes `StoryDesktop` a pure function of a beat,
 * which is testable beat by beat and re-enterable, which is what `restart` below is for.
 *
 * THE STARTING BEAT FOR REDUCED MOTION IS THE LAST ONE, and it is not a compromise between two bad
 * options. A person who has asked for less motion and is shown a frozen pointer in the corner of an empty
 * desktop has been shown a broken thing; the picture that answers the question they actually asked — "what
 * does this do" — is the resolved one, where the answer is on the screen and the cursor has gone home.
 */
function useStoryClock(running: boolean) {
  const reduced = useReducedMotion();
  const [beat, setBeat] = React.useState<StoryBeat>(
    reduced ? STORY_FINAL_BEAT : STORY_BEATS[0],
  );
  /*
   * THE REPLAY IS JUST A SET-BACK-TO-THE-FIRST-BEAT, and that is enough.
   *
   * `restart` is only ever offered on the final beat, so `handed-back` → `rest` is a real change of state:
   * React re-renders, the timer effect below re-runs because `beat` is in its dependencies, and the story
   * begins again. No nonce, no force-update and no suppressed lint rule — the button's own precondition is
   * what makes the reset work, and a person cannot press it at any moment where the state would already be
   * where they asked it to go.
   */
  const restart = React.useCallback(() => setBeat(STORY_BEATS[0]), []);

  React.useEffect(() => {
    if (!running || reduced) return;
    const next = nextStoryBeat(beat);
    if (next === null) return;
    const timer = setTimeout(() => setBeat(next), HOLD_MS[beat]);
    return () => clearTimeout(timer);
  }, [beat, reduced, running]);

  return { beat, restart };
}

/**
 * The screen the product is actually introduced on.
 *
 * Both paths render the same layout, the same frame, the same status line and the same invitation, and
 * they differ only in what is inside the frame. That is the whole design constraint here, and it is
 * stricter than it sounds: a person on a deployment with no E2B key and a person on one with a working
 * sandbox should have no way to tell which they are on. Anything that branched visibly — a greyed-out
 * live badge, a smaller drawn screen, a note apologising for the missing machine — would tell one of
 * them they have the lesser product, and for some of them it is the only product there will ever be.
 *
 * So the drawn path is not a fallback with a label. It is the same screen, told with a picture.
 */
export function DemoScreen({
  activity,
  availability,
  channel,
  onBeat,
  onReport,
  phase,
  reply,
  session,
  seed,
}: {
  /** The run brief, polled. What makes the face and the word agree with the server. */
  activity: ChannelActivityBrief | null;
  /**
   * Whether there is a real computer behind this, or a drawing of one.
   *
   * DECIDED HERE RATHER THAN INFERRED FROM `channel`.
   *
   * `channel === null` reads as "drawn" only by accident: it is also true for the second or two between
   * arriving on this screen and the conversation existing, and inferring the path from it means a person
   * who clicked quickly would be shown the drawing, watch it start, and then have it replaced by a real
   * screen mid-beat. The capability read is the actual question — is there a computer here — and it is the
   * thing that should decide, which is also why it is what gates spending a run.
   */
  availability: DemoAvailability;
  /** The conversation the demo runs in, or null while it is being created. */
  channel: AgentChannel | null;
  /**
   * Told which beat the drawing is on.
   *
   * Only ever fired on the DRAWN path, and it is the reason the drawn screen and the live one cannot drift
   * apart: the picture reports its own beat upward, the wizard turns that into a phase with the same table
   * the live run reports through, and the heading and the mascot below are reading one value rather than
   * two guesses that happen to agree.
   */
  onBeat?: (beat: StoryBeat) => void;
  /** Where the run reports what it is doing. */
  onReport: (report: DemoRunReport) => void;
  phase: DemoPhase;
  /** Remii's reply, once there is one. */
  reply: string | null;
  /** The desktop session warmed on the welcome screen. */
  session: { url: string; authKey: string } | null;
  /** The mascot seed, so this is the same face as everywhere else in the product. */
  seed: string;
}) {
  const live = availability === "live";
  /*
   * The story's clock, running only while the drawing is what is on screen.
   *
   * `running` is `!live` rather than a constant, so the two paths cannot both be drawing at once even if a
   * deployment's capability read and its roster read land in different orders — there is a moment on the
   * live path where the channel has not been created and `live` is false, and a timer quietly advancing a
   * picture nobody is looking at would put a `needs-you` phase into the live screen's state for no reason.
   */
  const story = useStoryClock(!live);

  React.useEffect(() => {
    if (!live) onBeat?.(story.beat);
  }, [live, onBeat, story.beat]);

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="max-w-md text-center text-3xl font-semibold tracking-tight text-balance">
        {headingFor(phase)}
      </h1>

      <CoworkerStatus
        activity={activity}
        name={REMII_AGENT_NAME}
        phase={phase}
        seed={seed}
      />

      {live ? (
        <LiveFrame
          channel={channel}
          onReport={onReport}
          phase={phase}
          session={session}
        />
      ) : (
        <DrawnFrame beat={story.beat} onReplay={story.restart} />
      )}

      {/*
       * THE ANSWER, AS A REPLY RATHER THAN AS A SUMMARY.
       *
       * This is a coworker's turn, so it is drawn the way a coworker's turn is drawn everywhere else:
       * `Bubble`, the muted variant, and the transcript's own streaming-aware markdown renderer with its
       * own cap. Reused rather than a paragraph of plain text because the alternative is a second thing
       * that claims to render a Bot's prose and does it worse — half a bold marker drawn literally while
       * the answer is still arriving is the exact artefact `chat-transcript.tsx` goes to some length to
       * avoid, and onboarding is where somebody sees an answer land for the first time.
       */}
      {reply ? (
        <Bubble align="start" className="max-w-lg" variant="muted">
          <BubbleContent className="max-w-lg">
            <Streamdown components={markdownComponents}>
              {capMarkdown(reply)}
            </Streamdown>
          </BubbleContent>
        </Bubble>
      ) : null}

      {/*
       * The invitation appears only once there is something real to be invited into. On the drawn path
       * there is no wheel to hand over — nothing here holds a computer — and offering a control that does
       * nothing is worse than not offering it.
       */}
      {live ? <HandoffInvitation /> : null}
    </div>
  );
}

/**
 * The live screen, in the frame the drawing occupies.
 *
 * `ComputerView` and not `LiveScreen`, and that is the load-bearing decision on this screen. `LiveScreen`
 * is only the picture. The things that make this product trustworthy are the controls around it — the
 * `Take control` button that is present on every beat, the amber strip when Remii asks for something, and
 * the masked field that says a password goes to the page and never to the agent — and all three are in
 * `ComputerView`. Rebuilding them here would mean a second implementation of the exact interface whose
 * whole job is to be believed, and it would be the worse one within a release.
 *
 * `DemoTurn` sits below the frame and renders nothing: it is the machinery, and it is here rather than one
 * level up because `useAgent` needs the real channel object and `availability` deliberately does not carry
 * one — the screen's question is whether a computer exists, not whether a conversation does.
 */
function LiveFrame({
  channel,
  onReport,
  phase,
  session,
}: {
  /** Null until the conversation exists, which is the only thing `DemoTurn` cannot be given. */
  channel: AgentChannel | null;
  onReport: (report: DemoRunReport) => void;
  phase: DemoPhase;
  session: { url: string; authKey: string } | null;
}) {
  return (
    <>
      {/*
       * The frame is drawn whether or not the conversation exists yet, and it is the only thing on this
       * path that can be: `ComputerView` opens the desktop itself, so during the second or two before the
       * channel arrives this is a real machine coming up under a real status line. Gating the frame on the
       * conversation instead would put a blank second on a screen whose entire subject is that nothing here
       * is instant.
       */}
      <ComputerView
        active
        aspectRatio={5 / 3}
        computerId={REMII_AGENT_ID}
        minHeight={0}
        minWidth={0}
        name={REMII_AGENT_NAME}
        session={session}
        followingRun={phase === "working" || phase === "needs-you"}
      />

      {channel ? <DemoTurn channel={channel} onReport={onReport} /> : null}
    </>
  );
}

/**
 * The drawn story, in the same frame.
 *
 * `rounded-2xl` and `border` and `overflow-hidden` — the same three as `ComputerView`'s own `<figure>`.
 * Those three are the entire visual contract between the two paths, and they are written out rather than
 * shared because the alternative is a `className` on `ComputerView`, which is one more prop to thread
 * through a component whose docblock already explains at length that `computerId` does not mean what its
 * name suggests.
 *
 * The box is `relative` and sized by `aspect-5/3` because that is what `ComputerView` is given above, so
 * both frames reserve identical height and the status line above them does not move when the machine
 * turns out to be there.
 */
function DrawnFrame({
  beat,
  onReplay,
}: {
  beat: StoryBeat;
  onReplay: () => void;
}) {
  const finished = nextStoryBeat(beat) === null;

  return (
    <figure className="relative aspect-5/3 w-full overflow-hidden rounded-2xl border">
      <StoryDesktop beat={beat} />

      {/*
       * THE ENDING IS AN INVITATION.
       *
       * The story stops, and where it stops there is a way to start it again. That is a better ending than
       * a dead stop for the reason `nextStoryBeat` returns null rather than wrapping: a person who wants to
       * watch it a second time is not asking for this product to run forever, they are asking for it to
       * start again, and those are very different things to offer.
       *
       * `AnimatePresence` so the control arrives with the last beat rather than being there before there
       * is anything to replay, and `motion-safe` so it does not fade in at all for somebody who asked for
       * less motion — they are already on the final beat, which is the whole point of starting them there.
       */}
      <AnimatePresence>
        {finished ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="absolute inset-x-0 bottom-0 flex justify-center pb-3"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            key="replay"
          >
            <Button
              className="bg-card/90 backdrop-blur-sm"
              onClick={onReplay}
              size="sm"
              variant="outline"
            >
              <IconRefresh aria-hidden="true" data-icon="inline-start" />
              Watch again
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </figure>
  );
}

/**
 * The heading, which is the one piece of copy that changes during the demo.
 *
 * Five states and five sentences, and the one that matters the most is `needs-you` — because that is the only
 * moment in the whole product where the interface has something to say to the person rather than about
 * itself, and it says it in the active voice. "It stopped and asked" tells a person what this thing is
 * for in four words, and it is the sentence they will still be able to repeat after they have forgotten
 * everything else on this screen.
 */
function headingFor(phase: DemoPhase): string {
  switch (phase) {
    case "preparing":
      return COPY.demoIdle;
    case "working":
      return COPY.demoWorking;
    case "needs-you":
      return COPY.demoNeedsYou;
    case "settled":
    case "over-time":
      return COPY.demoDone;
    case "failed":
      /*
       * ONE SENTENCE, AND IT DOES NOT APOLOGISE.
       *
       * This is onboarding rather than a support screen, so the honest note is the small one: it is not
       * "we are sorry this happened", which would promise somebody a fixed thing and cost too many words,
       * and it is not "try again", which is an action and none is offered. It is just the truth, said in
       * four words — the run stopped — and the person can see what happened in the conversation below it.
       */
      return "That stopped.";
  }
}

/**
 * The thing worth saying out loud afterwards.
 *
 * Godin's actual test for a purple cow is whether somebody would repeat it to a friend, and a screen that
 * has just watched a computer do a job has produced the raw material for that sentence. So the wizard
 * builds the sentence rather than leaving it to them: a name, a job and a time, on the clipboard, in a
 * form they can paste anywhere.
 *
 * NO SHARE BUTTON AND NO IMAGE, and both were considered. A share button asks for a conversation the
 * product is not in the middle of — a person who has just watched a thing work for the first time is
 * being asked to go and publicise it, which is a different thing from being shown it — and rendering a
 * picture would mean a canvas, a font stack and a second renderer, on the one screen where the least
 * machinery should be visible. Text on a clipboard is all a person needs to start that conversation, and
 * unlike an image it cannot go stale when the product's colours change.
 */
export function Artifact({ elapsedSeconds }: { elapsedSeconds: number }) {
  const [copied, setCopied] = React.useState(false);

  const sentence = React.useMemo(
    () =>
      `My coworker ${REMII_AGENT_NAME} opened a web page and read it back to me in ${elapsedSeconds} ` +
      `seconds, on a computer of its own. I watched the whole thing.`,
    [elapsedSeconds],
  );

  React.useEffect(() => {
    if (!copied) return;
    /* Long enough to read "Copied", short enough that it has cleared before they look away. */
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex w-full max-w-lg flex-col items-center gap-3 rounded-xl border border-dashed p-5">
      <p className="text-center text-sm text-muted-foreground text-balance">
        {sentence}
      </p>
      <Button
        onClick={() => {
          void navigator.clipboard
            ?.writeText(sentence)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        size="sm"
        variant="outline"
      >
        {copied ? (
          <IconCheck aria-hidden="true" data-icon="inline-start" />
        ) : (
          <IconCopy aria-hidden="true" data-icon="inline-start" />
        )}
        {copied ? "Copied" : "Copy this"}
      </Button>
      {/*
       * Announced, because a clipboard write is the one action on this screen that produces no visible
       * result a screen reader would otherwise be able to infer — the label changes, but the change is a
       * swap of two words with no announcement between them on some readers.
       */}
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied to your clipboard." : null}
      </span>
    </div>
  );
}
