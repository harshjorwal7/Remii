/**
 * The user's screen, and the Bot's hands on it.
 *
 * WHY THE LIVE SCREEN IS NOT HERE ANY MORE
 *
 * This file used to contain the whole live screen: a loop that called the provider's screenshot API
 * once per frame, base64'd the JPEG and pushed it down a websocket for the browser to decode. It is
 * worth recording what that cost, because it was the reason taking control felt broken and the reason
 * replacing it was worth the work.
 *
 * Every frame cost a full round trip to a remote machine before a single pixel was drawn. The loop
 * could not run faster than those round trips, so the frame rate was the platform's latency rather
 * than a chosen number — 8fps was a CEILING that a distant sandbox never reached. Worse, every mouse
 * move a person made was a SECOND round trip, sent one at a time in strict order so that a click
 * could not overtake its own release. A person who took the wheel clicked, watched their pointer
 * stand still for the length of a frame, and clicked again. The desktop was never frozen; it was a
 * slideshow of the past, plus a mouse that arrived seconds after the hand stopped moving.
 *
 * The screen is now noVNC over RFB, straight from the desktop to the browser. The server hands over a
 * URL and a per-session VNC password and is not in the data path at all: the stream sends only the
 * rectangles that changed, and input reaches the desktop without passing through this process. See
 * {@link DesktopStreamSession} and `ensureStream` in `provisioner.ts`.
 *
 * WHAT STAYS HERE, AND WHY IT IS STILL NEEDED
 *
 * The Bot's input. A noVNC client is a person's hands; a Bot driving the same desktop goes through
 * `applyDesktopInput` against the same `DesktopComputerUse` interface, and it needs the ordering and
 * coalescing that {@link createDesktopInputQueue} provides. That was the single best piece of reasoning
 * in the old stream — "only pointer moves are safe to drop" — and it does not stop being true because
 * the frames moved.
 *
 * The types stay too, and for the reason they were declared locally rather than imported: the tools
 * can be tested without a sandbox, and the coupling to one SDK version is one small interface.
 */

/**
 * What the browser needs to open the live screen.
 *
 * `url` is the noVNC page and `authKey` is the RFB password for it, returned SEPARATELY rather than
 * folded into the URL. That separation is deliberate: a URL is what ends up in a proxy log, a browser
 * history and a `Referer` header, and a credential that travels in one is a credential that leaks.
 * The client appends it when it actually needs to connect.
 *
 * `authKey` is not the E2B account key. It is a 16-character string minted by x11vnc when the stream
 * is started and dead when the stream stops, and knowing it buys control of that one desktop until it
 * is restarted. The account key never leaves the server process at all.
 */
export type DesktopStreamSession = {
  url: string;
  authKey: string;
  /** The desktop's real geometry, because a click's coordinates are read against it. */
  width: number;
  height: number;
};

/** Why a live screen could not be opened, as a sentence the person can act on. */
export type DesktopStreamError = { type: "error"; error: string };

export type DesktopInput =
  | {
      type: "mouse";
      event: "pressed" | "released" | "moved";
      x: number;
      y: number;
      button?: string;
      clickCount?: number;
    }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | {
      type: "key";
      event: "down" | "up";
      key: string;
      code?: string;
      text?: string;
    }
  | { type: "text"; text: string };

/**
 * The slice of a computer-use API this file uses — an E2B desktop, via `computerUseFor`.
 *
 * Declared here rather than importing the SDK's types so the streaming logic can be tested without
 * a sandbox, and so the coupling to a specific SDK version is one small, visible interface.
 */
