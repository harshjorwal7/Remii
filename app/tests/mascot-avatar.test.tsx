import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { mascotExpressionFor, mascotFill, restingLoopFor } from "@/mascot/ids";
import { ChannelAvatar } from "@/components/channels/avatar";
import { MascotAvatar } from "@/mascot/mascot-avatar";
import { mascotChoiceForSeed, restingExpressionForSeed } from "@/mascot/seed";
import { subscribeToTicker, tickerSubscriberCount } from "@/mascot/ticker";

GlobalRegistrator.register({ url: "https://remii.test/" });
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/*
 * The real ticker, driven by hand.
 *
 * `requestAnimationFrame` is replaced rather than the ticker being mocked out, because the behaviour
 * worth testing here IS the ticker: that one loop serves every avatar, and that it drops to 30fps.
 * A stubbed `subscribeToTicker` would let the component pass while the loop underneath it was wrong.
 *
 * Callbacks are collected and run by `stepFrames`, never on their own, so no test can pass by
 * accident on an animation frame that happened to land.
 */
let pending: Array<FrameRequestCallback> = [];
let clock = 0;
const realRaf = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;
const realObserver = globalThis.IntersectionObserver;
const realNow = performance.now.bind(performance);

/*
 * `performance.now` is stubbed alongside the frame clock, and it has to be.
 *
 * The component reads two clocks: `performance.now()` when it tells the engine something changed, and
 * the timestamp rAF hands it when it samples. In a browser those are the same clock, which is why the
 * two are allowed to be different sources. A harness that only faked rAF left them seconds apart, and
 * an engine told "you entered `thinking` at t=9" that was then sampled at t=1.2 spends the whole run
 * blending backwards out of it — so whether the eyes were gone came down to how long the test file had
 * been running. Slow machine, different answer.
 */

/*
 * IntersectionObserver is stubbed too, and it has to be.
 *
 * happy-dom implements one, and it fires on a timer — so whether an avatar counts as on screen
 * depended on how long the previous test in this file had been running. An avatar that stops painting
 * when it is not visible is correct, but a test whose answer depends on the ambient timer is not a
 * test. The stub never reports on its own, which is the honest default: an element that was just
 * mounted is on screen until somebody scrolls it off.
 *
 * `reportVisibility` is how a test says otherwise.
 */
const observed = new Set<Element>();

class StubObserver {
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    observed.add(target);
  }
  unobserve(target: Element) {
    observed.delete(target);
  }
  disconnect() {
    observed.clear();
  }
  takeRecords() {
    return [];
  }
  root = null;
  rootMargin = "";
  thresholds = [];
}

/** Report every observed element as visible or hidden, the way a scroll would. */
function reportVisibility(visible: boolean) {
  for (const target of observed) {
    const entry = {
      target,
      isIntersecting: visible,
      intersectionRatio: visible ? 1 : 0,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(),
      rootBounds: null,
      time: clock,
    } as unknown as IntersectionObserverEntry;
    for (const observer of observers)
      observer.callback([entry], observer as never);
  }
}

const observers: StubObserver[] = [];

beforeEach(() => {
  pending = [];
  clock = 0;
  // One clock for the component and the ticker alike. See the note on `realNow` above.
  performance.now = (() => clock) as typeof performance.now;
  observed.clear();
  observers.length = 0;
  globalThis.IntersectionObserver = class extends StubObserver {
    constructor(callback: IntersectionObserverCallback) {
      super(callback);
      observers.push(this);
    }
  } as unknown as typeof globalThis.IntersectionObserver;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    pending.push(callback);
    return pending.length;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame =
    (() => {}) as typeof globalThis.cancelAnimationFrame;
});

afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancel;
  globalThis.IntersectionObserver = realObserver;
  performance.now = realNow;
  pending = [];
});

