import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";

/**
 * THE SMALL SCREEN WAS NOT A SMALL SCREEN.
 *
 * The watch panel in the channel route is not a transcript tile. It has no `toolCallId`, so it was never
 * `settled`, which left `showLiveScreen` deciding everything on whether a still frame happened to have
 * arrived. It did not, at first: the panel drew nothing at all. Then one arrived, and the panel drew that
 * same still — for as long as it stayed open — while polling a screenshot of the person's one shared
 * desktop once a second.
 *
 * That is a screenshot of a screen, not the screen. It lagged the Bot by up to a second, could not show a
 * drag or a scroll mid-gesture, and was badged with the Bot's name while depicting whatever the desktop
 * was showing. "It should move according to what the Bot is working on" is a real requirement, and no
 * amount of polling satisfies it — the fix is to attach to the desktop over the live stream while a run
 * is going, which is what these tests hold in place.
 *
 * The second half is the load it cost. `active` means "keep this surface alive", not "the Bot is
 * working", and reading it as the latter made an idle panel capture a full-resolution screenshot per
 * second, per mounted panel, forever — against a machine that is billed by the hour it is on. So the poll
 * stopping when nothing is happening is asserted as carefully as the live stream appearing.
 */

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

let screenshotCalls = 0;
let streamCalls = 0;

function answerEndpoints(input: unknown) {
  const path = String(input);
  if (path.includes("/desktop/stream")) {
    streamCalls += 1;
    return json({
      url: "https://6080-sbx-abc.e2b.app/vnc.html",
      authKey: "pw",
      width: 1920,
      height: 1080,
    });
  }
  if (path.includes("/desktop/screenshot")) {
    screenshotCalls += 1;
    return json({
      frame: { base64: "AAAA", width: 1, height: 1, capturedAt: "" },
    });
  }
  if (path.endsWith("/control/take"))
    return json({ holder: "human", since: "", requested: false });
  if (path.endsWith("/control/release"))
    return json({ holder: "bot", since: "", requested: false });
  return json({ holder: "bot", requested: false });
}

