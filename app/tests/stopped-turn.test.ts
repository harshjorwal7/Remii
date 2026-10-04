import { describe, expect, test } from "bun:test";
import {
  finishNeedsExplanation,
  stoppedReason,
} from "../src/lib/copilot/stopped-turn";

/**
 * What a person is told when a turn ends and no answer came.
 *
 * The cases are the three things that actually arrive: the sentence the deployment's stall watchdog
 * wrote into the run, an error thrown in the browser, and nothing at all.
 */

describe("the reason a turn ended", () => {
  test("passes on what ended the turn, in its own words", () => {
    expect(
      stoppedReason(
        "Risk Analyst stopped responding. Nothing arrived from it for 2 minutes, so this turn was ended. Ask again, or check that the Bot is running.",
      ),
    ).toContain("Risk Analyst stopped responding");
  });

  test("reads an Error the same way, because a failed run carries one", () => {
    expect(
      stoppedReason(new Error("The endpoint refused the connection")),
    ).toBe("The endpoint refused the connection");
  });

  test("says so plainly when nothing was reported, rather than inventing a cause", () => {
    // This is the one moment a person has no other way to find out what went wrong, so a guess here
    // would be worse than an admission.
    expect(stoppedReason(undefined)).toBe(
      "The Bot stopped without saying why.",
    );
    expect(stoppedReason("")).toBe("The Bot stopped without saying why.");
    expect(stoppedReason("   ")).toBe("The Bot stopped without saying why.");
    expect(stoppedReason(new Error(""))).toBe(
      "The Bot stopped without saying why.",
    );
    expect(stoppedReason({ message: "not a string or an Error" })).toBe(
      "The Bot stopped without saying why.",
    );
  });
});

/**
 * WHETHER A FINISH THAT SAID SOMETHING STILL NEEDS EXPLAINING ITSELF.
 *
 * The rule this replaces was "a run that produced any text is a finished run", and it is why a turn
 * cut off halfway through a task was drawn as a turn that finished. A working model emits sentences
 * while it works — "let me check that for you" is not an answer, it is the sound of an agent working
 * — so a run killed at its hundredth tool call, or at the channel's twenty-minute deadline, almost
 * always had text behind it, and that text suppressed the only notice that would have explained the
 * truncation. A person was left with half an answer and no reason, which is worse than either a
 * clean success or a clean failure.
 *
 * So "said something" and "finished" are separated. The two conditions are independent: a run the
 * server named a cause for is reported whatever it managed to say, and a run that said nothing at
 * all is still reported whatever it managed to do.
 */
describe("a finish that produced text", () => {
  const EARLY = {
    message:
      "Remii exceeded the maximum continuous execution limit of 20 minutes. This turn was ended to keep the channel moving.",
  };
  const STALLED = { code: "AGENT_STREAM_STALLED" };

  test("is explained when the server says the run ended early", () => {
    // The regression: text on the wire used to be read as a finished turn.
    expect(finishNeedsExplanation(EARLY, true)).toBe(true);
    expect(finishNeedsExplanation(STALLED, true)).toBe(true);
  });

  test("is left alone when the run simply finished", () => {
    // An ordinary completion carries no sentence and no code, and putting a notice under every
    // answer anybody ever got would be its own kind of noise.
    expect(finishNeedsExplanation({}, true)).toBe(false);
    expect(finishNeedsExplanation({ message: "  " }, true)).toBe(false);
    expect(finishNeedsExplanation(undefined, true)).toBe(false);
    expect(finishNeedsExplanation(null, true)).toBe(false);
  });

  test("is explained when nothing was said, as it always was", () => {
    expect(finishNeedsExplanation({}, false)).toBe(true);
    expect(finishNeedsExplanation(EARLY, false)).toBe(true);
  });
});