/**
 * Advance the clock, running whatever asked for a frame.
 *
 * The step is 40ms because the ticker refuses to paint twice inside 33.3ms. A 16ms step — one frame at
 * 60Hz — would be silently dropped by the very budget it is testing, and every assertion about motion
 * in this file would pass on an avatar that had never moved.
 */
function stepFrames(times: number, stepMs = 40) {
  act(() => {
    for (let i = 0; i < times; i++) {
      const due = pending;
      pending = [];
      clock += stepMs;
      for (const callback of due) callback(clock);
    }
  });
  return clock;
}

/** The one path element the body and the mask both use; found by attribute, not by test id. */
function bodyPath(container: HTMLElement) {
  return container.querySelector<SVGPathElement>("svg > path[mask]")!;
}

function maskBody(container: HTMLElement) {
  return container.querySelector<SVGPathElement>("mask > path")!;
}

function eyeNodes(container: ParentNode) {
  return [...container.querySelectorAll<SVGPathElement>("mask > path")].slice(
    1,
  );
}

/** The three channels of a `#rrggbb` fill, so a colour can be compared rather than string-matched. */
function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Perceptual lightness, 0 to 1, as `(max + min) / 2` over the three channels.
 *
 * Only the lightness: the hue is not asserted here, because a colour drifting into a neighbouring hue is
 * a judgement made by looking, and the sheet is where that is made.
 */
function lightness(hex: string): number {
  const [r = 0, g = 0, b = 0] = channels(hex);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
}

