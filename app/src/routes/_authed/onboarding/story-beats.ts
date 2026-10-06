/**
 * The story's beats, its timing, and its end.
 *
 * Separated from the drawing because of a testing fact that turned out to be a design fact.
 *
 * `motion/react` binds its reduced-motion query when the module is evaluated, and bun runs every test
 * file in one process — so a component that decides its own starting beat from `useReducedMotion` cannot
 * be tested in isolation, no matter how carefully the stub is installed. The first version of this story
 * did exactly that, and its test passed alone and failed in the suite for reasons that had nothing to do
 * with the code. So the drawing became a pure function of a beat, the clock moved up beside the screen
 * that owns it, and the beat table with it. Now the interesting property — that the story FINISHES — is a
 * fact about a plain array with a plain successor function, and it can be asserted directly instead of
 * being raced against a twelve-second wall clock.
 */
import type { DemoPhase } from "./demo";

/**
 * The five beats, in order, and there is no sixth.
 *
 * The old drawing ran a cursor between two invented windows on `repeat: Number.POSITIVE_INFINITY`, with
 * nothing on either screen ever changing. There was no beginning, nothing happened, and there was no end
 * — which is precisely the description of every onboarding carousel in the category. A cursor that moves
 * proves nothing, because moving is the one thing a cursor does when nothing is happening.
 */
export const STORY_BEATS = [
  "rest",
  "task",
  "reading",
  "stopped",
  "handed-back",
] as const;

export type StoryBeat = (typeof STORY_BEATS)[number];

/**
 * How long each beat is held, in milliseconds.
 *
 * Read as a sentence with pauses in it, which is how it was chosen. The rests are the punctuation: long
 * enough to be looked at rather than glanced at, and the two that matter — the task arriving and the stop
 * happening — are the longest, because those are the two things a person has to catch. `stopped` is held
 * longest of all, because it is the beat somebody will want to look at twice.
 *
 * The total is a shade under twelve seconds, which is also about what the loop spent doing nothing. The
 * same twelve seconds, spent on something that ends.
 */
export const HOLD_MS: Record<StoryBeat, number> = {
  rest: 1_600,
  task: 2_200,
  reading: 2_400,
  stopped: 3_400,
  "handed-back": 2_600,
};

/** The beat the story rests on when nobody is watching it move. */
export const STORY_FINAL_BEAT: StoryBeat = "handed-back";

/**
 * The next beat, or null at the end.
 *
 * Null rather than a wrap to the first beat, and that is the entire anti-loop fix in one line. A
 * successor that returned to the beginning would make this drawing exactly the thing it replaced;
 * returning null makes "it finished" a value the clock can see, and gives the screen above something to
 * offer — a replay, which is a better ending than a dead stop because a person who wants to watch it
 * again is not asking for the product to run forever, they are asking for it to start again.
 */
export function nextStoryBeat(beat: StoryBeat): StoryBeat | null {
  const index = STORY_BEATS.indexOf(beat);
  if (index < 0 || index === STORY_BEATS.length - 1) return null;
  return STORY_BEATS[index + 1] ?? null;
}

/**
 * The drawn beat as a run phase, so `CoworkerStatus` and the heading need no second table for it.
 *
 * This is what keeps the drawn path honest. The drawing has no server to ask, so its status line and its
 * heading would otherwise have to be a second guess at what the picture is showing — and a second guess is
 * how a status line ends up saying "working" while the drawing sits on the stopped beat. Reporting the
 * beat upward means the line, the heading and the picture all read one value, and the drawn path runs the
 * same state machine the live one does.
 */
export const PHASE_FOR_BEAT: Record<StoryBeat, DemoPhase> = {
  rest: "preparing",
  task: "working",
  reading: "working",
  stopped: "needs-you",
  "handed-back": "settled",
};

/** Whether the story has run out, which is what the screen above watches for. */
export function storyFinished(beat: StoryBeat): boolean {
  return nextStoryBeat(beat) === null;
}
