import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { DemoScreen } from "@/routes/_authed/onboarding/demo-screen";
import {
  HOLD_MS,
  nextStoryBeat,
  PHASE_FOR_BEAT,
  STORY_BEATS,
  STORY_FINAL_BEAT,
  storyFinished,
} from "@/routes/_authed/onboarding/story-beats";
import { StoryDesktop } from "@/routes/_authed/onboarding/story-desktop";

/*
 * NO `matchMedia` STUB, AND THAT IS THE POINT.
 *
 * The first version of this story decided its own starting beat from `useReducedMotion`, and its tests
 * stubbed `matchMedia` to get there. They passed alone and failed in the suite, because `motion/react`
 * binds its reduced-motion query when the module is evaluated and bun runs every test file in one process
 * — so whichever file imported it first had already fixed the answer, and no stub installed by a later
 * file could change it. A test that only passes when it is run first is not a test.
 *
 * The drawing is now a pure function of a beat, so every beat on this screen is reachable by handing it
 * one, and nothing here depends on animation state at all. The reduced-motion behaviour moved into
 * `useStoryClock`, which is a decision about where the clock lives rather than about what the picture is.
 */

beforeAll(() => {
  GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

/**
 * What a mounted tree has to say, read from the tree rather than from `document.body`.
 *
 * The rest of the suite reads `document.body` and it works there. It does not work here: nothing in this
 * file stubs `fetch`, so nothing forces `@testing-library/react` to resolve its container against the
 * document `GlobalRegistrator` installed, and the mounted node lands outside the `document.body` these
 * tests can see. Reading the container is the more honest target anyway — it is what was rendered, and
 * nothing else.
 */
function visibleText(container: HTMLElement): string {
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

async function draw(beat: (typeof STORY_BEATS)[number]) {
  const view = render(<StoryDesktop beat={beat} />);
  await settle();
  return view.container;
}

describe("the story, as a sequence", () => {
  /*
   * IT ENDS.
   *
   * This assertion is the reason the drawing is pure. The version it replaced ran a cursor between two
   * invented windows on `repeat: Number.POSITIVE_INFINITY`, with nothing on either screen ever changing —
   * no beginning, nothing happening, no end. A thing that never finishes is a thing that has not happened
   * yet, and it is why that screen was forgotten the moment it was seen.
   *
   * As a plain array with a plain successor, "it finishes" is checkable directly. Raced against twelve
   * seconds of timers it was not.
   */
  test("runs out rather than wrapping", () => {
    expect(nextStoryBeat(STORY_FINAL_BEAT)).toBeNull();
    expect(storyFinished(STORY_FINAL_BEAT)).toBe(true);
  });

  test("every beat leads forward to exactly one successor", () => {
    for (const beat of STORY_BEATS.slice(0, -1)) {
      expect(nextStoryBeat(beat)).not.toBeNull();
      expect(storyFinished(beat)).toBe(false);
    }
  });

  /*
   * EVERY BEAT IS TIMED, AND `HOLD_MS` IS TOTAL OVER THEM.
   *
   * `HOLD_MS` is keyed by the beat type, so a beat added to the sequence without a hold is a compile
   * error rather than a beat that renders on somebody else's timing. It is also the thing that decides
   * whether the stop on beat four is caught or walked past.
   */
  test("every beat is timed", () => {
    for (const beat of STORY_BEATS) {
      expect(HOLD_MS[beat]).toBeGreaterThan(0);
    }
    expect(Object.keys(HOLD_MS)).toHaveLength(STORY_BEATS.length);
  });

  test("holds the stop longest, because it is the beat worth catching", () => {
    const longest = Math.max(...STORY_BEATS.map((beat) => HOLD_MS[beat]));
    expect(HOLD_MS.stopped).toBe(longest);
  });

  /*
   * The drawn path runs the same state machine the live one does.
   *
   * `PHASE_FOR_BEAT` is total over the beats — a beat with no entry is a beat where the line above the
   * picture says something the picture is not doing, which is the precise bug that made the old loop worth
   * replacing in the first place.
   */
  test("every beat maps to a run phase", () => {
    expect(PHASE_FOR_BEAT.rest).toBe("preparing");
    expect(PHASE_FOR_BEAT.task).toBe("working");
    expect(PHASE_FOR_BEAT.reading).toBe("working");
    expect(PHASE_FOR_BEAT.stopped).toBe("needs-you");
    expect(PHASE_FOR_BEAT["handed-back"]).toBe("settled");
  });
});

describe("the drawing, beat by beat", () => {
  test("is decorative: hidden from the tree and inert to the pointer", async () => {
    const container = await draw("reading");
    const root = container.firstElementChild;

    /*
     * CARRIED OVER FROM THE LOOP, and worth keeping through a rewrite.
     *
     * The cursor looks like something you could grab. It is not: `pointer-events-none` so a click passes
     * through to the screen behind it, and `aria-hidden` so a screen reader is not walked through four
     * invented windows on the way to the one button this wizard has. Both properties are the reason a
     * person who reaches for the picture does not get a dead cursor.
     */
    expect(root?.getAttribute("aria-hidden")).toBe("true");
    expect(root?.className).toContain("pointer-events-none");
  });

  /*
   * THE FIRST BEAT HAS NO ADDRESS, AND EVERY LATER ONE DOES.
   *
   * The old loop drew a grey skeleton bar in the address bar, which is honest about being a placeholder and
   * completely forgettable — an address bar with no address in it is the clearest possible statement that
   * nothing is happening on this screen. So the one piece of real text on this drawing is the address, and
   * its ABSENCE on beat one is what makes its presence on beat two read as somebody having opened it.
   */
  test("the address bar fills partway through, and stays filled", async () => {
    expect(visibleText(await draw("rest"))).not.toContain("example.com");
    for (const beat of STORY_BEATS.slice(1)) {
      expect(visibleText(await draw(beat))).toContain("example.com");
    }
  });

  test("the wall appears on the stop and only there", async () => {
    expect(visibleText(await draw("stopped"))).toContain("Sign in to continue");
    expect(visibleText(await draw("reading"))).not.toContain("Sign in");
    expect(visibleText(await draw(STORY_FINAL_BEAT))).not.toContain("Sign in");
  });

  /*
   * NO PASSWORD FIELD, ON ANY BEAT.
   *
   * The real product draws one — the masked input in `computer-view.tsx` that says the value goes to the
   * page and is never shown to the assistant — and it is the most reassuring thing in the whole product. A
   * drawing of one would teach a person to trust a gesture the product cannot make on their behalf, and
   * this screen's entire claim is that it tells the truth about what happens. So the drawn path shows the
   * wall and shows what having the wheel was for, and never asks for a credential on any of its five beats.
   */
  test("never invents a password field for the wall it draws", async () => {
    for (const beat of STORY_BEATS) {
      const container = await draw(beat);
      expect(container.querySelectorAll("input")).toHaveLength(0);
      expect(visibleText(container)).not.toContain("password");
    }
  });

  /*
   * THE ANSWER IS THE DEMO TASK'S OWN SUBJECT, not a sentence written for a picture — so what somebody
   * reads at the end of the drawn story is what they would have read if the computer had been there. The two
   * paths differ in whether a machine did it, not in what it did.
   */
  test("ends on the answer, and only on the answer", async () => {
    expect(visibleText(await draw(STORY_FINAL_BEAT))).toContain(
      "This domain is for use in documentation",
    );
    for (const beat of STORY_BEATS.slice(0, -1)) {
      expect(visibleText(await draw(beat))).not.toContain(
        "This domain is for use in documentation",
      );
    }
  });
});

describe("the demo screen with no computer behind it", () => {
  test("draws the story, and offers no wheel that could do anything", async () => {
    const { container } = render(
      <DemoScreen
        activity={null}
        availability="drawn"
        channel={null}
        onReport={() => {}}
        phase="preparing"
        reply={null}
        seed="remii"
        session={null}
      />,
    );
    await settle();

    const text = visibleText(container);
    expect(text).toContain("Watch it work.");

    /*
     * NO "TAKE THE WHEEL", AND THAT IS THE ASSERTION.
     *
     * The invitation exists to tell a person they may interrupt a real run. There is no run here and no
     * desktop to take the wheel of, so offering the control would be offering something that does nothing
     * — worse than not offering it, because it teaches a person that this product's buttons are decorative.
     *
     * Note what is NOT asserted: no badge saying "drawn", no apology, no greyed-out frame. A person on a
     * deployment with no E2B key should reach the end of onboarding with no idea a lesser path exists,
     * because for some of them it is the only path there will ever be.
     */
    expect(text).not.toContain("Take the wheel");
  });

  test("shows a reply as a coworker's own turn", async () => {
    const { container } = render(
      <DemoScreen
        activity={null}
        availability="drawn"
        channel={null}
        onReport={() => {}}
        phase="settled"
        reply="This domain is for documentation."
        seed="remii"
        session={null}
      />,
    );
    await settle();

    /*
     * The answer is a BUBBLE, not a caption.
     *
     * It is drawn with the same `Bubble` the transcript draws a coworker's turn in, and it is the only
     * place on this screen where prose appears — which is the point. A person who watches an answer land
     * during onboarding and then meets the same shape in a real conversation has been given one thing to
     * recognise rather than two.
     */
    expect(container.querySelector('[data-slot="bubble"]')).not.toBeNull();
    expect(visibleText(container)).toContain(
      "This domain is for documentation.",
    );
    expect(visibleText(container)).toContain("That is the whole product.");
  });
});