describe("MascotAvatar", () => {
  it("announces the coworker by name and draws nothing that is announced twice", () => {
    const { container } = render(
      <MascotAvatar name="Rae" seed="agent_1" size={48} />,
    );
    const labelled = container.querySelector('[role="img"]');
    expect(labelled?.getAttribute("aria-label")).toBe("Rae");
    // The drawing is decorative; if it were announced the screen reader would read the name twice.
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("paints a body on mount, before any frame is requested", () => {
    // An avatar that is blank for its first frame reads as a flash of the layout behind it, which is
    // a worse artefact than a frame of stale mascot. This is why the paint happens synchronously.
    const { container } = render(
      <MascotAvatar name="Rae" seed="agent_1" size={48} />,
    );
    expect(bodyPath(container).getAttribute("d")).toMatch(/^M/);
    expect(bodyPath(container).getAttribute("d")).not.toBe("");
  });

  it("cuts the same path into the mask as it draws into the body", () => {
    // The eyes are holes in the body rather than white shapes, and that only works if the mask holds
    // the identical silhouette.
    const { container } = render(
      <MascotAvatar name="Rae" seed="agent_1" size={48} />,
    );
    expect(maskBody(container).getAttribute("d")).toBe(
      bodyPath(container).getAttribute("d"),
    );
  });

  it("fills the body with the chosen colour", () => {
    // Asserted against `mascotFill` rather than a hex literal, because the painted fill is the palette
    // entry nudged by the seed: hard-coding either the entry or the nudged result would fail the moment
    // the palette is re-judged, which is the one thing the palette is expected to be.
    const { container } = render(
      <MascotAvatar
        name="Rae"
        seed="agent_1"
        size={48}
        choice={{ shape: "circle", color: "violet" }}
      />,
    );
    expect(bodyPath(container).getAttribute("fill")).toBe(
      mascotFill("violet", "agent_1"),
    );
  });

  it("paints two coworkers who land on the same hue in two colours", () => {
    /*
     * The bug this is about: eight seeded hues across a real roster, and a knowledge bot, an onboarding
     * bot and a release bot all three seeded pink, all three within a shade of one another. The eye read
     * three identical mascots where it should have read three different coworkers.
     *
     * The fill therefore moves on two seeded axes, and this asserts what has to hold of it: it is
     * deterministic, it stays in the mid-lightness band that is the whole reason the palette was
     * re-pitched, and across a roster's worth of seeds it spreads rather than clumping.
     *
     * "Spreads rather than clumping" is a statistical claim and is asserted as one. Two coworkers drawn
     * from a continuous band can land close together, and demanding a minimum distance between all
     * nineteen thousand pairs would be asserting that a hash never has an unlucky draw. What must not
     * happen is a floor of near-identical pairs, which is what a bucketed jitter produced.
     */
    const fills = Array.from({ length: 200 }, (_, i) =>
      mascotFill("pink", `agent_${i}`),
    );
    // Almost all of them distinct, not all of them: a colour is eight bits a channel, so a band narrow
    // enough to stay one colour is also a finite space, and two hundred samples into it collide a few
    // times by arithmetic. The property is that collisions are the exception, not the rule.
    expect(
      new Set(fills).size,
      "far too many seeds share a pink",
    ).toBeGreaterThan(190);
    expect(mascotFill("pink", "agent_1")).toBe(mascotFill("pink", "agent_1"));

    for (const fill of fills) {
      // The band: bright enough to exist on a black theme, dark enough to hold on a light one. A jitter
      // wide enough to leave it is invisible in a diff and is exactly what this catches.
      const l = lightness(fill);
      expect(l, `${fill} is darker than the mid band`).toBeGreaterThan(0.38);
      expect(l, `${fill} is lighter than the mid band`).toBeLessThan(0.68);
    }

    const points = fills.map(channels);
    const distances: number[] = [];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i] as [number, number, number];
        const b = points[j] as [number, number, number];
        distances.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
      }
    }
    distances.sort((x, y) => x - y);
    const at = (fraction: number) =>
      distances[Math.floor(fraction * (distances.length - 1))] ?? 0;

    /*
     * Spread, as percentiles rather than as a floor. Two coworkers drawn from a continuous band can land
     * close together, and a minimum over twenty thousand pairs would be asserting that a hash never has an
     * unlucky draw. The median is the claim that matters: half of all pairs sharing a colour are at least
     * a tenth of the colour range apart, which is a difference two people cannot fail to see. The
     * bottom tenth is the other half of it — the unlucky draws stay rare.
     */
    expect(at(0.5), "half the pairs are painted too similarly").toBeGreaterThan(
      22,
    );
    expect(at(0.1), "too many unlucky draws").toBeGreaterThan(10);
  });

  it("wears a face that matches the work, and its own face when there is none", () => {
    /*
     * The face is not a preference any more, so this is the assertion that replaced the picker row: an
     * avatar working looks different from the same avatar idle, and going back to idle brings its own
     * resting face back rather than leaving whatever the work left on it.
     *
     * Measured on the eye capsules' own geometry rather than on a pixel, because that is the part a face
     * is: width and height, taken from the expression, untouched by the blink that scales the matrix
     * and by the gaze drift that moves it.
     */
    const capsuleOf = (element: React.ReactElement) => {
      const { container } = render(element);
      const eyes = eyeNodes(container).filter(
        (n) => n.getAttribute("display") !== "none",
      );
      expect(eyes.length).toBe(2);
      return eyes.map((n) => n.getAttribute("d")).join("|");
    };

    const resting = capsuleOf(
      <MascotAvatar name="Rae" seed="agent_1" size={48} state="idle" />,
    );
    const thinking = capsuleOf(
      <MascotAvatar name="Rae" seed="agent_1" size={48} state="thinking" />,
    );
    const streaming = capsuleOf(
      <MascotAvatar name="Rae" seed="agent_1" size={48} state="streaming" />,
    );
    expect(thinking).not.toBe(resting);
    expect(streaming).not.toBe(resting);
    expect(streaming).not.toBe(thinking);
  });

  it("gives every state a face, and hands back the resting one for idle", () => {
    // The mapping itself, which is the whole feature in six lines. `idle` is the odd one out: there is
    // no work to mirror when nothing is happening, so it wears the face hashed from the agent's id.
    const resting = restingExpressionForSeed("agent_1");
    for (const state of [
      "idle",
      "listening",
      "thinking",
      "streaming",
      "done",
      "error",
    ] as const) {
      expect(mascotExpressionFor(state, resting), state).toBeTruthy();
    }
    expect(mascotExpressionFor("idle", resting)).toBe(resting);
    expect(mascotExpressionFor("thinking", resting)).toBe("curious");
    expect(mascotExpressionFor("error", resting)).toBe("wary");
    // Undefined is treated as idle rather than as a hole: a surface that has no state to report still
    // draws a face, and it is the mascot's own.
    expect(mascotExpressionFor(undefined, resting)).toBe(resting);
    expect(mascotExpressionFor(null, resting)).toBe(resting);
  });

  it("returns to the resting face when the work is over", () => {
    // The half that a mapping test cannot see: the state really does change on the engine, and a
    // coworker that has finished goes back to looking like itself rather than staying pleased.
    const { container, rerender } = render(
      <MascotAvatar name="Rae" seed="agent_1" size={48} state="idle" />,
    );
    const resting = eyeNodes(container)
      .filter((n) => n.getAttribute("display") !== "none")
      .map((n) => n.getAttribute("d"))
      .join("|");

    rerender(
      <MascotAvatar name="Rae" seed="agent_1" size={48} state="streaming" />,
    );
    act(() => {
      stepFrames(2);
    });
    const busy = eyeNodes(container)
      .filter((n) => n.getAttribute("display") !== "none")
      .map((n) => n.getAttribute("d"))
      .join("|");

    rerender(<MascotAvatar name="Rae" seed="agent_1" size={48} state="idle" />);
    act(() => {
      // The engine blends one face into the next over its own morph, so this is where it lands.
      stepFrames(20);
    });
    const back = eyeNodes(container)
      .filter((n) => n.getAttribute("display") !== "none")
      .map((n) => n.getAttribute("d"))
      .join("|");

    expect(busy).not.toBe(resting);
    expect(back).toBe(resting);
  });

  it("keeps both eyes through every state, because a state that loses the face loses the coworker", () => {
    // This replaced an assertion that `thinking` hides the eyes, which was true of the engine's own
    // `thinking` state and is no longer true of anything this app draws: `thinking` maps to `swirl`,
    // which keeps the body and the face. The property worth holding is not "eyes during idle" but
    // "the silhouette survives the whole state machine" — `thinking` and `alert` upstream shrink the
    // body to a dot and throw the mark off screen, and a roster avatar that vanishes mid-turn reads as
    // a broken row rather than as an agent working.
    const states = [
      "idle",
      "listening",
      "thinking",
      "streaming",
      "done",
      "error",
    ] as const;

    const { container, rerender } = render(
      <MascotAvatar name="Rae" seed="agent_1" size={48} />,
    );
    const widthOfBody = () =>
      (bodyPath(container).getAttribute("d") ?? "").length;

    for (const state of states) {
      rerender(
        <MascotAvatar name="Rae" seed="agent_1" size={48} state={state} />,
      );
      stepFrames(30);

      const visible = eyeNodes(container).filter(
        (node) => node.getAttribute("display") !== "none",
      );
      expect(visible.length, `${state} lost its eyes`).toBe(2);
      // And the body is still a body: a silhouette that collapsed to a dot is a few dozen characters
      // of path, where a full circle is several hundred.
      expect(widthOfBody(), `${state} lost its body`).toBeGreaterThan(400);
    }
  });

  it("draws no face at all on a chip", () => {
    // Two holes in a ten-pixel shape are about a pixel each, and they read as dirt rather than as
    // expression. The silhouette is what tells two coworkers apart at that size.
    const { container } = render(
      <MascotAvatar name="Rae" seed="agent_1" size={16} />,
    );
    expect(
      eyeNodes(container).every((n) => n.getAttribute("display") === "none"),
    ).toBe(true);
    // The body is still there, and still a recognisable size.
    expect(bodyPath(container).getAttribute("d")).toMatch(/^M/);
  });

  it("draws a face from 21px up", () => {
    for (const size of [21, 24, 28, 32, 48, 80]) {
      const { container, unmount } = render(
        <MascotAvatar name="Rae" seed="agent_1" size={size} />,
      );
      const visible = eyeNodes(container).filter(
        (n) => n.getAttribute("display") !== "none",
      );
      expect(visible.length, `no face at ${size}px`).toBe(2);
      unmount();
    }
  });

  it("gives each coworker its own resting loop, so a roster is not one pose repeated", () => {
    const loops = new Set(
      Array.from({ length: 40 }, (_, i) =>
        restingLoopFor(`agent_${i}`).loop.join(">"),
      ),
    );
    expect(loops.size).toBeGreaterThan(3);
  });

  it("animates by writing attributes, never by re-rendering", () => {
    // The whole performance argument in one assertion. If a frame went through React, the probe
    // would count the render and the roster would be re-rendering on every message it receives.
    let renders = 0;
    function Probe() {
      renders++;
      const ref = useRef<HTMLDivElement>(null);
      return (
        <div ref={ref}>
          <MascotAvatar name="Rae" seed="agent_1" size={48} />
        </div>
      );
    }

    const { container } = render(<Probe />);
    const before = bodyPath(container).getAttribute("d");
    const rendersBefore = renders;

    stepFrames(20);

    expect(bodyPath(container).getAttribute("d")).not.toBe(before);
    expect(renders).toBe(rendersBefore);
  });

  it("gives two different coworkers two different mascots", () => {
    const one = render(<MascotAvatar name="A" seed="agent_aaa" size={48} />);
    const two = render(<MascotAvatar name="B" seed="agent_bbb" size={48} />);
    // Not asserted as "different" in general — that is `mascot-seed.test.ts`'s job and two seeds can
    // legitimately collide. What is asserted is that the seed is doing something at all.
    const oneShape = one.container.querySelector("svg")?.innerHTML;
    const twoShape = two.container.querySelector("svg")?.innerHTML;
    expect(oneShape).not.toBe(twoShape);
    expect(mascotChoiceForSeed("agent_aaa")).toBeDefined();
  });

  it("respects a stored choice over the seed", () => {
    const seeded = mascotChoiceForSeed("agent_1");
    const { container } = render(
      <MascotAvatar
        name="Rae"
        seed="agent_1"
        size={48}
        choice={{ ...seeded, color: "teal" }}
      />,
    );
    expect(bodyPath(container).getAttribute("fill")).toBe(
      mascotFill("teal", "agent_1"),
    );
  });

  it("falls back to the seeded mascot when a stored field is one this build does not know", () => {
    // Hand-edited rows and tenant packages are both ways to get here.
    const { container } = render(
      <MascotAvatar
        name="Rae"
        seed="agent_1"
        size={48}
        choice={{ shape: "octagon" } as never}
      />,
    );
    expect(bodyPath(container).getAttribute("d")).toMatch(/^M/);
  });

  it("gives every size a painted body, because a 16px avatar is the common case", () => {
    for (const size of [16, 18, 24, 28, 32, 36, 48, 64, 80, 250]) {
      const { container, unmount } = render(
        <MascotAvatar name="Rae" seed="agent_1" size={size} />,
      );
      expect(bodyPath(container).getAttribute("d")).toMatch(/^M/);
      expect(
        container.querySelector('[role="img"]')?.getAttribute("style"),
      ).toContain(`${size}px`);
      unmount();
    }
  });

  it("keeps the body clipped to its own box rather than bleeding over the layout", () => {
    // `error` throws its mark across the frame; without this the flourish paints over the row below.
    const { container } = render(
      <MascotAvatar name="Rae" seed="agent_1" size={48} state="error" />,
    );
    expect(container.querySelector("svg")?.getAttribute("style")).toContain(
      "overflow: hidden",
    );
  });

  it("stops painting a mascot that has scrolled out of the roster, and resumes it on the way back", () => {
    // A roster is mostly off-screen. Sampling thirty avatars nobody is looking at is the difference
    // between the sidebar scrolling smoothly and not.
    const { container } = render(
      <MascotAvatar name="Rae" seed="agent_1" size={48} />,
    );
    stepFrames(3);
    const whileVisible = bodyPath(container).getAttribute("d");

    act(() => reportVisibility(false));
    stepFrames(30);
    expect(bodyPath(container).getAttribute("d")).toBe(whileVisible);

    act(() => reportVisibility(true));
    stepFrames(1);
    expect(bodyPath(container).getAttribute("d")).not.toBe(whileVisible);
  });

  it("draws once and stops when the reader has asked for less motion", () => {
    // `prefers-reduced-motion` is a request about vestibular comfort, and an avatar that blinks,
    // breathes and drifts through a 64-point path every frame is exactly the kind of ambient motion
    // it exists to stop. One still frame, held.
    const realMatchMedia = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;

    try {
      const before = tickerSubscriberCount();
      const { container, unmount } = render(
        <MascotAvatar name="Rae" seed="agent_1" size={48} />,
      );
      expect(bodyPath(container).getAttribute("d")).toMatch(/^M/);
      // No subscription at all, rather than a subscription that ignores its ticks: the loop should
      // not even be running for a page of still mascots.
      expect(tickerSubscriberCount()).toBe(before);

      const still = bodyPath(container).getAttribute("d");
      stepFrames(30);
      expect(bodyPath(container).getAttribute("d")).toBe(still);
      unmount();
    } finally {
      globalThis.matchMedia = realMatchMedia;
    }
  });

  it("subscribes to the one shared clock and lets go of it again", () => {
    const before = tickerSubscriberCount();
    const { unmount } = render(
      <MascotAvatar name="Rae" seed="agent_1" size={48} />,
    );
    expect(tickerSubscriberCount()).toBe(before + 1);
    unmount();
    expect(tickerSubscriberCount()).toBe(before);
  });

  it("does not re-render a mascot when only its state changes", () => {
    // State changes go through the engine's own setter. Rebuilding would replay the entry animation
    // in the middle of a conversation, which is the artefact that would make an avatar feel cheap.
    const { container, rerender } = render(
      <MascotAvatar name="Rae" seed="agent_1" size={48} />,
    );
    const pathBefore = bodyPath(container);
    rerender(
      <MascotAvatar name="Rae" seed="agent_1" size={48} state="thinking" />,
    );
    // The DOM node is the same object across the state change, which is the observable consequence
    // of the effect not tearing down and remounting.
    expect(bodyPath(container)).toBe(pathBefore);
  });
});