export type DesktopComputerUse = {
  screenshot: {
    /**
     * The one that matters for cost, and the reason the shape is here.
     *
     * `scale` multiplies the native resolution, so 0.667 of a 1920-wide desktop is a 1280-wide
     * picture for roughly a third of the tokens. `format: "png"` is available but is lossless and
     * therefore the most expensive option per pixel; JPEG at quality 60 is the default for that
     * reason, and the provider bills by AREA rather than by file size, so the saving comes from the
     * scale and not from the compression.
     */
    takeCompressed(options?: Record<string, unknown>): Promise<{
      screenshot?: string;
      cursorPosition?: { x: number; y: number };
    }>;
    /**
     * A rectangle of the screen.
     *
     * The cheapest way to read small text, and the reason it is declared rather than reached for
     * with a cast: a 400x300 crop of a form field costs a fraction of a full-screen shot, so a Bot
     * verifying a login form can afford to check as often as it likes.
     */
    takeCompressedRegion?(
      region: { x: number; y: number; width: number; height: number },
      options?: Record<string, unknown>,
    ): Promise<{
      screenshot?: string;
      cursorPosition?: { x: number; y: number };
    }>;
    takeFullScreen(showCursor?: boolean): Promise<{ screenshot?: string }>;
  };
  mouse: {
    move(x: number, y: number): Promise<unknown>;
    click(
      x: number,
      y: number,
      button?: string,
      double?: boolean,
    ): Promise<unknown>;
    /** Press at one point, release at another. Cheaper and steadier than move-press-move-release. */
    drag?(
      startX: number,
      startY: number,
      endX: number,
      endY: number,
      button?: string,
    ): Promise<unknown>;
    scroll(
      x: number,
      y: number,
      direction: "up" | "down",
      amount?: number,
    ): Promise<unknown>;
  };
  keyboard: {
    type(text: string, delay?: number): Promise<void>;
    press(key: string, modifiers?: string[]): Promise<void>;
    hotkey(keys: string): Promise<void>;
  };
  display: {
    getInfo(): Promise<{
      displays?: { width?: number; height?: number; isActive?: boolean }[];
    }>;
    /** What is open, which is the one thing a bare desktop's accessibility tree will not tell you. */
    getWindows(): Promise<{
      windows?: {
        id?: number;
        title?: string;
        x?: number;
        y?: number;
        isActive?: boolean;
      }[];
    }>;
  };
  /**
   * The live AT-SPI tree.
   *
   * Optional on this interface because the screen sampler does not need it, and a required member
   * the sampler never calls would be a lie about what it requires. The desktop tools treat it as
   * absent rather than crashing, because "this desktop has no accessibility tree" is a degraded
   * answer worth reporting rather than a crash worth throwing.
   */
  accessibility?: {
    getTree(options?: Record<string, unknown>): Promise<{ root?: unknown }>;
  };
};

/**
 * One frame, now.
 *
 * Split out of the stream so the still-frame route and the socket cannot disagree about how a
 * picture is taken. They used to be one thing and the poll asked a route that did not exist, so
 * the panel reported the screen unavailable while the socket was drawing the very same desktop a
 * few hundred bytes away.
 *
 * Returns `null` rather than throwing when there is no desktop, because "not running yet" is the
 * ordinary state of a sandbox that is still being provisioned, not a fault worth a stack.
 *
 * `size` IS PASSED IN, and that is the difference between a stream that works and one that does not.
 *
 * This used to call `display.getInfo()` on every single frame to learn the screen's dimensions. That
 * is a remote round trip — a real HTTP request to a machine in another data centre — placed in
 * front of the screenshot, so every frame cost two API calls instead of one and its latency was the
 * sum of both. That was the frame sampler's worst problem, and it is one of the reasons the screen is
 * noVNC now: nothing here asks the platform how big the desktop is, so there is nothing to get wrong.
 *
 * The geometry does not change while a desktop is up. It is already recorded on the row by
 * `recordGeometry`, and it is passed in rather than re-measured.
 */
export type DesktopFileInfo = {
  path: string;
  name?: string;
  isDirectory?: boolean;
  size?: number;
};

