import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";

/* Rendered, not called: the point of these cases is the markup, including what a screen reader is
 * told, and there is no way to check either from the table alone. */
GlobalRegistrator.register({ url: "https://remii.test/" });
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

import {
  ActivityMark,
  aiStateForChannel,
  readActivityLook,
} from "@/components/channels/activity-mark";
import type { AIState } from "@/components/agents/orb/ai-core";
import type { ChannelActivityBrief } from "@/lib/channels/queries";

function brief(
  state: ChannelActivityBrief["state"],
  extra: Partial<ChannelActivityBrief> = {},
): ChannelActivityBrief {
  return { state, label: null, detail: null, botId: "bot-1", ...extra };
}

describe("the severity ladder", () => {
  test("a run blocked on the reader outranks one that broke, which outranks work in progress", () => {
    // The order is a judgement about what a roster is for, and it is the one thing a test should
    // hold still: a change here reorders every indicator in the product.
    const states: ChannelActivityBrief["state"][] = [
      "waiting_on_you",
      "failed",
      "thinking",
      "delegated",
      "stopped",
    ];
    const looks = states.map((state) => readActivityLook(brief(state)));
    // Each of these is attention, and none of them is quiet: only `stopped` and `delegated` are
    // muted, and `waiting_on_you` is the only one drawn in the foreground.
    expect(looks[0].className).toBe("bg-primary");
    expect(looks[0].pulse).toBe(false);
    expect(looks[1].className).toBe("bg-destructive");
    expect(looks[2].pulse).toBe(true);
    expect(looks[3].className).toContain("muted-foreground");
    expect(looks[4].className).toContain("muted-foreground");
  });

  test("only work in progress pulses, because only that changes without a person", () => {
    for (const state of [
      "waiting_on_you",
      "failed",
      "delegated",
      "stopped",
    ] as const) {
      expect(readActivityLook(brief(state)).pulse).toBe(false);
    }
  });
});

describe("aiStateForChannel", () => {
  test("every run state reaches an avatar state, and none is left unmapped", () => {
    // The bug this table exists to prevent: the sidebar avatar was never given a state at all, so it
    // sat in its resting loop through every run. A state that fell through to `undefined` here would
    // put that back, silently, because a missing key and an idle avatar look identical on screen.
    const expected: Record<ChannelActivityBrief["state"], AIState> = {
      thinking: "thinking",
      delegated: "thinking",
      waiting_on_you: "listening",
      stopped: "idle",
      failed: "error",
      done: "done",
    };
    for (const state of Object.keys(
      expected,
    ) as ChannelActivityBrief["state"][]) {
      expect(aiStateForChannel(brief(state), false)).toBe(expected[state]);
    }
  });

  test("a run blocked on the reader listens rather than thinks", () => {
    // A run waiting on a person is not working, and `thinking` would have it visibly churning at
    // somebody who has not answered yet.
    expect(aiStateForChannel(brief("waiting_on_you"), false)).toBe("listening");
  });

  test("a busy channel with no brief yet still says it is working", () => {
    // `busy` is the socket-only flag and the brief is the server's; a headless turn sets the first and
    // never produces the second, so reading only the brief would leave that work invisible.
    expect(aiStateForChannel(null, true)).toBe("thinking");
  });

  test("the brief outranks the flag, because it is the more specific answer", () => {
    expect(aiStateForChannel(brief("failed"), true)).toBe("error");
  });

  test("nothing running is idle, and a state from the future is idle rather than invented", () => {
    expect(aiStateForChannel(null, false)).toBe("idle");
    expect(aiStateForChannel(undefined, false)).toBe("idle");
    const unknown = { ...brief("thinking"), state: "from_the_future" } as never;
    expect(aiStateForChannel(unknown, false)).toBe("idle");
  });
});

describe("ActivityMark", () => {
  test("says who it is waiting on, because that is the part worth knowing", () => {
    const { container } = render(
      <ActivityMark
        activity={brief("delegated", { label: "With Research Desk" })}
        withText
      />,
    );
    expect(container.textContent).toContain("With Research Desk");
  });

  test("falls back to a plain word when the server sent no label", () => {
    const { container } = render(
      <ActivityMark activity={brief("waiting_on_you")} withText />,
    );
    expect(container.textContent).toContain("Waiting on you");
  });

  test("names the failure for a screen reader, and not just the word 'Failed'", () => {
    const { container } = render(
      <ActivityMark
        activity={brief("failed", { detail: "model refused" })}
        withText
      />,
    );
    // The visible word is short; the announcement carries the reason, so a screen reader is not
    // told only that something failed.
    expect(container.querySelector(".sr-only")?.textContent).toBe(
      "Failed: model refused",
    );
    expect(
      container.querySelector("[aria-hidden='true']:last-child")?.textContent,
    ).toBe("Failed");
  });

  test("a roster row gets a dot and no sentence, because a roster is scanned", () => {
    const { container } = render(<ActivityMark activity={brief("thinking")} />);
    expect(container.textContent).toBe("");
  });

  test("a finished run draws nothing at all", () => {
    const { container } = render(
      <ActivityMark activity={brief("done")} withText />,
    );
    expect(container.innerHTML).toBe("");
  });

  test("a state this build has never heard of degrades to nothing, not to an alarm", () => {
    const unknown = { ...brief("thinking"), state: "from_the_future" } as never;
    const { container } = render(<ActivityMark activity={unknown} withText />);
    expect(container.innerHTML).toBe("");
  });
});
