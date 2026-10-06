import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AgentProfile } from "@/lib/agents/queries";
import type { ChannelActivityBrief } from "@/lib/channels/queries";
import { REMII_AGENT_ID } from "../../shared/remii";
import {
  aiStateForDemo,
  computerHoldingAgent,
  DEMO_TASK,
  demoAvailability,
  shouldRunDemo,
} from "@/routes/_authed/onboarding/demo";
import { textOf } from "@/routes/_authed/onboarding/demo-run";
import { PHASE_FOR_BEAT } from "@/routes/_authed/onboarding/story-beats";

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function profile(id: string, over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id,
    name: id,
    title: "",
    roleDescription: "",
    avatarSeed: id,
    mascot: null,
    visibility: "private",
    hidden: false,
    systemOwned: false,
    canManage: true,
    mine: true,
    ...over,
  };
}

const WITH_COMPUTER = { generativeUi: true, computer: true };
const WITHOUT_COMPUTER = { generativeUi: true, computer: false };

describe("which coworker may drive the computer", () => {
  test("is Remii, by id", () => {
    const remii = profile(REMII_AGENT_ID);
    expect(computerHoldingAgent([remii])?.id).toBe(REMII_AGENT_ID);
  });

  /*
   * THE CASE THAT MATTERS MOST.
   *
   * `defaultAgentProfile` prefers `picked-harness` over Remii, which is right for "who should this message
   * go to" and badly wrong here: `botHoldsTheComputer` gates the desktop tools on Remii's id alone, so a
   * demo handed to `picked-harness` watches a coworker explain at length that it cannot see a screen. This
   * is the assertion that stops a future "let's just reuse the default helper" from looking free.
   */
  test("is not the default recipient when that is somebody else", () => {
    const harness = profile("picked-harness");
    const remii = profile(REMII_AGENT_ID);
    expect(computerHoldingAgent([harness, remii])?.id).toBe(REMII_AGENT_ID);
  });

  test("is null rather than a guess when the roster is empty or unloaded", () => {
    expect(computerHoldingAgent([])).toBeNull();
    expect(computerHoldingAgent(undefined)).toBeNull();
    expect(computerHoldingAgent([profile("data-analyst")])).toBeNull();
  });
});

describe("whether a live demo is possible", () => {
  test("needs a computer AND the coworker who holds it", () => {
    expect(demoAvailability(WITH_COMPUTER, profile(REMII_AGENT_ID))).toBe(
      "live",
    );
  });

  /*
   * EVERY WAY OF SAYING "there is no computer here".
   *
   * A deployment with no E2B key, a server too old to answer `/api/capabilities`, and a server that failed
   * to, all reach this function differently and all have to draw. The optimistic reading of any of them
   * mounts a run on a deployment that cannot finish one, which is the failure this whole gate exists to
   * prevent — so absent, false and unresolvable are all one answer.
   */
  test("draws when there is no computer, including an unanswered capability read", () => {
    expect(demoAvailability(WITHOUT_COMPUTER, profile(REMII_AGENT_ID))).toBe(
      "drawn",
    );
    /* A server that could not be reached, and a server too old to know the field: both answer undefined. */
    expect(demoAvailability(undefined, profile(REMII_AGENT_ID))).toBe("drawn");
    /*
     * A PARTIAL ANSWER IS NOT A YES. `deployment/queries.ts` resolves an absent field to `false` and
     * says that is the fail-closed direction, and this is the assertion that the gate agrees with that
     * rather than reading `undefined` as permission — a replica that answered one field of two has not
     * told us there is a computer.
     */
    expect(demoAvailability({} as never, profile(REMII_AGENT_ID))).toBe(
      "drawn",
    );
    expect(
      demoAvailability(
        { generativeUi: true } as never,
        profile(REMII_AGENT_ID),
      ),
    ).toBe("drawn");
  });

  test("draws when the computer exists but no coworker on the roster may drive it", () => {
    expect(demoAvailability(WITH_COMPUTER, null)).toBe("drawn");
    /* Resolved the way the wizard resolves it — through the helper, not by hand. */
    expect(
      demoAvailability(
        WITH_COMPUTER,
        computerHoldingAgent([
          profile("data-analyst"),
          profile("social-curator"),
        ]),
      ),
    ).toBe("drawn");
  });

  test("never reads the generative UI flag, which has nothing to do with a screen", () => {
    expect(
      demoAvailability(
        { generativeUi: false, computer: true },
        profile(REMII_AGENT_ID),
      ),
    ).toBe("live");
  });
});

