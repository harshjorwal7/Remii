import { afterAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * The scaling invariants, asserted as numbers.
 *
 * The visual sheet proves a mascot looks right. It is also the slowest and least precise check there
 * is, and it needs a browser, so it is the one that runs last. These are the assertions that catch the
 * same class of bug first, in microseconds, with a tolerance of zero:
 *
 * The engine hands out every length in **viewBox units** — `engine.ts` has already multiplied by the
 * ball radius. `mascot-nodes.ts` multiplied by it a second time. That made every particle, every ring
 * stroke and the notification pip a hundred times too big: `thinking` was a flat grey rectangle across
 * the whole card, and `notify` was a solid blue box over the entire avatar. Nothing about that is
 * visible in the DOM — the attributes were all set, all finite, all on real nodes — so these bounds are
 * the only cheap place it can be caught.
 *
 * Each assertion below states the bound in viewBox units and says where the number comes from.
 */
/*
 * happy-dom is registered here and released in `afterAll`, and the release is not optional.
 *
 * `app/tests/preload.ts` explains the trap: bun walks every test file into one process, so a
 * registration left behind by this file is still in place when the next DOM test tries to register its
 * own, and that file fails with "Happy DOM has already been globally registered" — which has nothing to
 * say about mascots and reads like the mascot work broke something.
 */
GlobalRegistrator.register({ url: "https://remii.test/" });
afterAll(() => GlobalRegistrator.unregister());

import type { AIState } from "@/components/agents/orb/ai-core";
import { BotEngine } from "@/mascot/bloub/engine";
import type { StateId } from "@/mascot/bloub/states";
import { mascotShapeRadii, mascotStateFor, restingLoopFor } from "@/mascot/ids";
import {
  ARC_POOL_SIZE,
  BALL_RADIUS,
  DOT_POOL_SIZE,
  EYE_POOL_SIZE,
  type MascotNodes,
  paintBody,
  paintDecor,
  paintNotif,
} from "@/mascot/mascot-nodes";

/** The furthest anything may reach: the largest silhouette peak plus the resting drift. */
const BODY_LIMIT = 1.16 * BALL_RADIUS;

/** Rings orbit out to 1.45 radii upstream, which the frame deliberately cuts off. */
const DECOR_LIMIT = 1.5 * BALL_RADIUS;

const NS = "http://www.w3.org/2000/svg";
const node = (tag: string) => document.createElementNS(NS, tag) as SVGElement;

function makeNodes(): MascotNodes {
  return {
    maskBody: node("path") as SVGPathElement,
    maskEyes: Array.from({ length: EYE_POOL_SIZE }, () =>
      node("path"),
    ) as SVGPathElement[],
    body: node("path") as SVGPathElement,
    dotGroups: Array.from({ length: DOT_POOL_SIZE }, () =>
      node("g"),
    ) as SVGGElement[],
    dotCircles: Array.from({ length: DOT_POOL_SIZE }, () =>
      node("circle"),
    ) as SVGCircleElement[],
    dotPaths: Array.from({ length: DOT_POOL_SIZE }, () =>
      node("path"),
    ) as SVGPathElement[],
    arcFronts: Array.from({ length: ARC_POOL_SIZE }, () =>
      node("path"),
    ) as SVGPathElement[],
    arcBacks: Array.from({ length: ARC_POOL_SIZE }, () =>
      node("path"),
    ) as SVGPathElement[],
    notifDot: node("circle") as SVGCircleElement,
    notifNotch: node("circle") as SVGCircleElement,
  };
}

/** Every number the painter wrote, in one place, so a bound can be stated once. */
function painted(state: StateId, t: number) {
  const engine = new BotEngine(BALL_RADIUS, "idle", null, null);
  if (state !== "idle") engine.setState(state, 0);
  const frame = engine.sample(t);
  const nodes = makeNodes();
  paintBody(nodes, frame, "#0a0a0c", true);
  paintDecor(nodes, frame, true, "#0a0a0c");
  paintNotif(nodes, frame);
  return { frame, nodes };
}

/**
 * How tall an eye is drawn, in ball radii, read back out of a sampled frame.
 *
 * `capsulePath` opens with `M -hw (-hh + r)` followed by the arc's `r`, so the height is twice
 * `r - y0` with no trigonometry and no tolerance. The fourth number of the matrix is the vertical
 * scale the painter applied, which is where a blink and a head roll live.
 */
function eyeHeight(eye: { d: string; matrix: string }) {
  const [, y0 = 0, arcR = 0] = numbersIn(eye.d);
  const scale = Math.abs(numbersIn(eye.matrix)[3] ?? 1);
  return (2 * (arcR - y0) * scale) / BALL_RADIUS;
}

function numbersIn(path: string): number[] {
  return (path.match(/-?\d+\.?\d*/g) ?? []).map(Number);
}

function pathExtent(path: string) {
  const values = numbersIn(path);
  const xs = values.filter((_, i) => i % 2 === 0);
  const ys = values.filter((_, i) => i % 2 === 1);
  if (xs.length === 0) return 0;
  return Math.max(
    Math.abs(Math.min(...xs)),
    Math.abs(Math.max(...xs)),
    Math.abs(Math.min(...ys)),
    Math.abs(Math.max(...ys)),
  );
}

const ALL_STATES: AIState[] = [
  "idle",
  "listening",
  "thinking",
  "streaming",
  "done",
  "error",
];

/**
 * The engine states a mascot may reach, all of which keep the chosen body.
 *
 * `wide` is the one state deliberately absent from it, and the list is written out rather than derived
 * from the engine so that adding a state to the engine cannot quietly add one to the product.
 */
const REACHABLE: readonly StateId[] = ["idle", "wink", "notify", "swirl"];

describe("the body", () => {
  it("fits the frame for every state, over the whole run of each", () => {
    for (const state of ALL_STATES) {
      for (let t = 0; t < 3; t += 0.05) {
        const { frame } = painted(mascotStateFor(state), t);
        expect(
          pathExtent(frame.bodyPath),
          `${state} at t=${t.toFixed(2)} drew outside the frame`,
        ).toBeLessThanOrEqual(BODY_LIMIT);
      }
    }
  });

  it("paints the same path into the body and into the mask", () => {
    // The eyes are holes cut by the mask, so the mask has to hold the identical silhouette or the
    // avatar ends up with two different outlines and the eyes punch through the wrong one.
    for (const state of ALL_STATES) {
      const { nodes } = painted(mascotStateFor(state), 1.4);
      expect(nodes.maskBody?.getAttribute("d")).toBe(
        nodes.body?.getAttribute("d"),
      );
    }
  });

  it("keeps both eyes inside the body, or as close to it as the shape allows", () => {
    for (const state of ALL_STATES) {
      const { frame } = painted(mascotStateFor(state), 1.4);
      const body = pathExtent(frame.bodyPath);
      for (const eye of frame.eyes) {
        // The capsule is authored centred on the origin, so its own path has no offset; the position
        // is in the matrix. Translated back, the eye centre plus half its width must stay within the
        // silhouette, which is what stops an eye being drawn floating off the edge of a triangle.
        const [dx, dy] = numbersIn(eye.matrix).slice(4, 6);
        expect(Math.abs(dx ?? 0), `${state} eye x`).toBeLessThanOrEqual(body);
        expect(Math.abs(dy ?? 0), `${state} eye y`).toBeLessThanOrEqual(body);
      }
    }
  });
});

describe("the decor", () => {
  it("sizes every particle from the engine's own radius, not a second multiple of it", () => {
    // THE BUG. `engine.ts` returns `r: p.r * R`. Multiplying again gave a radius of 3300 units inside a
    // 260-unit frame, which is why `thinking` rendered as a flat grey rectangle rather than three dots.
    for (const state of ["thinking", "swirl", "notify"] as const) {
      for (let t = 0; t < 2.5; t += 0.05) {
        const { frame, nodes } = painted(state, t);
        for (let i = 0; i < DOT_POOL_SIZE; i++) {
          const circle = nodes.dotCircles[i];
          if (!circle || circle.getAttribute("display") === "none") continue;
          const radius = Number(circle.getAttribute("r"));
          const written = frame.dots[i]?.r;
          // The number on the node must be exactly the engine's, not a multiple of it.
          expect(
            radius,
            `${state} dot radius at t=${t.toFixed(2)}`,
          ).toBeCloseTo(written ?? 0, 2);
          expect(radius).toBeLessThanOrEqual(DECOR_LIMIT);
        }
      }
    }
  });

  it("keeps every particle inside the decor bound, at every state", () => {
    for (const state of ALL_STATES) {
      for (let t = 0; t < 3; t += 0.05) {
        const { frame } = painted(mascotStateFor(state), t);
        for (const dot of frame.dots) {
          expect(Math.abs(dot.x)).toBeLessThanOrEqual(DECOR_LIMIT);
          expect(Math.abs(dot.y)).toBeLessThanOrEqual(DECOR_LIMIT);
          expect(dot.r).toBeLessThanOrEqual(DECOR_LIMIT);
        }
      }
    }
  });

  it("scales a path-shaped particle by the ball radius, and places it", () => {
    // `DotRender.d` is authored in radius units centred on the origin. Drawn raw it is a hundredth of
    // its size, sitting in the middle of the avatar instead of out at the end of the mark — which is
    // exactly what `alert`'s teardrop did.
    const { frame, nodes } = painted("alert", 0.8);
    const shaped = frame.dots.find((d) => d.d);
    expect(shaped, "alert should draw a path-shaped particle").toBeTruthy();
    const index = frame.dots.indexOf(shaped!);
    const path = nodes.dotPaths[index];
    const transform = path?.getAttribute("transform") ?? "";
    expect(transform).toContain(`scale(${BALL_RADIUS})`);
    expect(transform).toContain(
      `translate(${shaped!.x.toFixed(2)} ${shaped!.y.toFixed(2)})`,
    );
    if (shaped?.rot !== undefined) expect(transform).toContain("rotate(");
  });

  it("uses the engine's stroke width rather than a hundred times it", () => {
    // Same defect as the particle radius: `arcRender` returns `seed.width * scale` already.
    for (let t = 0; t < 1.4; t += 0.05) {
      const { frame, nodes } = painted("swirl", t);
      for (let i = 0; i < ARC_POOL_SIZE; i++) {
        const front = nodes.arcFronts[i];
        if (!front || front.getAttribute("display") === "none") continue;
        const written = Number(front.getAttribute("stroke-width"));
        expect(written).toBeCloseTo(frame.arcs[i]?.width ?? 0, 2);
        // Upstream's thickest ring is 0.062 radii. Anything past a tenth of a radius is not a hairline.
        expect(written).toBeLessThan(BALL_RADIUS * 0.1);
      }
    }
  });

  it("draws nothing when the decor is switched off", () => {
    const engine = new BotEngine(BALL_RADIUS, "idle", null, null);
    engine.setState("swirl", 0);
    // A frame that definitely has decor in it, so this is testing the switch and not an empty frame.
    expect(engine.sample(0.6).arcs.length).toBeGreaterThan(0);
    const nodes = makeNodes();
    paintDecor(nodes, engine.sample(0.6), false, "#0a0a0c");
    // The pool groups carry the visibility, which is enough to hide both their circle and their path;
    // asserting on the children instead would be asserting on something the painter does not set.
    for (let i = 0; i < DOT_POOL_SIZE; i++) {
      expect(nodes.dotGroups[i]?.getAttribute("display")).toBe("none");
    }
    for (let i = 0; i < ARC_POOL_SIZE; i++) {
      expect(nodes.arcFronts[i]?.getAttribute("display")).toBe("none");
      expect(nodes.arcBacks[i]?.getAttribute("display")).toBe("none");
    }
  });
});

describe("the notification pip", () => {
  it("is a pip and not a wall", () => {
    // Also a hundred-times bug, and latent: `error` only started pointing at `notify` in this change,
    // so the day it did, the avatar would have gone solid blue. `NOTIF_R` is 0.15 radii.
    const { frame, nodes } = painted("notify", 0.9);
    expect(frame.notif).toBeTruthy();
    const written = Number(nodes.notifDot?.getAttribute("r"));
    expect(written).toBeCloseTo(frame.notif?.r ?? 0, 2);
    expect(written).toBeLessThanOrEqual(BALL_RADIUS * 0.2);
  });

  it("hides itself when there is no pip", () => {
    const { nodes } = painted("idle", 1);
    expect(nodes.notifDot?.getAttribute("display")).toBe("none");
    expect(nodes.notifNotch?.getAttribute("display")).toBe("none");
  });
});

describe("the face", () => {
  it("is not cut at all when the avatar is a chip", () => {
    // Two holes in a ten-pixel shape are about a pixel each, and they read as dirt on the screen. The
    // chip tier turns the face off; this is the assertion that keeps it off. The frame it is painting
    // genuinely does have eyes, or the assertion below would pass for the wrong reason.
    const { frame } = painted("idle", 1.2);
    expect(frame.eyes.length).toBeGreaterThan(0);

    const chipped = makeNodes();
    paintBody(chipped, frame, "#0a0a0c", false);
    for (const eye of chipped.maskEyes) {
      expect(eye?.getAttribute("display")).toBe("none");
    }
  });

  it("cuts both eyes when it is on", () => {
    const { nodes } = painted("idle", 1.2);
    const visible = nodes.maskEyes.filter(
      (e) => e?.getAttribute("display") !== "none",
    );
    expect(visible.length).toBe(2);
  });

  it("never bulges the eyes into a mask", () => {
    /*
     * The engine's `wide` hold has capsules 0.875 of a radius tall, against a resting 0.412 — eyes more
     * than twice the height of the face, and the reason every mascot under 48px needed a bigger mask
     * region than it otherwise would. No mascot in the product may reach it, so this bounds the poses
     * that are left instead: half a radius is the ceiling, and the tallest of them is `wink` at 0.464.
     */
    const LIMIT = 0.5;
    for (const state of ALL_STATES) {
      for (let t = 0; t < 3; t += 0.05) {
        for (const eye of painted(mascotStateFor(state), t).frame.eyes) {
          expect(
            eyeHeight(eye),
            `${state} at t=${t.toFixed(2)} drew an eye taller than half the body`,
          ).toBeLessThanOrEqual(LIMIT);
        }
      }
    }
  });
});

describe("the seeded look", () => {
  it("gives every coworker a body-preserving resting loop", () => {
    // A resting loop is the one place a mascot changes pose on its own, so anything in it that redrew
    // the body would make a coworker vanish at a moment nobody did anything.
    for (const state of ALL_STATES) {
      expect(
        REACHABLE,
        `${state} points at a state no mascot may reach`,
      ).toContain(mascotStateFor(state));
    }
    const seeds = Array.from({ length: 300 }, (_, i) => `agent_${i}`);
    for (const seed of seeds) {
      for (const state of restingLoopFor(seed).loop) {
        expect(
          REACHABLE,
          `${seed} rests in ${state}, which redraws the body`,
        ).toContain(state);
      }
    }
  });

  it("never plays the eyes-wide-open hold", () => {
    // `wide` is still in the engine — it is a measurement, and the engine is not ours to prune — but
    // nothing in this product may reach it, on any surface and at no size. It was `listening`, which is
    // the state a coworker sits in for as long as somebody is talking to it, and it had more than its
    // share of the resting loops, so half the roster bulged on a timer with nothing having happened.
    for (const state of ALL_STATES) {
      expect(mascotStateFor(state), `${state} plays the wide hold`).not.toBe(
        "wide",
      );
    }
    for (let i = 0; i < 300; i++) {
      for (const state of restingLoopFor(`agent_${i}`).loop) {
        expect(state, `agent_${i} rests in the wide hold`).not.toBe("wide");
      }
    }
  });

  it("gives coworkers different loops, so a roster is not one pose repeated", () => {
    const distinct = new Set(
      Array.from({ length: 300 }, (_, i) =>
        restingLoopFor(`agent_${i}`).loop.join(">"),
      ),
    );
    // Ten sequences exist; a hash that collapsed them would make every avatar in the product move in
    // lockstep, which is the exact tell that one clock is driving everything on screen.
    expect(distinct.size).toBeGreaterThanOrEqual(8);
  });

  it("never leaves a mascot on a pose without returning to the resting one", () => {
    for (const seed of Array.from({ length: 200 }, (_, i) => `agent_${i}`)) {
      expect(restingLoopFor(seed).loop[0]).toBe("idle");
    }
  });

  it("keeps every mascot's silhouette inside the frame whatever its shape", () => {
    for (const shape of [
      "circle",
      "pebble",
      "squircle",
      "capsule",
      "triangle",
      "hexagon",
      "cloud",
    ]) {
      for (let t = 0; t < 2; t += 0.1) {
        const engine = new BotEngine(
          BALL_RADIUS,
          "idle",
          mascotShapeRadii(shape as never),
          null,
        );
        expect(
          pathExtent(engine.sample(t).bodyPath),
          `${shape} at t=${t.toFixed(1)}`,
        ).toBeLessThanOrEqual(BODY_LIMIT);
      }
    }
  });
});
