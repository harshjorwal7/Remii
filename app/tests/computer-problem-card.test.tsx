import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ComputerView } from "@/components/computer/computer-view";

/**
 * What the card says when there is no screen to show.
 *
 * The card said it twice. Expanding the view draws the full-size surface over the card rather than
 * replacing it, so both were mounted and both rendered the reason — "The screen is not available right
 * now." immediately followed by itself, with nothing between them to tell the two apart. It read as
 * the card failing to understand rather than as a report of anything.
 *
 * It also used to say it three times in one place: a headline, the reason, and then a line telling
 * the reader to check whether the computer was running — directly underneath a reason that had just
 * reported it was not. The reason is a finished sentence written by whoever set it, so it is shown
 * once, as written, and nothing else is said about it.
 */

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: SocketDouble | undefined;

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: string) {
    SocketDouble.latest = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(_payload: string) {}
  close() {
    this.readyState = SocketDouble.CLOSED;
    this.onclose?.();
  }
}

let originalWebSocket: typeof WebSocket;
let originalFetch: typeof fetch;
let originalCreateImageBitmap: typeof createImageBitmap | undefined;
let originalIntersectionObserver: typeof IntersectionObserver | undefined;
let originalCanvasGetContext: typeof HTMLCanvasElement.prototype.getContext;
let originalImageDecode: typeof HTMLImageElement.prototype.decode | undefined;

/** Who the desktop says is holding the wheel. Changed mid-test to let the wheel go. */
let holder: "bot" | "human" | null = "human";

/**
 * Answers both endpoints the card asks for.
 *
 * happy-dom sits on about:blank, where a relative URL cannot be turned into a Request, so leaving
 * these to fail would throw out of the render rather than produce a card to read.
 *
 * `holder: "human"` is what opens the live socket: `driving` IS `holder === "human"`, and the socket
 * only exists in the expanded view. A screenshot is answered as a 1x1 PNG so the card has a frame to
 * draw and is not busy saying it has none.
 */
/**
 * What the live-screen route answers with, so a test can make the screen fail without a socket.
 *
 * The screen is noVNC now, so there is nothing to inject an error into at runtime: the server answers
 * `GET /api/computers/desktop/stream` once, and the browser opens the desktop itself from there. A test
 * that wants a broken screen sets this and lets the component fetch it, which is the same path a person
 * hits. It replaces a WebSocket double that sent a `{type:"error"}` frame into a socket that no longer
 * exists.
 */
let streamFailure: string | null = null;