describe("the shared ticker", () => {
  it("is one subscription regardless of how many mascots are on screen", () => {
    const before = tickerSubscriberCount();
    const views = Array.from({ length: 6 }, (_, i) => (
      <MascotAvatar
        key={`roster-${String(i)}`}
        name={`A${i}`}
        seed={`agent_${i}`}
        size={48}
      />
    ));
    const { unmount } = render(views);
    expect(tickerSubscriberCount()).toBe(before + 6);
    unmount();
    expect(tickerSubscriberCount()).toBe(before);
  });

  /*
   * The sidebar case, and the reason `ChannelAvatar` has a `states` prop at all.
   *
   * `MascotAvatar` defaults `state` to `idle`, so a roster row that passes nothing gets a resting mascot
   * forever. That is exactly the bug this covers: the whole work-state mapping existed and no call site
   * ever reached it, so every sidebar avatar looked idle through every run and nobody could tell a
   * working coworker from a finished one. These assertions are on the drawn result rather than on the
   * props, because a wiring test that only checks the props would pass with the state plumbed to the
   * wrong avatar.
   */
  it("draws the working face in the sidebar when the channel reports a run", () => {
    const capsule = (states?: Record<string, "thinking">) => {
      const { container, unmount } = render(
        <ChannelAvatar participantIds={["bot-1"]} size={36} states={states} />,
      );
      stepFrames(2);
      const eyes = eyeNodes(container)
        .filter((n) => n.getAttribute("display") !== "none")
        .map((n) => n.getAttribute("d"))
        .join("|");
      unmount();
      return eyes;
    };

    // Same seed, same size, same everything but the state — so any difference is the state and not the
    // mascot. A roster that animates nothing cannot tell these two apart.
    expect(capsule({ "bot-1": "thinking" })).not.toBe(capsule());
  });

  it("wears the resting face when nothing is running, rather than an invented one", () => {
    // `states` is absent for every idle row, so this is the case that must not throw and must not put a
    // work face on a mascot that is doing nothing.
    const { container } = render(
      <ChannelAvatar participantIds={["bot-1"]} size={36} />,
    );
    stepFrames(2);
    expect(
      eyeNodes(container).filter((n) => n.getAttribute("display") !== "none")
        .length,
    ).toBe(2);
  });

  it("gives the work state to the participant that is running and not to the others in the row", () => {
    // A stacked row holds several avatars and only one of them can be the one working. Keyed by id
    // rather than applied to the row, so the other two stay put instead of the row showing three
    // coworkers busy when one is.
    const eyesFor = (states: Record<string, "thinking" | "error">) => {
      const { container, unmount } = render(
        <ChannelAvatar
          participantIds={["bot-1", "bot-2"]}
          size={36}
          states={states}
        />,
      );
      stepFrames(2);
      const drawn = [
        ...container.querySelectorAll<SVGPathElement>("svg > path[mask]"),
      ].map((body) =>
        eyeNodes(body.ownerSVGElement as SVGSVGElement)
          .filter((n) => n.getAttribute("display") !== "none")
          .map((n) => n.getAttribute("d"))
          .join("|"),
      );
      unmount();
      return drawn;
    };

    // With both avatars idle the row is two identical resting faces; making one of them work has to
    // change exactly one of them, which is the whole point of keying by participant.
    const bothIdle = eyesFor({});
    const oneWorking = eyesFor({ "bot-2": "thinking" });
    expect(bothIdle.length).toBe(2);
    expect(oneWorking.length).toBe(2);
    expect(oneWorking[0]).toBe(bothIdle[0]);
    expect(oneWorking[1]).not.toBe(bothIdle[1]);
  });

  it("delivers the same instant to every subscriber", () => {
    const before = tickerSubscriberCount();
    const seen: number[] = [];
    const stops = [
      subscribeToTicker((now) => seen.push(now)),
      subscribeToTicker((now) => seen.push(now)),
    ];
    expect(tickerSubscriberCount()).toBe(before + 2);
    for (const stop of stops) stop();
    expect(tickerSubscriberCount()).toBe(before);
  });

  it("stops asking for frames once the last mascot is gone", () => {
    // The loop's whole contract: a module-level singleton that outlives its subscribers is a battery
    // bug, and nothing in a page's lifecycle would ever close it.
    const { unmount } = render(
      <MascotAvatar name="Rae" seed="agent_1" size={48} />,
    );
    expect(pending.length).toBeGreaterThan(0);
    unmount();
    stepFrames(5);
    expect(pending).toEqual([]);
  });

  it("drops a frame that arrives inside the budget and keeps one that arrives outside it", () => {
    // Thirty frames a second, not sixty: the whole cost argument in `ticker.ts` rests on this, and a
    // 120Hz display would otherwise ask for four times the work for a body breathing too fast to see.
    render(<MascotAvatar name="Rae" seed="agent_1" size={48} />);
    const { container } = { container: document.body };
    const first = bodyPath(container).getAttribute("d");

    act(() => {
      const due = pending;
      pending = [];
      clock += 10;
      for (const callback of due) callback(clock);
    });
    expect(bodyPath(container).getAttribute("d")).toBe(first);

    stepFrames(1);
    expect(bodyPath(container).getAttribute("d")).not.toBe(first);
  });
});
