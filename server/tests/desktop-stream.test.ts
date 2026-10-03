import { describe, expect, test } from "bun:test";
import {
  applyDesktopInput,
  createDesktopInputQueue,
  type DesktopComputerUse,
} from "../src/computer/desktop-stream";

function fake() {
  const calls: string[] = [];
  const cu = {
    screenshot: {
      takeCompressed: async () => ({ screenshot: "BASE64JPEG" }),
      takeFullScreen: async () => ({ screenshot: "x" }),
    },
    mouse: {
      move: async (x: number, y: number) => void calls.push(`move ${x},${y}`),
      click: async (x: number, y: number, b?: string, d?: boolean) =>
        void calls.push(`click ${x},${y} ${b} ${d}`),
      scroll: async (x: number, y: number, dir: string, amt?: number) =>
        void calls.push(`scroll ${x},${y} ${dir} ${amt}`),
    },
    keyboard: {
      type: async (t: string) => void calls.push(`type ${t}`),
      press: async (k: string) => void calls.push(`press ${k}`),
      hotkey: async () => {},
    },
    display: {
      getInfo: async () => ({
        displays: [{ width: 1920, height: 1080, isActive: true }],
      }),
    },
  } as unknown as DesktopComputerUse;
  return { cu, calls };
}

test("a click is moved to and then clicked, and coordinates are clamped", async () => {
  const { cu, calls } = fake();
  await applyDesktopInput(
    cu,
    JSON.stringify({
      type: "mouse",
      event: "pressed",
      x: 5000,
      y: -20,
      button: "right",
    }),
  );
  expect(calls).toEqual(["move 1920,0", "click 1920,0 right false"]);
});

test("a double click says so", async () => {
  const { cu, calls } = fake();
  await applyDesktopInput(
    cu,
    JSON.stringify({
      type: "mouse",
      event: "pressed",
      x: 10,
      y: 10,
      clickCount: 2,
    }),
  );
  expect(calls[1]).toContain("true");
});

test("scroll direction comes from the sign of the delta", async () => {
  const { cu, calls } = fake();
  await applyDesktopInput(
    cu,
    JSON.stringify({ type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: -300 }),
  );
  expect(calls[0]).toContain("up");
  const b = fake();
  await applyDesktopInput(
    b.cu,
    JSON.stringify({ type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 400 }),
  );
  expect(b.calls[0]).toContain("down");
});

test("text and keys reach the keyboard", async () => {
  const { cu, calls } = fake();
  await applyDesktopInput(cu, JSON.stringify({ type: "text", text: "hello" }));
  await applyDesktopInput(
    cu,
    JSON.stringify({ type: "key", event: "down", key: "Enter" }),
  );
  expect(calls).toEqual(["type hello", "press Enter"]);
});

test("input that cannot be honoured is refused loudly, not dropped", async () => {
  // A silently ignored click is the worst failure for someone who believes they hold the wheel.
  const { cu } = fake();
  await expect(applyDesktopInput(cu, "not json")).rejects.toThrow(
    /not readable/,
  );
  await expect(
    applyDesktopInput(cu, JSON.stringify({ type: "telepathy" })),
  ).rejects.toThrow(/not something/);
});

/**
 * The input queue, which is the whole of "the live stream does not work properly".
 *
 * Every case here is a real failure that was reported and is not hypothetical. The shape of the
 * tests is deliberate: they assert ORDER and CALL COUNT, because those are the two properties whose
 * absence makes a remote desktop feel broken while every individual call still succeeds.
 */
