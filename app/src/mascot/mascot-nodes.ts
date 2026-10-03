/**
 * Writes one sampled frame onto a fixed set of SVG nodes.
 *
 * This is a separate file, and imperative, for one reason: `BotEngine.sample()` returns a fresh path
 * string every tick, and routing that through React re-renders the component's whole subtree thirty
 * times a second. In a roster that is thirty renders an avatar per frame, and the roster is a child
 * of a list that re-renders on every incoming message.
 *
 * So the SVG is a **fixed skeleton** — the same number of elements for the life of the avatar — and
 * only their attributes change. Every element below is a pool sized to the worst case rather than a
 * list that grows and shrinks, because a pool gives React stable nodes with stable refs and a growing
 * list gives it new nodes on every state change, which is exactly the reconciliation the file exists
 * to avoid.
 *
 * Nothing here holds state. Paint a frame, get pixels. That is what lets a test assert on attributes
 * without a browser that is actually running a loop.
 */

import type { BotFrame } from "./bloub/engine";
import { mixHex } from "./bloub/skins";

/**
 * The ball radius the engine draws in, which is also the scale factor for a `DotRender.d`.
 *
 * A path-shaped dot is authored in radius units, so turning it into viewBox units needs this. The
 * circular case does not, because the engine has already done that multiplication by the time we see
 * it — see the note on the circle radius below.
 */
export const BALL_RADIUS = 100;

/** The engine renders at most two eyes. */
const EYE_POOL = 2;

/**
 * Worst case for a state this app can reach: `thinking` has three dots, `burst` scatters a dozen.
 * Eight covers what we play, and an avatar that wanted a ninth would drop it rather than grow a node.
 */
const DOT_POOL = 8;

/** `swirl` uses three rings; four leaves a spare. */
const ARC_POOL = 4;

/** Every node this module writes to, collected once from refs. */
export interface MascotNodes {
  maskBody: SVGPathElement | null;
  maskEyes: Array<SVGPathElement | null>;
  body: SVGPathElement | null;
  dotGroups: Array<SVGGElement | null>;
  dotCircles: Array<SVGCircleElement | null>;
  dotPaths: Array<SVGPathElement | null>;
  arcFronts: Array<SVGPathElement | null>;
  arcBacks: Array<SVGPathElement | null>;
  notifDot: SVGCircleElement | null;
  notifNotch: SVGCircleElement | null;
}

export const EYE_POOL_SIZE = EYE_POOL;
export const DOT_POOL_SIZE = DOT_POOL;
export const ARC_POOL_SIZE = ARC_POOL;

/*
 * Names for the pool slots, as real values rather than as an index used in a `key`.
 *
 * The lengths here are constants and the lists are rendered with `.map`, so nothing can reorder them
 * and the index really is the identity — which is what makes a `key` of `dot-${index}` correct and
 * also what makes it pointless to argue with a linter about it every time this file is reformatted.
 * Naming the slots instead turns four suppression comments into four constants.
 */
const slots = (name: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ key: `${name}-${index}` }));

export const EYE_SLOTS = slots("eye", EYE_POOL);
export const DOT_SLOTS = slots("dot", DOT_POOL);
export const ARC_SLOTS = slots("arc", ARC_POOL);

/** Hide a pool slot without removing it, so the node and its ref survive to be reused. */
function hide(node: Element | null) {
  if (!node) return;
  node.setAttribute("display", "none");
}

function show(node: Element | null) {
  if (!node) return;
  node.setAttribute("display", "");
}

/**
 * The body, and the eyes cut out of it.
 *
 * The eyes are **mask holes**, not white shapes. That is the single decision this file exists to get
 * right: an avatar appears on a sidebar, on a scrimmed card, on a tinted row and on a dark overlay,
 * and a filled eye colour would be wrong on all but one of them. Cutting the eyes out of the body
 * instead lets whatever is behind show through, which is correct on every one — the same reason the
 * engine's own docs describe the eyes as mask holes.
 *
 * The mask therefore needs the body's path as well, written twice per frame. It is one extra
 * `setAttribute` on an already-built string, which is cheaper than the alternative of a second
 * element that has to be kept in step by hand.
 */