function answerEndpoints() {
  const pixel =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/desktop/stream")) {
      // Refused with a status, because that is how the route reports a desktop it cannot open, and
      // the component reads the sentence out of the body rather than inventing one.
      return new Response(JSON.stringify({ error: streamFailure ?? "OK" }), {
        status: streamFailure ? 503 : 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/screenshot")) {
      /*
       * A READABLE frame, and this matters to the scenario below.
       *
       * The still-frame poll and the live screen are two independent sources, and `computer-view` keeps
       * ONE `problem` for both, so the last writer wins. Answering this route with a broken frame as
       * well would put "The screen is not available right now." into the same slot as whatever reason
       * the live screen reported, and which sentence survived would be a race rather than a decision.
       * With one failing source and one healthy one, the reason under test is the one on screen — which
       * is what "every reason the server can send is said once" is actually asking.
       *
       * The shape also has to be the real one. A frame without `width`/`height` is refused by the
       * parser, which is correct — those dimensions scale every coordinate read off the picture — and
       * would quietly reintroduce the same ambiguity this comment is about.
       */
      return new Response(
        JSON.stringify({
          frame: { base64: pixel, width: 1, height: 1, capturedAt: "" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ holder }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

beforeAll(() => {
  GlobalRegistrator.register();
  originalWebSocket = globalThis.WebSocket;
  originalCreateImageBitmap = globalThis.createImageBitmap;
  originalFetch = globalThis.fetch;
  originalIntersectionObserver = globalThis.IntersectionObserver;
  originalCanvasGetContext = HTMLCanvasElement.prototype.getContext;
  originalImageDecode = HTMLImageElement.prototype.decode;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  globalThis.createImageBitmap = (async () => ({
    width: 320,
    height: 200,
    close() {},
  })) as typeof createImageBitmap;
  HTMLCanvasElement.prototype.getContext = (() =>
    ({
      drawImage: () => {},
    }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  answerEndpoints();
});

afterEach(() => {
  cleanup();
  SocketDouble.latest = undefined;
  holder = "human";
  streamFailure = null;
  answerEndpoints();
  if (originalCreateImageBitmap) {
    globalThis.createImageBitmap = originalCreateImageBitmap;
  }
  HTMLCanvasElement.prototype.getContext = originalCanvasGetContext;
  if (originalImageDecode) {
    HTMLImageElement.prototype.decode = originalImageDecode;
  }
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  if (originalIntersectionObserver) {
    globalThis.IntersectionObserver = originalIntersectionObserver;
  }
  if (originalCreateImageBitmap) {
    globalThis.createImageBitmap = originalCreateImageBitmap;
  }
  HTMLCanvasElement.prototype.getContext = originalCanvasGetContext;
  if (originalImageDecode) {
    HTMLImageElement.prototype.decode = originalImageDecode;
  }
  GlobalRegistrator.unregister();
});

/** Everything the card has to say, as one string, so a repetition reads as a repetition. */
function visibleText(): string {
  return (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** How many times a sentence appears, counted as whole occurrences rather than as a substring. */
function timesSaid(sentence: string): number {
  return visibleText().split(sentence).length - 1;
}

/** The card's own wording for a screen it cannot read. */
const SERVER_SENTENCE = "The screen is not available right now.";

/**
 * Opens the full-size view, which is the only place the live socket exists.
 *
 * The order matters and is the whole scenario: a person looks closer at a screen that is already
 * broken, the stream reports why, and the reason is then shown by two mounted surfaces at once.
 */
async function expandAndReportAProblem(error: string) {
  /*
   * The route is made to fail BEFORE the view opens, rather than the failure being pushed down a socket
   * afterwards. That ordering is the honest one now: the screen is a single request that either hands
   * over a desktop or explains why it cannot, and there is no long-lived connection whose failure could
   * arrive later. Everything else about the scenario is unchanged — the person opens the full-size view,
   * the reason appears, and the two mounted surfaces must agree on it.
   */
  streamFailure = error;
  answerEndpoints();
  render(<ComputerView computerId="remii" active />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  fireEvent.click(
    document.querySelector<HTMLElement>(
      'button[aria-label="Open the assistant\'s screen full size"]',
    ) as HTMLElement,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

test("a screen that cannot be read is reported once, not twice", async () => {
  await expandAndReportAProblem(SERVER_SENTENCE);

  expect(timesSaid(SERVER_SENTENCE)).toBe(1);
});

test("the reason is not wrapped in a headline and a footer that contradict it", async () => {
  await expandAndReportAProblem(SERVER_SENTENCE);
  const text = visibleText();

  /*
   * These are the two lines that made the card argue with itself. "This computer is not running."
   * followed by "Check whether its computer is running" is not repetition, it is a report telling the
   * reader to check the thing it has just said is off, and the only sensible next move — go and look
   * — leads away from the answer that was already given.
   */
  expect(text).not.toContain("You cannot see the screen right now");
  expect(text).not.toContain("Check whether its computer is");
  expect(text).not.toContain("The assistant may still be working");
});

test("every reason the server can send is said once, whatever it is", async () => {
  /*
   * Each of these is a finished sentence with a different cause in it, and each arrives the same way.
   * The bug was not tied to one message, so the fix cannot be either: what has to hold is that the
   * card adds nothing of its own to what it was told.
   */
  const reasons = [
    "This computer is not running.",
    "The live screen could not be reached.",
    "The screen could not be read.",
    "Your computer is waking up.",
  ];

  for (const reason of reasons) {
    cleanup();
    SocketDouble.latest = undefined;
    await expandAndReportAProblem(reason);
    expect(timesSaid(reason)).toBe(1);
  }
});

test("nothing about the computer is hidden by hiding the card's explanation", async () => {
  // The badges label the computer and say who has their hands on it. They are not a report about the
  // screen, they are the one part of the card worth reading through a backdrop, and hiding them with
  // the explanation would have been a fix that cost something real.
  await expandAndReportAProblem(SERVER_SENTENCE);
  const text = visibleText();

  expect(text).toContain("You have control");
});