let restore: () => void = () => {};
beforeAll(() => {
  GlobalRegistrator.register();
  // `usePageVisible` reads this, and happy-dom does not report a visible document on its own. Without
  // it `visualVisible` is false throughout and the poll never starts — for a reason that has nothing to
  // do with the behaviour under test.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  document.dispatchEvent(new Event("visibilitychange"));

  const f = globalThis.fetch;
  const io = globalThis.IntersectionObserver;
  globalThis.fetch = (async (input: unknown) =>
    answerEndpoints(input)) as never;
  // Intersecting immediately, so the tile counts as VISIBLE. A stub that never fires would leave it
  // permanently off-screen and skip the code entirely while the test reported success.
  globalThis.IntersectionObserver = class {
    constructor(private cb: (entries: unknown[], observer: unknown) => void) {}
    observe(target: unknown) {
      queueMicrotask(() =>
        this.cb([{ isIntersecting: true, target, intersectionRatio: 1 }], this),
      );
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as never;
  restore = () => {
    globalThis.fetch = f;
    if (io) globalThis.IntersectionObserver = io;
  };
});

afterEach(() => {
  cleanup();
  screenshotCalls = 0;
  streamCalls = 0;
});

afterAll(() => {
  restore();
  cleanup();
  // Unregistered again: bun walks every test file into ONE process, so leaving happy-dom installed
  // makes the NEXT file's `register()` throw, surfacing as an unnamed failure in an unrelated suite.
  GlobalRegistrator.unregister();
});

type ComputerViewProps = {
  computerId: string;
  active?: boolean;
  followingRun?: boolean;
  name?: string;
  finished?: boolean;
};

async function mount(props: ComputerViewProps) {
  const { ComputerView } = await import("@/components/computer/computer-view");
  const View = ComputerView as ComponentType<ComputerViewProps>;
  const view = render(<View {...props} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  return view;
}

const hasLiveScreen = (container: HTMLElement) =>
  container.querySelector("iframe") !== null;
const hasStillFrame = (container: HTMLElement) =>
  container.querySelector('img[alt="What the assistant is looking at"]') !==
  null;

describe("the watch panel, which has no turn of its own", () => {
  test("shows the live stream while a run is going, with no still frame to begin with", async () => {
    /*
     * THE ORDERING THAT MATTERS. `showLiveScreen` used to be `!settled && showScreen`, and `showScreen`
     * needed a still frame — which is why the panel was blank until one arrived and frozen afterwards.
     * Asserted with `screenshotCalls` deliberately allowed to be zero: a live screen must not depend on
     * a JPEG having landed first, or it is still a sampled picture wearing a live screen's clothes.
     */
    const { container } = await mount({
      computerId: "panel-bot",
      followingRun: true,
      name: "Panel Bot",
    });

    await waitFor(() => expect(hasLiveScreen(container)).toBe(true));
    expect(hasStillFrame(container)).toBe(false);
  });

  test("opens the live stream rather than only reporting a screen it could have sampled", async () => {
    const { container } = await mount({
      computerId: "panel-bot",
      followingRun: true,
      name: "Panel Bot",
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    await waitFor(() => expect(streamCalls).toBeGreaterThan(0));
  });

  test("falls back to a still when nothing is running, which is a picture and not a stream", async () => {
    /*
     * A panel nobody is running anything in has nothing to stream and should not hold a connection to a
     * machine that is doing nothing. The still is the right surface for "this is what the desktop looks
     * like", and it costs one capture rather than a live RFB session.
     */
    const { container } = await mount({
      computerId: "panel-bot",
      followingRun: false,
      name: "Panel Bot",
    });

    await waitFor(() => expect(hasStillFrame(container)).toBe(true));
    expect(hasLiveScreen(container)).toBe(false);
  });

  test("stops sampling the desktop once nothing is happening", async () => {
    /*
     * The cost of getting the first fix wrong.
     *
     * `active` is passed `true` by the panel and means "keep this surface alive". Treating it as "the
     * Bot is working" captured a full-resolution screenshot every second, per mounted panel, for as long
     * as a person watched an idle conversation — against a machine billed by the hour it is switched on.
     *
     * Asserted as a RATE rather than a zero, because the component always fetches at least one frame
     * before it decides whether to continue; a test demanding zero calls would be demanding that the
     * panel never show the desktop at all.
     */
    await mount({ computerId: "panel-bot", followingRun: false });

    await waitFor(() => expect(screenshotCalls).toBeGreaterThan(0));
    const settledAt = screenshotCalls;

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });

    // One frame, then nothing: not a request per interval for as long as the panel is open.
    expect(screenshotCalls).toBe(settledAt);
  });

  test("stops sampling stills while a run is going, because the stream carries it", async () => {
    /*
     * The load half of the same change, and it is the half that was easy to get wrong in the other
     * direction.
     *
     * A live stream and a once-a-second screenshot of the same desktop are the same information at two
     * prices, and while the stream is up the poll buys nothing except a second round trip to a machine
     * that is billed by the hour. It kept running because `shouldContinue` still saw a live run through
     * `followingRun` and had no reason to stop — the two surfaces were each individually reasonable and
     * together they were wasteful.
     *
     * One capture to establish that a computer exists, then the stream. Asserted as a rate rather than a
     * zero for the same reason as the idle case: the component always fetches at least one frame before
     * deciding whether to continue.
     */
    const { container } = await mount({
      computerId: "panel-bot",
      followingRun: true,
      name: "Panel Bot",
    });

    await waitFor(() => expect(hasLiveScreen(container)).toBe(true));
    const whileStreaming = screenshotCalls;

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });

    expect(screenshotCalls).toBe(whileStreaming);
  });

  test("still reaches the live screen when the person takes the wheel, with nothing running", async () => {
    /*
     * The other half of the same expression, and it must survive the change: taking control is a claim
     * about the machine in front of this person NOW, so it wins over the still regardless of what is
     * running. Narrowing the live-screen rule to "only while a run is going" would silently disable Take
     * control on an idle conversation — which is the "take control doesn't work" half of the same bug.
     *
     * Driven through the server rather than a prop, because `driving` is derived from the control read and
     * a fixture that answered "human" unconditionally would pass for the wrong reason.
     */
    const { container } = await mount({
      computerId: "panel-bot",
      followingRun: false,
      name: "Panel Bot",
    });

    await waitFor(() => expect(hasStillFrame(container)).toBe(true));

    /*
     * OPENED FULL SIZE FIRST, THEN TAKEN.
     *
     * "Take control" lives in the full-size view, not on the small card — the deliberate arrangement the
     * component documents, since the wheel is worth offering where there is a page big enough to drive.
     * So this presses the same two things a person does: click the card to expand, then take the wheel.
     *
     * Driven through those affordances rather than by prop, because `driving` is derived from a control
     * read the server answers. A fixture that reported "human" unconditionally would pass for the wrong
     * reason and would not notice if the button stopped working at all.
     */
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Open the assistant\'s screen full size"]',
        )
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const takeControl = await waitFor(() => {
      const button = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === "Take control",
      );
      expect(button).toBeDefined();
      return button as HTMLButtonElement;
    });

    await act(async () => {
      takeControl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => expect(hasLiveScreen(container)).toBe(true));
  });
});