describe("input ordering and coalescing", () => {
  const move = (x: number, y: number) =>
    JSON.stringify({ type: "mouse", event: "moved", x, y });
  const down = (x: number, y: number) =>
    JSON.stringify({ type: "mouse", event: "pressed", x, y });
  const up = (x: number, y: number) =>
    JSON.stringify({ type: "mouse", event: "released", x, y });

  test("messages are applied in the order they were sent", async () => {
    // Independent promises racing is what made a desktop get a key-up before its key-down, leaving a
    // modifier stuck down. A press followed by a release must not be able to land in the other order.
    const applied: string[] = [];
    const queue = createDesktopInputQueue(async (raw) => {
      // Deliberately slow and jittery, so anything running concurrently finishes out of order.
      await Bun.sleep(String(raw).length % 3 === 0 ? 4 : 1);
      applied.push(raw);
    });
    await Promise.all([
      queue.push(down(1, 1)),
      queue.push(up(1, 1)),
      queue.push(down(2, 2)),
    ]);
    expect(applied).toEqual([down(1, 1), up(1, 1), down(2, 2)]);
  });

  test("one move at a time is in flight, and the newest position wins", async () => {
    // A drag fires a mousemove per pointer event — about sixty a second — and each was its own
    // Daytona round trip, so the pointer arrived seconds after the hand stopped moving.
    const applied: string[] = [];
    let inFlight = 0;
    let overlapped = false;
    const queue = createDesktopInputQueue(async (raw) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await Bun.sleep(5);
      applied.push(raw);
      inFlight -= 1;
    });
    for (let x = 0; x < 40; x += 1) void queue.push(move(x, 100));
    // Let the queue drain, including the one move still waiting behind the in-flight one.
    await Bun.sleep(200);
    expect(overlapped).toBe(false);
    /*
     * Far fewer than 40, and the LAST one is the final position. Both halves matter: the count is
     * the latency saving, and the last value is correctness — the pointer must end up where the
     * hand is, not where it was forty events ago.
     */
    expect(applied.length).toBeLessThan(10);
    expect(applied.at(-1)).toBe(move(39, 100));
  });

  test("nothing that changes something is ever dropped", async () => {
    // The licence for coalescing rests entirely on this. A dropped move is invisible; a dropped
    // press is a click that did not happen, and the person holding the wheel would conclude the
    // desktop froze.
    const applied: string[] = [];
    const queue = createDesktopInputQueue(async (raw) => {
      await Bun.sleep(2);
      applied.push(raw);
    });
    const key = JSON.stringify({ type: "key", event: "down", key: "a" });
    const keyUp = JSON.stringify({ type: "key", event: "up", key: "a" });
    void queue.push(move(1, 1));
    void queue.push(key);
    void queue.push(move(2, 2));
    void queue.push(keyUp);
    await Bun.sleep(120);
    expect(applied).toContain(key);
    expect(applied).toContain(keyUp);
    expect(applied.indexOf(key)).toBeLessThan(applied.indexOf(keyUp));
  });

  test("a move waits behind a click rather than overtaking it", async () => {
    // The pointer arriving before the button it was aiming for is the specific "click did not
    // happen" failure. Coalescing must not let a move skip the queue.
    const applied: string[] = [];
    const queue = createDesktopInputQueue(async (raw) => {
      await Bun.sleep(6);
      applied.push(raw);
    });
    void queue.push(down(10, 10));
    void queue.push(move(11, 11));
    await Bun.sleep(120);
    expect(applied.indexOf(down(10, 10))).toBeLessThan(
      applied.indexOf(move(11, 11)),
    );
  });

  test("one failing message does not stop the ones behind it", async () => {
    // A desktop that was asleep failed the first message. The person must still get their next
    // forty keystrokes rather than each reporting the same stale error.
    //
    // A click, not a move, and that is the honest shape of the case: a move is fire-and-forget and
    // its failure is swallowed deliberately (see the queue), so what tells the person their input
    // did nothing is the click that follows it. Which is exactly what happens — they move the mouse,
    // it does not arrive, they click, and the click is what reports.
    const applied: string[] = [];
    let attempts = 0;
    const queue = createDesktopInputQueue(async (raw) => {
      attempts += 1;
      // Only the FIRST attempt fails. Keyed on attempts rather than on `applied.length`, because the
      // first message throws before it can record anything — which is the whole shape of the bug.
      if (attempts === 1) throw new Error("This computer is not running.");
      applied.push(raw);
    });
    await expect(queue.push(down(1, 1))).rejects.toThrow("not running");
    await queue.push(down(2, 2));
    expect(applied).toEqual([down(2, 2)]);
  });

  test("unparseable input is left alone so it can be refused by name", async () => {
    // `applyDesktopInput` refuses an unknown shape loudly, which is what tells a person holding the
    // wheel their keystroke did nothing. Coalescing it into oblivion would lose that.
    const seen: string[] = [];
    const queue = createDesktopInputQueue(async (raw) => void seen.push(raw));
    await queue.push("{not json");
    expect(seen).toEqual(["{not json"]);
  });
});