export function paintBody(
  nodes: MascotNodes,
  frame: BotFrame,
  color: string,
  /**
   * Whether to cut the eyes at all.
   *
   * False for the chip tier, and the reason is size rather than taste. Two holes punched in a ten-pixel
   * shape are about a pixel each: they do not read as a face, they read as dirt on the screen, and
   * they make every chip look like the same smudged blob. The silhouette alone is legible at that size
   * and is what actually tells two coworkers apart.
   */
  face = true,
) {
  const { maskBody, body } = nodes;

  if (maskBody) maskBody.setAttribute("d", frame.bodyPath);
  if (body) {
    body.setAttribute("d", frame.bodyPath);
    // Only written when it changes. A constant attribute still costs a DOM mutation and a style
    // recalculation, and the colour of an avatar does not change while it is on screen.
    if (body.getAttribute("fill") !== color) body.setAttribute("fill", color);
    const alpha = frame.bodyAlpha.toFixed(3);
    if (body.getAttribute("opacity") !== alpha)
      body.setAttribute("opacity", alpha);
  }

  for (let i = 0; i < EYE_POOL; i++) {
    const node = nodes.maskEyes[i];
    if (!node) continue;
    const eye = face ? frame.eyes[i] : undefined;
    if (!eye || eye.alpha <= 0.01) {
      hide(node);
      continue;
    }
    show(node);
    node.setAttribute("d", eye.d);
    node.setAttribute("transform", eye.matrix);
    const alpha = eye.alpha.toFixed(3);
    if (node.getAttribute("opacity") !== alpha)
      node.setAttribute("opacity", alpha);
  }
}

/**
 * Particles and orbit rings.
 *
 * Depth fog is expressed as **opacity, not as a mix towards white**. The engine returns a `depth` per
 * dot and leaves the blend to whoever is rendering, on the grounds that only the renderer knows the
 * colour. It also knows the background, which the engine cannot: this app is greyscale-light or
 * greyscale-dark depending on the theme, and a particle faded towards white is a glowing dot on one
 * and a hole on the other. Fading alpha is right on both, so the palette never enters into it.
 *
 * `dotsBehind` is ignored, and that is a decision rather than an oversight. It is set by exactly one
 * state, `burst`, whose particles the body is supposed to occlude; `thinking` — the only other state
 * here that draws dots — puts them in front, emerging from the flanks. Honouring it properly means
 * moving nodes between parents mid-frame or keeping two pools sized for a worst case that never
 * occurs, so everything goes in front. If `burst` is ever added to the mapping in `ids.ts`, this
 * comment is the thing to read first.
 */
