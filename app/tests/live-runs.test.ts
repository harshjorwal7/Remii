import { afterEach, describe, expect, test } from "bun:test";
import {
  bumpRun,
  bumpTurn,
  forgetLiveRun,
  liveRun,
  patchLiveRun,
} from "@/lib/copilot/live-runs";

/**
 * THE STATE A CONVERSATION LEAVES BEHIND.
 *
 * Leaving a conversation mid-work used to reset everything the returning screen would need to know
 * that work was happening: the turn counters were `useState` created on mount, and so were the
 * parked corrections and the live transcript. The server kept working — leaving a conversation never
 * aborted a run — but the screen a person came back to believed, correctly by its own lights, that
 * nothing was happening, with no Working line, no Stop button, and no memory of what they had
 * typed while they waited.
 *
 * These hold the store shut as the single place that outlives the route. They are pure — the store
 * is a Map and a listener set, and nothing here renders — because the thing being fixed is a
 * lifetime, not a layout.
 */

afterEach(() => {
  // The store is module state on purpose — outliving the component is the whole point of it — so a
  // test that opened a conversation has to say it wants a fresh one. See `forgetLiveRun`.
  for (const key of ["a", "b"]) forgetLiveRun(key);
});

describe("the live-run store", () => {
  test("a channel with nothing running reads as idle, not as missing", () => {
    expect(liveRun("a")).toEqual({
      turns: 0,
      runs: 0,
      queued: [],
      messages: [],
    });
  });

  /*
   * THE COUNTERS OUTLIVE THE SCREEN THAT RAISED THEM, which is the whole reason this store exists.
   * A `useState` counter is gone the moment its component unmounts, so a person who left a
   * conversation mid-answer came back to a screen that had counted nothing and was about to tell the
   * roster the work had stopped.
   */
  test("turns and runs outlive the mount that raised them", () => {
    bumpTurn("a", 1);
    bumpRun("a", 1);
    expect(liveRun("a").turns).toBe(1);
    expect(liveRun("a").runs).toBe(1);

    // The "unmount" is nothing at all here — that is the point. There is no component to tear down;
    // the count simply is still true on the next read.
    expect(liveRun("a").turns).toBe(1);
  });

  /*
   * TWO CHANNELS DO NOT SHARE A COUNT. One conversation working must not make another one's composer
   * think it is busy, and a Map keyed by channel is what keeps them apart — the alternative, a
   * single module-level number, is the shape of bug that only shows up with two conversations and
   * one busy.
   */
  test("channels are disjoint", () => {
    bumpTurn("a", 1);
    expect(liveRun("b").turns).toBe(0);
  });

  test("a counter that comes back down does not go negative", () => {
    bumpTurn("a", 1);
    bumpTurn("a", -1);
    expect(liveRun("a").turns).toBe(0);
  });

  /*
   * THE LIVE TRANSCRIPT IS KEPT SO A RETURNING SCREEN HAS SOMETHING TO DRAW. Before the answer
   * arrives from history or the reconnect, this is the only view of a run in progress the browser
   * has — and without it a person coming back mid-answer sees an empty transcript on a thread that
   * is busy, which is indistinguishable from a broken product.
   */
  test("the live transcript is kept for the return trip", () => {
    const messages = [
      { id: "user-1", role: "user" as const, content: "do the thing" },
    ];
    patchLiveRun("a", { messages });
    expect(liveRun("a").messages).toHaveLength(1);
  });

  /*
   * AND A LATER WRITE REPLACES IT RATHER THAN APPENDING TO IT. The snapshot is a mirror of the
   * agent's own array, which grows by replacement; concatenating would grow the store on every
   * chunk and draw the same transcript twice.
   */
  test("a later snapshot replaces the earlier one", () => {
    patchLiveRun("a", {
      messages: [{ id: "user-1", role: "user", content: "one" }],
    });
    patchLiveRun("a", {
      messages: [
        { id: "user-1", role: "user", content: "one" },
        { id: "assistant-1", role: "assistant", content: "two" },
      ],
    });
    expect(liveRun("a").messages).toHaveLength(2);
  });
});