export type DesktopMachine = {
  /**
   * Run a command and return its output.
   *
   * `exitCode` is part of the answer rather than an error, because "the command ran and said no" is
   * information a Bot needs — a grep that found nothing, a diff that did not apply. Throwing on a
   * non-zero exit would make the most common outcome look like a fault.
   */
  exec(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeoutSeconds?: number,
  ): Promise<{ exitCode: number; stdout: string }>;
  /** The contents of a file, as text. Throws when it is not there, which is an answer too. */
  readFile(path: string): Promise<string>;
  /** Create or replace a file. Parent directories are the caller's problem, not an excuse to fail. */
  writeFile(path: string, contents: string): Promise<void>;
  /** One directory, shallow. Enough to answer "what is here" without walking a whole disk. */
  listFiles(path: string): Promise<DesktopFileInfo[]>;
};

/**
 * Is this message a pointer MOVE, which is the one kind that is safe to throw away?
 *
 * Only moves. Every other message — a press, a release, a key, a wheel notch, a text block — changes
 * something, and dropping one of those is a click that did not happen. A move only changes WHERE the
 * pointer is, so a dropped move is invisible: the next move puts it in the right place anyway. That
 * distinction is the entire licence this coalescing has.
 */
function isCoalescableMove(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; event?: unknown };
    return parsed?.type === "mouse" && parsed?.event === "moved";
  } catch {
    // Unparseable input is left alone so `applyDesktopInput` can refuse it by name, which is the
    // behaviour the person holding the wheel needs: told their input did nothing.
    return false;
  }
}

/**
 * One socket's input, in the order it was sent, with pointer moves collapsed.
 *
 * THE PROBLEM THIS SOLVES, CONCRETELY. The browser sends a `mousemove` on every pointer event, and a
 * person dragging a window from one side of the screen to the other produces about sixty of them in
 * a second. Each one was an independent `await` on a a remote round trip — a real HTTP request to a
 * remote machine — so the drag queued sixty of them, they completed out of order, and the pointer
 * arrived on the desktop seconds later than the person's hand stopped moving. The screen looked
 * frozen and then lurched. That is what "the live stream is not working properly" turned out to be,
 * and no amount of extra frames fixes it: the bottleneck was the input path, not the frame rate.
 *
 * TWO RULES, AND THEY ARE BOTH LOAD-BEARING:
 *
 * 1. Strict order, one at a time. Every message waits for the previous one to finish, so a press is
 *    never applied after the release that followed it. Independent promises racing is what produced
 *    stuck modifiers and dropped clicks.
 *
 * 2. At most one move in flight. A move arriving while another is being applied replaces it rather
 *    than queueing behind it — the pointer only has one position, and the newest one is the only one
 *    that matters. Everything else is kept, in order.
 *
 * `apply` is handed the resolved desktop rather than a resolver, because resolving is the expensive
 * part and this queue is per-socket while the desktop is per-person: two sockets from the same
 * person each keep their own ordering without each having to ask the platform anything.
 */
export type DesktopInputQueue = {
  /** Add a message. Resolves when THIS message has been applied. */
  push(raw: string): Promise<void>;
  /** Messages still waiting, for a test and for nothing else. */
  readonly pending: number;
};

export function createDesktopInputQueue(
  apply: (raw: string) => Promise<void>,
): DesktopInputQueue {
  let tail: Promise<void> = Promise.resolve();
  let move: { raw: string } | null = null;
  let movePending = false;
  let queued = 0;

  const runMove = () => {
    const next = move;
    move = null;
    if (!next) return;
    movePending = true;
    tail = tail
      .then(() => apply(next.raw))
      .catch(() => undefined)
      .then(() => {
        movePending = false;
        // A move that arrived while this one was in flight is applied now, not dropped.
        if (move) runMove();
      });
  };

  return {
    push(raw: string): Promise<void> {
      if (isCoalescableMove(raw)) {
        // Whatever was waiting is now out of date; only the newest position is worth a round trip.
        move = { raw };
        // Already in flight? Its completion handler picks this up. Otherwise start it now.
        if (!movePending) runMove();
        return tail;
      }
      queued += 1;
      const settled = tail.then(
        () => apply(raw),
        () => apply(raw),
      );
      /*
       * The chain continues past a failure; the CALLER is told about it.
       *
       * Two separate promises on purpose. `tail` is what the next message waits on, so it swallows
       * the rejection — otherwise one dead desktop would poison every message behind it and a person
       * holding the wheel would get the same stale error back for their next forty keystrokes. But
       * `settled` is returned as it is, so the socket handler learns that THIS message failed and
       * can say so. Swallowing both would make a failed click silently vanish, which is the worst
       * possible outcome for somebody who believes they are driving: the screen stops responding
       * and nothing says why.
       */
      tail = settled
        .catch(() => undefined)
        .then(() => {
          queued -= 1;
        });
      return settled.then(() => undefined);
    },
    get pending() {
      return queued;
    },
  };
}

