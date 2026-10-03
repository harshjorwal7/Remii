import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

let holder = "bot";
let streamCalls = 0;
let streamFails = false;
let screenshotOk = true;

/*
 * `globalThis.fetch`, NOT `mock.module("@/lib/client")`.
 *
 * `mock.module` is process-wide in bun, so replacing a module here would replace it for every other
 * test file in the same run — which is exactly what happened: `computer-problem-card.test.tsx` began
 * failing against this file's endpoints. Stubbing fetch is local, and it is what the other test in
 * this area already does for the same reason.
 */
const json = (body: unknown, ok = true) =>
  new Response(JSON.stringify(body), {
    status: ok ? 200 : 503,
    headers: { "content-type": "application/json" },
  });

function answerEndpoints(input: unknown) {
  const path = String(input);
  if (path.includes("/desktop/stream")) {
    streamCalls += 1;
    return json(
      streamFails
        ? { error: "This computer is not running." }
        : {
            url: "https://6080-sbx-abc.e2b.app/vnc.html",
            authKey: "pw",
            width: 1920,
            height: 1080,
          },
      !streamFails,
    );
  }
  if (path.includes("/screenshot")) {
    return screenshotOk
      ? json({ frame: { base64: "AAAA", width: 1, height: 1, capturedAt: "" } })
      : json({ error: "The screen is not available right now." }, false);
  }
  /*
   * The wheel routes are a real state change: taking it records the person as the holder, and that is
   * what `driving` is derived from. An endpoint that always answered "bot" would make these tests pass
   * for the wrong reason — the iframe would mount because of `showLiveScreen`, not because the person
   * took the wheel.
   */
  if (path.endsWith("/control/take")) {
    holder = "human";
    return json({ holder: "human", since: "", requested: false });
  }
  if (path.endsWith("/control/release")) {
    holder = "bot";
    return json({ holder: "bot", since: "", requested: false });
  }
  return json({ holder, requested: false });
}

let restore: () => void = () => {};
beforeAll(() => {
  GlobalRegistrator.register();
  // `usePageVisible` reads this, and happy-dom does not report a visible document on its own. With it
  // false, `visualVisible` is false for the whole test and the warming effect is skipped for a reason
  // that has nothing to do with the code under test.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  document.dispatchEvent(new Event("visibilitychange"));
  const f = globalThis.fetch,
    io = globalThis.IntersectionObserver,
    ctx = HTMLCanvasElement.prototype.getContext;
  globalThis.fetch = (async (input: unknown) =>
    answerEndpoints(input)) as never;
  // Reports intersecting immediately, so a tile counts as VISIBLE. `visualVisible` gates the warming,
  // and a stub that never fires would leave the tile permanently off-screen and silently skip it.
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
  HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage() {},
  })) as never;
  restore = () => {
    globalThis.fetch = f;
    if (io) globalThis.IntersectionObserver = io;
    HTMLCanvasElement.prototype.getContext = ctx;
  };
});
afterEach(() => {
  // The wheel state is module-scoped here because the mock is, and a test that took control left
  // "human" behind — so the next test started out already driving and asserted things about a
  // screen it had not opened. Reset explicitly rather than trusting the order.
  cleanup();
  holder = "bot";
  streamCalls = 0;
  streamFails = false;
  screenshotOk = true;
});

afterAll(() => {
  restore();
  cleanup();
  // The DOM is taken away again. Bun walks every test file into ONE process, so leaving happy-dom
  // registered makes the NEXT file's `register()` throw "already been globally registered" — which
  // surfaces as an unnamed failure attributed to whichever file happened to run next.
  GlobalRegistrator.unregister();
});

async function mount(props: {
  computerId: string;
  name?: string;
  active?: boolean;
  finished?: boolean;
}) {
  const { ComputerView } = await import("@/components/computer/computer-view");
  const view = render(<ComputerView {...props} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
  return view;
}

/**
 * THE REPORTED BUGS, AS TESTS.
 *
 * "The E2B live screen is not visible and take control doesn't work — even when the user takes control
 * it should be live." Three separate causes, all of which had to be true at once to produce that
 * sentence, and all three of which are reproduced below rather than described.
 *
 * A fourth one lives on the server and is covered in `server/tests/e2b-resume.test.ts`: the RFB
 * password was held on a transient SDK object, so the first open of the screen worked and every one
 * after it threw. From a browser that is indistinguishable from "the screen is not available".
 */

/**
 * THE REPORT, AS A TEST.
 *
 * "The live screen is not visible and take control doesn't work." Every part of that is reproduced
 * here, on a FINISHED turn, which is what almost every turn a person looks at is:
 *
 *  1. `showLiveScreen` was `!settled && ...`, so a finished turn mounted a still image and never a
 *     screen. 2. The footer was `{settled ? null : ...}`, so the Take control button did not exist
 *     either — there was nowhere to press. 3. Even where it was reachable, taking the wheel changed
 *     nothing on screen, while the server recorded the person as the holder and the Bot began refusing
 *     its own actions. Every signal said it had worked and no pixel moved.
 */
test("take control on a FINISHED turn exists, and puts the LIVE desktop on screen", async () => {
  streamCalls = 0;
  streamFails = false;
  screenshotOk = true;

  const view = await mount({
    computerId: "bot-1",
    name: "Bot",
    finished: true,
  });
  fireEvent.click(
    view.container.querySelector<HTMLElement>(
      'button[aria-label="Open the assistant\'s screen full size"]',
    ) as HTMLElement,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });

  const buttons = () =>
    [...document.querySelectorAll("button")].map((b) => b.textContent?.trim());
  // (2) The button has to be there at all.
  expect(buttons(), "Take control is offered on a finished turn").toContain(
    "Take control",
  );

  fireEvent.click(
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Take control",
    ) as HTMLElement,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });

  // (1) and (3) The live desktop replaces the record the moment the wheel is taken.
  expect(
    document.querySelector("iframe"),
    "the LIVE desktop is mounted after taking control",
  ).toBeTruthy();
  // And the person can give it back, which is the other half of the same claim.
  expect(buttons()).toContain("Hand back");
  cleanup();
});

test("a running turn warms the session, so taking the wheel does not wait for a round trip", async () => {
  streamCalls = 0;
  const view = await mount({ computerId: "bot-1", name: "Bot", active: true });

  // Opened, and NOT yet taken control — this is the gap the warming fills. On a paused desktop this
  // request is a resume, so without warming it the person waits for one between clicking and seeing.
  fireEvent.click(
    view.container.querySelector<HTMLElement>(
      'button[aria-label="Open the assistant\'s screen full size"]',
    ) as HTMLElement,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80));
  });

  expect(
    streamCalls,
    "the session was fetched before anybody asked to drive",
  ).toBeGreaterThan(0);
  // And nothing has been handed over yet: warming is not taking the wheel.
  expect(
    [...document.querySelectorAll("button")].map((b) => b.textContent?.trim()),
  ).not.toContain("Hand back");
  cleanup();
});
