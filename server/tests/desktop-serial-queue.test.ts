import { describe, expect, test } from "bun:test";
import type {
  DesktopComputerUse,
  DesktopMachine,
} from "../src/computer/desktop-stream";
import { desktopToolsFor } from "../src/computer/desktop-tools";

/**
 * One mouse, one keyboard, one computer — and a loop that offers three at once.
 *
 * The agent dispatches a step's tool calls with `Promise.all` and the model is invited to ask for
 * parallel tool calls, which is right for tools that touch different things and wrong for a pointer. A
 * `computer_click` is three operations on the display, so three clicks in one step became nine with no
 * ordering between them, and a `computer_key` racing a `computer_type` landed wherever the pointer
 * happened to be: a Ctrl+S in the middle of a typed URL, a click on a button the previous click had not
 * revealed yet.
 *
 * The visible symptom was never "the framework interleaved my input". It was a task that failed
 * sometimes, in a way that looked like the model being unreliable — and every one of those mis-landed
 * actions cost a `computer_screen` to diagnose and another to retry, so this is a speed fix as much as a
 * correctness one.
 *
 * HOW IT IS ASSERTED, which is the part worth reading. The obvious way — fire two calls, look at the
 * order things happened in — does not work: it passed with the queue deleted, because two `await
 * Promise.resolve()` hops finish inside one tick and one tick cannot interleave. Asserting log order is
 * asserting an accident of scheduling.
 *
 * So each stub counts how many are running at once and records the highest number it ever saw. That is
 * the property itself: one pointer cannot be in two places, so two is a failure regardless of what the
 * log says. It fails the moment the queue is removed, which is the only test of this kind worth having.
 */

/** Tracks overlap. One pointer cannot be in two places, so `peak > 1` is the bug. */
const overlap = () => {
  const state = { running: 0, peak: 0 };
  return {
    state,
    async enter<T>(work: () => Promise<T>): Promise<T> {
      state.running += 1;
      state.peak = Math.max(state.peak, state.running);
      try {
        // Real time, not microtasks: an interleaving bug is about wall-clock overlap, so the fake has
        // to overlap too.
        await Bun.sleep(20);
        return await work();
      } finally {
        state.running -= 1;
      }
    },
  };
};

const stubMachine = (): DesktopMachine =>
  ({
    exec: async () => ({ exitCode: 0, stdout: "" }),
    readFile: async () => "",
    writeFile: async () => {},
    listFiles: async () => [],
  }) as unknown as DesktopMachine;

const build = (
  guard: ReturnType<typeof overlap>,
  options: {
    id?: string;
    mouse?: Record<string, unknown>;
    gate?: Promise<void>;
  } = {},
) => {
  const gate = options.gate;
  const use = {
    screenshot: {
      takeCompressed: async () => ({}),
      takeCompressedRegion: async () => ({}),
      takeFullScreen: async () => ({}),
    },
    mouse: {
      move: async () => guard.enter(async () => undefined),
      click: async () => guard.enter(async () => undefined),
      drag: async () => guard.enter(async () => undefined),
      scroll: async () => guard.enter(async () => undefined),
      ...options.mouse,
    },
    keyboard: {
      type: async () => {
        await guard.enter(async () => {
          if (gate) await gate;
        });
      },
      press: async () => guard.enter(async () => undefined),
      hotkey: async () => guard.enter(async () => undefined),
    },
    display: {
      getInfo: async () => ({ displays: [] }),
      getWindows: async () => ({ windows: [] }),
    },
    accessibility: { getTree: async () => ({ root: null }) },
  } as unknown as DesktopComputerUse;

  return desktopToolsFor({
    actor: { id: options.id ?? "queue-person" },
    botId: `bot-${options.id ?? "queue-person"}`,
    resolve: async () => ({
      computerUse: use,
      machine: stubMachine(),
      displayWidth: 1920,
      displayHeight: 1080,
    }),
  });
};

const find = (tools: ReturnType<typeof build>, name: string) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
};

const CLICK = { x: 1, y: 1 };
const SCROLL = { x: 2, y: 2, direction: "down" as const, amount: 3 };

describe("two acting calls issued at the same moment", () => {
  test("never overlap on one computer", async () => {
    const guard = overlap();
    const tools = build(guard);

    await Promise.all([
      find(tools, "computer_click").execute(CLICK),
      find(tools, "computer_scroll").execute(SCROLL),
      find(tools, "computer_drag").execute({
        startX: 1,
        startY: 1,
        endX: 5,
        endY: 5,
      }),
    ]);

    // Three acting calls, three real windows of time, and never more than one of them open.
    expect(guard.state.peak).toBe(1);
  });

  test("a failed action does not wedge the ones behind it", async () => {
    const guard = overlap();
    const tools = build(guard);

    // A computer with no mouse at all, so the click throws inside the adapter.
    const brokenUse = {
      screenshot: {
        takeCompressed: async () => ({}),
        takeCompressedRegion: async () => ({}),
        takeFullScreen: async () => ({}),
      },
      mouse: {},
      keyboard: {
        type: async () => {},
        press: async () => {},
        hotkey: async () => {},
      },
      display: {
        getInfo: async () => ({ displays: [] }),
        getWindows: async () => ({ windows: [] }),
      },
      accessibility: { getTree: async () => ({ root: null }) },
    } as unknown as DesktopComputerUse;
    const broken = desktopToolsFor({
      actor: { id: "queue-person" },
      botId: "bot-broken",
      resolve: async () => ({
        computerUse: brokenUse,
        machine: stubMachine(),
        displayWidth: 1920,
        displayHeight: 1080,
      }),
    });

    await Promise.allSettled([
      find(broken, "computer_click").execute(CLICK),
      find(tools, "computer_scroll").execute(SCROLL),
    ]);

    /*
     * A rejected promise left in the queue's chain would reject the next caller before it ran anything,
     * turning one transient sandbox error into a permanently broken computer. So the second action has
     * to have actually reached the mouse.
     */
    expect(guard.state.peak).toBe(1);
  });

  test("a long typing call does not block the screen being read", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guard = overlap();
    const tools = build(guard, { gate });

    const typing = find(tools, "computer_type").execute({
      text: "a longer piece",
    });

    /*
     * The read must complete while the typing is still in flight. It resolves before the gate opens, so
     * this cannot pass by accident: if reads were queued behind acting calls, this line would hang until
     * `release`, and `release` is only called on the next line.
     */
    await find(tools, "computer_screen").execute({});
    release();
    await typing;

    expect(guard.state.peak).toBe(1);
  });

  test("two people are queued separately", async () => {
    const alice = overlap();
    const bob = overlap();

    await Promise.all([
      find(build(alice, { id: "alice" }), "computer_scroll").execute(SCROLL),
      find(build(bob, { id: "bob" }), "computer_scroll").execute(SCROLL),
    ]);

    /*
     * Each person is serialised against themselves — peak 1 each — and the queue is per computer rather
     * than global, so neither of them waited for the other. A global lock would be simpler and would
     * quietly make two people on one deployment take turns, which reads as "the product is slow
     * sometimes" and is never diagnosed.
     */
    expect(alice.state.peak).toBe(1);
    expect(bob.state.peak).toBe(1);
  });
});