describe("the work state the mascot wears", () => {
  const working: ChannelActivityBrief = {
    state: "thinking",
    label: null,
    detail: null,
    botId: REMII_AGENT_ID,
  };

  test("deferring to the brief while a run is going", () => {
    expect(aiStateForDemo("working", working, false)).toBe("thinking");
    expect(aiStateForDemo("preparing", null, false)).toBe("idle");
  });

  /*
   * THE REASON `aiStateForDemo` EXISTS AT ALL.
   *
   * The brief goes quiet when a run ends, which is right for a roster — a finished run is the absence of
   * activity — and wrong for a screen whose only job is to show somebody that something finished. Left
   * alone, a completed demo would settle the mascot back to its resting face at the exact moment the
   * person is deciding whether what they watched was worth anything.
   */
  test("a settled run stays pleased even though the brief has gone quiet", () => {
    expect(aiStateForDemo("settled", null, false)).toBe("done");
    expect(aiStateForDemo("settled", working, false)).toBe("done");
  });

  test("a blocked run reads as waiting to be spoken to, not as pleased", () => {
    expect(aiStateForDemo("needs-you", null, false)).toBe("listening");
  });

  test("a run that outran the wizard is still streaming, not done", () => {
    expect(aiStateForDemo("over-time", null, false)).toBe("streaming");
  });
});

describe("whether to spend a run", () => {
  /*
   * THE MISTAKE THIS FUNCTION EXISTS TO STOP.
   *
   * The first version of this gate was `step === 1` — the demo screen exists, so run the demo — and on a
   * deployment with no computer behind it that spent a real model turn on a coworker explaining at length
   * that it cannot see a screen. It then left that conversation in the new person's sidebar, which is the
   * first thing they would have found on their home screen, next to a drawing telling a completely
   * different story.
   *
   * So: a drawn deployment must never start one, on any step.
   */
  test("a deployment with no computer never runs the demo", () => {
    for (const step of [0, 1, 2]) {
      expect(shouldRunDemo(step, "drawn")).toBe(false);
    }
  });

  /*
   * AND THE OTHER HALF, WHICH IS THE EASY ONE TO GET WRONG IN THE OTHER DIRECTION.
   *
   * Starting the run as soon as the capability resolves would put a model turn and a conversation on
   * somebody's screen while they were still reading the welcome copy — the screen that exists precisely so
   * the twenty seconds the desktop takes to wake happen under a paragraph rather than in front of a person.
   */
  test("a live deployment waits for the demo screen", () => {
    expect(shouldRunDemo(0, "live")).toBe(false);
    expect(shouldRunDemo(1, "live")).toBe(true);
  });
});

describe("reading a Bot's turn off the wire", () => {
  test("a plain string", () => {
    expect(
      textOf({ id: "1", role: "assistant", content: "It is a domain." }),
    ).toBe("It is a domain.");
  });

  /*
   * THE SHAPE THAT IS NOT A STRING.
   *
   * AG-UI lets content be an array of parts, and a turn that carried a component or an attachment arrives
   * in this form. Treating it as anything but text renders `[object Object]` in the middle of the only
   * sentence this screen has, so the parts are read and joined rather than assumed away.
   */
  test("the parts of a multipart turn are joined, and the non-text ones are skipped", () => {
    expect(
      textOf({
        id: "1",
        role: "assistant",
        content: [
          { type: "text", text: "First. " },
          { type: "component", name: "chart" },
          { type: "text", text: "Second." },
        ],
      } as never),
    ).toBe("First. Second.");
  });

  test("nothing at all is empty rather than a crash", () => {
    expect(textOf({ id: "1", role: "assistant", content: null } as never)).toBe(
      "",
    );
    expect(
      textOf({ id: "1", role: "assistant", content: undefined } as never),
    ).toBe("");
  });
});

describe("the drawn story's beats", () => {
  /*
   * TOTAL, ON PURPOSE.
   *
   * `PHASE_FOR_BEAT` is what keeps the drawn path's status line reading the same value its drawing is
   * showing. A beat with no entry here is a beat where the line above the picture says something the
   * picture is not doing, which is the specific bug that made the old loop — a cursor that moved and
   * nothing ever happened — worth replacing in the first place.
   */
  test("every beat maps to a run phase, and the stop is one of them", () => {
    expect(PHASE_FOR_BEAT.rest).toBe("preparing");
    expect(PHASE_FOR_BEAT.task).toBe("working");
    expect(PHASE_FOR_BEAT.reading).toBe("working");
    expect(PHASE_FOR_BEAT.stopped).toBe("needs-you");
    expect(PHASE_FOR_BEAT["handed-back"]).toBe("settled");
    expect(Object.keys(PHASE_FOR_BEAT)).toHaveLength(5);
  });
});

describe("the demo task itself", () => {
  /*
   * THREE PROPERTIES OF A STRING THAT IS SENT, FOR REAL, ON SOMEBODY'S FIRST DAY.
   *
   * A test is a poor place to enforce taste and an excellent place to enforce a side effect. If somebody
   * later makes the demo more impressive by having it log in somewhere, buy something or post something,
   * this fails — which is the moment to have a conversation about it rather than the moment a stranger's
   * deployment finds out.
   */
  test("reads a page and nothing else", () => {
    expect(DEMO_TASK).toContain("https://example.com");
    /* Read-only verbs, and an assertion about the absence of the ones that would not be. */
    for (const verb of ["log in", "sign in", "submit", "buy", "post", "send"]) {
      expect(DEMO_TASK.toLowerCase()).not.toContain(verb);
    }
  });

  test("asks to be asked rather than to work around a wall", () => {
    expect(DEMO_TASK).toContain("ask me");
  });
});