/**
 * The desktop's real size, for clamping coordinates.
 *
 * A click is refused rather than nudged outside the screen, so the bounds have to be the screen's
 * own. They used to be a literal 1920x1080, which is correct only at the default resolution: on a
 * desktop configured to anything else a click at the right-hand edge was silently dropped and a
 * click low on the screen was clamped onto the wrong row — and a Bot reading a screen it then cannot
 * hit is the worst pairing there is.
 */
export type DesktopSize = { width: number; height: number };

const DEFAULT_SIZE: DesktopSize = { width: 1920, height: 1080 };

/**
 * Apply one input message to the desktop.
 *
 * Every shape the viewer sends is handled and every one that is not is refused loudly, because a
 * silently dropped click is the worst possible failure for a person who believes they are holding
 * the wheel: the screen stops responding and nothing says why.
 */
export async function applyDesktopInput(
  computerUse: DesktopComputerUse,
  raw: string,
  size: DesktopSize = DEFAULT_SIZE,
): Promise<void> {
  let message: DesktopInput;
  try {
    message = JSON.parse(raw) as DesktopInput;
  } catch {
    throw new Error("That input was not readable.");
  }
  if (typeof message?.type !== "string") {
    throw new Error("That input named no action.");
  }

  /*
   * A nonsense size falls back rather than clamping everything to zero. Reading a bad width off a
   * row that has not been measured yet should not turn every click into a no-op at the origin.
   */
  const maxX =
    Number.isFinite(size.width) && size.width > 0
      ? size.width
      : DEFAULT_SIZE.width;
  const maxY =
    Number.isFinite(size.height) && size.height > 0
      ? size.height
      : DEFAULT_SIZE.height;

  const clamp = (value: unknown) =>
    Math.max(0, Math.min(maxX, Math.round(Number(value) || 0)));
  const clampY = (value: unknown) =>
    Math.max(0, Math.min(maxY, Math.round(Number(value) || 0)));

  switch (message.type) {
    case "mouse": {
      const x = clamp((message as { x: number }).x);
      const y = clampY((message as { y: number }).y);
      await computerUse.mouse.move(x, y);
      if (message.event === "pressed") {
        const button = (message as { button?: string }).button ?? "left";
        const doubles = (message as { clickCount?: number }).clickCount ?? 1;
        await computerUse.mouse.click(x, y, button, doubles >= 2);
      }
      return;
    }
    case "wheel": {
      const deltaY = Number((message as { deltaY: number }).deltaY) || 0;
      // Scroll takes a direction and an amount rather than a signed delta, so the sign is what
      // picks the direction. Ignoring it would make scrolling up scroll down.
      if (deltaY === 0) return;
      await computerUse.mouse.scroll(
        clamp((message as { x: number }).x),
        clampY((message as { y: number }).y),
        deltaY < 0 ? "up" : "down",
        Math.max(1, Math.round(Math.abs(deltaY) / 100)),
      );
      return;
    }
    case "key": {
      const key = (message as { key: string }).key;
      if (typeof key === "string" && key) await computerUse.keyboard.press(key);
      return;
    }
    case "text": {
      const text = (message as { text: string }).text;
      if (typeof text === "string" && text)
        await computerUse.keyboard.type(text);
      return;
    }
    default: {
      // Reached only by a shape the union does not describe, which is exactly the case worth
      // refusing by name: the person pressing the button is told it did nothing.
      const named = (message as { type?: unknown }).type;
      throw new Error(
        `That input (${String(named)}) is not something this computer can do.`,
      );
    }
  }
}