export function paintDecor(
  nodes: MascotNodes,
  frame: BotFrame,
  enabled: boolean,
  color: string,
) {
  for (let i = 0; i < DOT_POOL; i++) {
    const group = nodes.dotGroups[i];
    const circle = nodes.dotCircles[i];
    const path = nodes.dotPaths[i];
    const dot = enabled ? frame.dots[i] : undefined;

    if (!dot) {
      hide(group);
      continue;
    }

    const depth = dot.depth ?? 1;
    const opacity = (dot.opacity * depth).toFixed(3);
    // `color` rather than `currentColor` for the same reason the rings take it: a particle should be
    // the mascot's own colour, not whatever the CSS `color` happens to be on the row it is sitting in.
    const fill = dot.color ?? color;

    if (dot.d) {
      hide(circle);
      if (path) {
        show(path);
        path.setAttribute("d", dot.d);
        path.setAttribute("fill", fill);
        /*
         * A non-circular dot is a path in RADIUS units CENTRED ON THE ORIGIN — upstream says so on the
         * field — so it has to be moved to the dot's position and scaled up by the ball radius. Both
         * were missing, which drew `alert`'s teardrop a hundredth of its size sitting in the middle of
         * the avatar instead of out at the end of the exclamation mark.
         *
         * `translate` first, then `rotate`, then `scale`: the rotation belongs to the dot's own frame
         * and the scale to its geometry, and SVG applies transforms right to left, so this is the only
         * order that rotates the shape in place instead of swinging its position round the origin.
         */
        const rot = dot.rot ?? 0;
        path.setAttribute(
          "transform",
          `translate(${dot.x.toFixed(2)} ${dot.y.toFixed(2)}) rotate(${rot.toFixed(2)}) scale(${BALL_RADIUS})`,
        );
        const alpha = opacity;
        if (path.getAttribute("opacity") !== alpha)
          path.setAttribute("opacity", alpha);
      }
    } else if (circle) {
      hide(path);
      show(circle);
      circle.setAttribute("cx", dot.x.toFixed(2));
      circle.setAttribute("cy", dot.y.toFixed(2));
      /*
       * NOT scaled by the ball radius here, and that is the second thing this file got wrong the
       * first time. `engine.ts` already multiplied it: `r: p.r * R`. Multiplying again made every
       * particle a thousand times its intended size, which is why `thinking` rendered as a flat grey
       * rectangle at card size — three "dots" of radius 3300 units inside a 260-unit frame.
       */
      circle.setAttribute("r", dot.r.toFixed(2));
      circle.setAttribute("fill", fill);
      const alpha = opacity;
      if (circle.getAttribute("opacity") !== alpha)
        circle.setAttribute("opacity", alpha);
    }
  }

  for (let i = 0; i < ARC_POOL; i++) {
    const front = nodes.arcFronts[i];
    const back = nodes.arcBacks[i];
    const arc = enabled ? frame.arcs[i] : undefined;

    if (!arc || arc.opacity <= 0.01) {
      hide(front);
      hide(back);
      continue;
    }

    /*
     * The body colour, not the engine's gradient.
     *
     * Two reasons, and the second is the one that mattered. A gradient means a `<linearGradient>` per
     * ring per avatar in `defs`, with ids unique across every avatar on the page, for an ornament
     * visible for a second and a half — so the cheap version would have been a flat mid-stop. Then the
     * picture came out: upstream sweeps the ring hue across orange, green and cyan, which on an ink
     * mascot reads as three unrelated party rings rather than as part of a character. This app's
     * palette is greyscale, and the roster change had just got rid of a fruit bowl of colours — three
     * hues orbiting a black blob would have put it straight back.
     *
     * So the ring is the body colour and the animation is carried by the motion, which is where it
     * always read best.
     */
    const tint = color;
    const opacity = arc.opacity.toFixed(3);

    /*
     * `arc.width` unscaled, for the same reason `dot.r` is: `arcRender` already returns
     * `seed.width * scale`. Scaling it again turned every ring into a full-bleed slab across the
     * frame instead of a hairline orbit.
     */
    if (back) {
      show(back);
      back.setAttribute("d", arc.back);
      back.setAttribute("stroke", tint);
      back.setAttribute("stroke-width", arc.width.toFixed(2));
      const alpha = opacity;
      if (back.getAttribute("opacity") !== alpha)
        back.setAttribute("opacity", alpha);
    }
    if (front) {
      show(front);
      front.setAttribute("d", arc.front);
      front.setAttribute("stroke", tint);
      front.setAttribute("stroke-width", arc.width.toFixed(2));
      const alpha = opacity;
      if (front.getAttribute("opacity") !== alpha)
        front.setAttribute("opacity", alpha);
    }
  }
}

/** The blue notification pip states can pop onto the silhouette's edge. */
export function paintNotif(nodes: MascotNodes, frame: BotFrame) {
  const { notifDot, notifNotch } = nodes;

  if (!frame.notif || !notifDot) {
    hide(notifDot);
    hide(notifNotch);
    return;
  }

  /*
   * Every radius in a `BotFrame` is already in viewBox units — `engine.ts` multiplied by `R` on the
   * way out. Multiplying again made the pip radius 1500 units inside a 260-unit frame, i.e. a solid
   * blue rectangle over the whole avatar. This was latent rather than visible, because no mapped
   * state used `notify`; it would have shipped the moment `error` was pointed at it.
   */
  show(notifDot);
  notifDot.setAttribute("cx", frame.notif.x.toFixed(2));
  notifDot.setAttribute("cy", frame.notif.y.toFixed(2));
  notifDot.setAttribute("r", frame.notif.r.toFixed(2));

  // The notch is the body-coloured bite out of the pip, which is what makes it read as attached
  // rather than floating. It needs the body colour, so it is painted with the same one.
  if (notifNotch && frame.notch) {
    show(notifNotch);
    notifNotch.setAttribute("cx", frame.notch.x.toFixed(2));
    notifNotch.setAttribute("cy", frame.notch.y.toFixed(2));
    notifNotch.setAttribute("r", frame.notch.r.toFixed(2));
  } else {
    hide(notifNotch);
  }
}

/** Exported for the notch, and for tests that need a known colour pair. */
export { mixHex };
