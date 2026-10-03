import { memo, useCallback, useEffect, useId, useMemo, useRef } from "react";
import type { AIState } from "@/components/agents/orb/ai-core";
import type {
  MascotChoice,
  MascotExpressionId,
} from "../../../shared/mascot-ids";
import { BotEngine } from "./bloub/engine";
import type { StateId } from "./bloub/states";
import {
  mascotExpression,
  mascotExpressionFor,
  mascotFill,
  mascotShapeRadii,
  mascotStateFor,
  restingLoopFor,
} from "./ids";
import {
  ARC_SLOTS,
  DOT_SLOTS,
  EYE_SLOTS,
  type MascotNodes,
  paintBody,
  paintDecor,
  paintNotif,
} from "./mascot-nodes";
import { mergeMascotChoice, restingExpressionForSeed } from "./seed";
import { subscribeToTicker } from "./ticker";

/**
 * The engine draws in units of ball radius, and 100 is the scale its own measurements were taken at.
 * Changing it would rescale every constant in `eyefit.ts` along with it.
 */
const ENGINE_SCALE = 100;

/**
 * How much of the frame a state can wander outside the body.
 *
 * 1.3 radii of slack, so the body fills 77% of its square. That is a deliberate revision: the frame
 * used to be 1.4, sized for `alert` throwing an exclamation mark across the screen, and every mascot
 * in the product paid for a state that no longer exists. At a 32px roster avatar those three per cent
 * are about one pixel of mascot nobody could see, and at 14px they are the difference between a shape
 * and a suggestion of one.
 *
 * One value for every tier, which is the other half of it. A mascot that appeared larger in a profile
 * panel than in the roster row two clicks away would read as two different coworkers, and the whole
 * point of having one avatar per agent is that it is recognisably the same face everywhere.
 *
 * The cost is that `swirl`'s rings, which reach 1.45 radii, are cut at the frame edge at the peak of
 * the flourish. They are a 1.3-second ornament either side of a still face, and the alternative is
 * paying 7% of every avatar's size forever to see the tips of three rings for a second and a half.
 */
const VIEW_BOX_HALF = 130;
const VIEW_BOX = `${-VIEW_BOX_HALF} ${-VIEW_BOX_HALF} ${VIEW_BOX_HALF * 2} ${VIEW_BOX_HALF * 2}`;

/**
 * The mask has to be told its region explicitly.
 *
 * A `<mask>` defaults to `objectBoundingBox`, which sizes its own drawing surface to the bounding box
 * of whatever it masks with ten per cent of slack. The eyes poke outside that box on the expressions
 * that have tall eyes — `effraye` reaches 0.6 of a radius — so on the default they are chopped off at
 * the edge of the body rather than cut all the way through, which is a different mascot entirely.
 * `userSpaceOnUse` and the viewBox, stated once, puts the decision back where it belongs.
 */
const MASK_REGION = { x: -200, y: -200, width: 400, height: 400 };

/**
 * What an avatar of this size is asked to be.
 *
 * Three tiers, and the boundaries are where the drawing stops working rather than where the CPU starts
 * complaining. Getting this wrong is not a subtle degradation: at fourteen pixels a two-holed circle
 * is not a face, it is a smudge, and every chip in a roster looks like the same smudge.
 *
 * - **chip, 20px and under.** Silhouette only. Two holes in a ten-pixel shape are about a pixel each;
 *   they read as dirt, not expression, and they cost the shape more legibility than the face adds.
 *   A roster of chips is told apart by silhouette, which is the one thing that survives this size.
 * - **avatar, 21 to 47px.** Full face, with the eyes enlarged. The engine's proportions are measured
 *   for a large drawing and do not survive being scaled down: at the native size the eyes are a fifth
 *   of the body across, which at 32px is two pixels of white. Enlarging them is what makes a 32px
 *   avatar look like a face rather than a blob with a scratch on it. Gentler below 28px, where there
 *   is not room to be generous without the two eyes merging.
 * - **hero, 48px and up.** Native measured proportions, plus the decor. This is the tier the
 *   measurements were made for and the only one that should be left alone.
 *
 * `eyeScale` is applied to the chosen expression before the engine ever sees it, which is why it does
 * not need a change to the vendored engine — `BotExpression` is plain data and the engine blends it
 * field by field.
 *
 * The enlargement is a fifth, not a third, and that is a reduction. At a third the tallest resting
 * expression grew past a third of the body in height, which stopped reading as a face and started
 * reading as a mask: on a narrow shape the outer eye rode the edge of the silhouette, and the
 * `wide` hold — the state nothing here points at any more, but which `effraye` still resembles — would
 * have been close to filling the head. Enough to read at 32px, not enough to change the character.
 */
function tier(size: number): Tier {
  if (size <= 20) return { ...CHIP };
  if (size < 48) return size >= 28 ? AVATAR : AVATAR_SMALL;
  return { ...HERO };
}

interface Tier {
  /** Whether the eyes are cut out of the body at all. */
  face: boolean;
  /** Multiplier on the chosen expression's eye width and height. */
  eyeScale: number;
  /** Multiplier on eye separation, so bigger eyes also sit further apart. */
  eyeSplitScale: number;
  /** Whether rings and particles are drawn. */
  decor: boolean;
  /** How many ticker frames pass between samples. */
  sampleEvery: number;
}

const CHIP: Tier = {
  face: false,
  eyeScale: 1,
  eyeSplitScale: 1,
  decor: false,
  sampleEvery: 3,
};
const AVATAR: Tier = {
  face: true,
  eyeScale: 1.2,
  eyeSplitScale: 1.08,
  decor: false,
  sampleEvery: 1,
};
const AVATAR_SMALL: Tier = { ...AVATAR, eyeScale: 1.08 };
const HERO: Tier = { ...AVATAR, eyeScale: 1, eyeSplitScale: 1, decor: true };

/**
 * One observer for every avatar on the page.
 *
 * A roster scrolls mascots out of view and back, and an observer per avatar means an intersection
 * root and an entry list per instance to answer a question they all answer the same way. This one is
 * created on the first mascot that needs it and dropped when the last one leaves.
 */
let sharedObserver: IntersectionObserver | null = null;
let observerClients = 0;
const visibilityHandlers = new Map<Element, (visible: boolean) => void>();

function observeVisibility(
  target: Element,
  onChange: (visible: boolean) => void,
) {
  // No IntersectionObserver means no layout information, which is not the same as hidden. Painting is
  // the safe reading: an avatar that never appears is a bug, an avatar that animates off screen is
  // only a little wasted work.
  if (typeof IntersectionObserver === "undefined") return () => {};

  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const handler = visibilityHandlers.get(entry.target);
        if (handler) handler(entry.isIntersecting);
      }
    });
  }

  visibilityHandlers.set(target, onChange);
  observerClients++;
  sharedObserver.observe(target);

  return () => {
    visibilityHandlers.delete(target);
    observerClients--;
    if (observerClients <= 0) {
      sharedObserver?.disconnect();
      sharedObserver = null;
      observerClients = 0;
    }
  };
}

/** Read once per mount, not per frame. */
function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Hand the engine a face sized for the tier it is being drawn at.
 *
 * The engine's expressions are measured for a large drawing, so they are scaled by copying the chosen
 * expression and multiplying the two numbers that make a face look like one: eye width and height, and
 * how far apart they sit. Enlarging the eyes without widening the split leaves them overlapping, which
 * at 32px reads as a single smudge rather than two eyes.
 *
 * This is why the vendored engine needs no change. `BotExpression` is plain data, `setExpression`
 * blends it field by field, and the rotation, gaze and blink all still come from the measurement — so
 * what is being adjusted is a proportion, not a shape. Everything here is a copy; the chosen
 * expression object is never touched, which matters because the same one is shared by every avatar on
 * the page at whatever sizes they happen to be drawn.
 *
 * A scale of one returns the expression unchanged, so a hero avatar is fed the measurement itself.
 */
function applyTierToEngine(
  engine: BotEngine,
  at: Tier,
  expressionId: MascotExpressionId,
) {
  const chosen = mascotExpression(expressionId) ?? null;
  if (!chosen || at.eyeScale === 1) {
    engine.setExpression(chosen, currentSeconds());
    return;
  }
  // Spelled out rather than `.map`ed: `eyes` is a two-tuple, because the engine indexes it by eye
  // number everywhere it builds a gaze, and a mapped array is no longer assignable to one.
  const [left, right] = chosen.eyes;
  const grow = (eye: (typeof chosen.eyes)[number]) => ({
    ...eye,
    w: eye.w * at.eyeScale,
    h: eye.h * at.eyeScale,
  });
  engine.setExpression(
    {
      ...chosen,
      split: chosen.split * at.eyeSplitScale,
      eyes: [grow(left), grow(right)],
    },
    currentSeconds(),
  );
}

/** Seconds since the time origin: the engine's clock is in seconds, rAF's is in milliseconds. */
function currentSeconds() {
  return performance.now() / 1000;
}

/**
 * A coworker's mascot.
 *
 * Animated, and animated in place. `mascot-nodes.ts` explains why the frame loop writes attributes
 * instead of state, `ticker.ts` why there is one loop for the whole app, and this file why the engine
 * is created once and then talked to rather than rebuilt whenever a prop moves.
 */
export const MascotAvatar = memo(function MascotAvatar({
  name,
  choice,
  seed,
  size = 40,
  state = "idle",
  className,
  animated = true,
}: {
  /** Who this is. Announced, never drawn — the mascot itself is decorative. */
  name: string;
  /** A stored choice. Any field left out falls back to the seeded mascot. */
  choice?: Partial<MascotChoice> | null;
  /** The agent id, used to fill in whatever `choice` leaves out. */
  seed: string;
  size?: number;
  state?: AIState;
  className?: string;
  /**
   * Whether this mascot moves. False paints one frame and never subscribes.
   *
   * For a row of swatches: the mascot customizer draws twenty of these at once, and an animated
   * one costs an engine and a ticker subscription apiece for a picture the eye compares in under a
   * second. It is also the honest way to show a face — one halfway through a morph says nothing about
   * what the face is.
   */
  animated?: boolean;
}) {
  const resolved = useMemo(
    () => mergeMascotChoice(choice, seed),
    [choice, seed],
  );
  const tierForSize = useMemo(() => tier(size), [size]);
  const resting = useMemo(() => restingLoopFor(seed), [seed]);
  const wantsState = mascotStateFor(state);
  const maskId = useId();

  const engineRef = useRef<BotEngine | null>(null);
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const visibleRef = useRef(true);
  const frameRef = useRef(0);
  const appliedState = useRef<StateId>(wantsState);
  /*
   * The face, which is a function of what the agent is doing.
   *
   * `restingExpressionForSeed` is the mascot's own face, hashed from its id like everything else about
   * it, and `mascotExpressionFor` replaces it with the face the current state calls for. So the face
   * follows the work and nobody picks it — see `ids.ts` for why that is the case and
   * `shared/mascot-ids.ts` for why the column it used to live in is gone.
   *
   * Held in a ref, as the state below is, because the mount-only effect needs the face that was
   * current when the engine was built and the effect that reacts to the work needs to reach the same
   * answer to avoid pushing an unchanged face at the engine every frame.
   */
  const restingExpression = useMemo(
    () => restingExpressionForSeed(seed),
    [seed],
  );
  const faceFor = (over: AIState | undefined) =>
    mascotExpressionFor(over, restingExpression);
  const appliedExpressionRef = useRef(faceFor(state));

  /*
   * The painter closes over the colour, and the engine outlives any change to it, so the colour is
   * read through a ref rather than captured. A colour can change mid-conversation — somebody picks a
   * new one in the customizer — and rebuilding the effect to deliver it would restart the avatar's
   * clock and replay its entry animation.
   *
   * `mascotFill` rather than the palette entry: it carries the seed, so a coworker that shares its hue
   * with another one still gets its own shade, which is what keeps two of them from being the same
   * colour twice in one roster.
   */
  const color = mascotFill(resolved.color, seed);
  const colorRef = useRef(color);
  colorRef.current = color;

  /*
   * Refs are collected into one long-lived object because the hot path should be a property write and
   * not a walk of twenty `RefObject.current` reads rebuilding a value that only changes when React
   * attaches a node.
   */
  const nodes = useRef<MascotNodes>({
    maskBody: null,
    maskEyes: [],
    body: null,
    dotGroups: [],
    dotCircles: [],
    dotPaths: [],
    arcFronts: [],
    arcBacks: [],
    notifDot: null,
    notifNotch: null,
  });

  /*
   * Every ref callback is index-keyed. A callback that could not tell which pool slot it was mounted
   * into would write every node into slot zero, and the symptom would be eight dots stacked on the
   * same spot rather than an error.
   */
  const maskBodyRef = useCallback((node: SVGPathElement | null) => {
    nodes.current.maskBody = node;
  }, []);
  const bodyRef = useCallback((node: SVGPathElement | null) => {
    nodes.current.body = node;
  }, []);
  const eyeRefs = useMemo(
    () =>
      Array.from(
        { length: EYE_SLOTS.length },
        (_, index) => (node: SVGPathElement | null) => {
          nodes.current.maskEyes[index] = node;
        },
      ),
    [],
  );
  const dotGroupRefs = useMemo(
    () =>
      Array.from(
        { length: DOT_SLOTS.length },
        (_, index) => (node: SVGGElement | null) => {
          nodes.current.dotGroups[index] = node;
        },
      ),
    [],
  );
  const dotCircleRefs = useMemo(
    () =>
      Array.from(
        { length: DOT_SLOTS.length },
        (_, index) => (node: SVGCircleElement | null) => {
          nodes.current.dotCircles[index] = node;
        },
      ),
    [],
  );
  const dotPathRefs = useMemo(
    () =>
      Array.from(
        { length: DOT_SLOTS.length },
        (_, index) => (node: SVGPathElement | null) => {
          nodes.current.dotPaths[index] = node;
        },
      ),
    [],
  );
  const arcFrontRefs = useMemo(
    () =>
      Array.from(
        { length: ARC_SLOTS.length },
        (_, index) => (node: SVGPathElement | null) => {
          nodes.current.arcFronts[index] = node;
        },
      ),
    [],
  );
  const arcBackRefs = useMemo(
    () =>
      Array.from(
        { length: ARC_SLOTS.length },
        (_, index) => (node: SVGPathElement | null) => {
          nodes.current.arcBacks[index] = node;
        },
      ),
    [],
  );
  const notifDotRef = useCallback((node: SVGCircleElement | null) => {
    nodes.current.notifDot = node;
  }, []);
  const notifNotchRef = useCallback((node: SVGCircleElement | null) => {
    nodes.current.notifNotch = node;
  }, []);
  const hostCallbackRef = useCallback((node: HTMLSpanElement | null) => {
    hostRef.current = node;
  }, []);

  /*
   * Mount only. The engine is created once and thereafter driven through its own timed setters, so
   * that a colour, a shape, an expression or a state can all change without the avatar restarting:
   * the engine morphs a body between silhouettes and blends a face between expressions on its own
   * schedule, and rebuilding it would throw that halfway motion away.
   *
   * So the dependency list is deliberately empty and the linter is told why. Every prop that varies
   * reaches the engine through a timed setter in one of the effects below, which is the whole reason
   * those exist — the face included, which now arrives on the agent's state rather than on a prop.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount only by design; see above
  useEffect(() => {
    const engine = new BotEngine(
      ENGINE_SCALE,
      appliedState.current,
      mascotShapeRadii(resolved.shape),
      mascotExpression(appliedExpressionRef.current) ?? null,
    );
    engineRef.current = engine;
    /*
     * The tier's eye scale is pushed in as well as at construction, because `tierForSize` is read
     * here and the effect is mount-only. Resizing an avatar therefore resizes its face — a 32px chip
     * that grows into the profile panel's 80px becomes the same expression again, not a startled one.
     */
    applyTierToEngine(engine, tierForSize, appliedExpressionRef.current);

    let painted = false;

    const paint = (nowMs: number) => {
      if (!visibleRef.current) return;
      frameRef.current++;
      // Frame skipping rather than a second clock at another rate — see `ticker.ts` on why there is
      // exactly one. `0 % n` is 0, so the first painted frame always passes the gate.
      if (painted && frameRef.current % tierForSize.sampleEvery !== 0) return;
      const frame = engine.sample(nowMs / 1000);
      paintBody(nodes.current, frame, colorRef.current, tierForSize.face);
      paintDecor(nodes.current, frame, tierForSize.decor, colorRef.current);
      paintNotif(nodes.current, frame);
      painted = true;
    };

    // Painted synchronously, before a frame is even requested. An avatar blank for one frame reads as
    // a flash of the layout behind it, which is a worse artefact than a frame of stale mascot.
    paint(currentSeconds() * 1000);

    if (!animated || prefersReducedMotion()) {
      return () => {
        engineRef.current = null;
      };
    }

    const unsubscribe = subscribeToTicker(paint);
    const host = hostRef.current;
    const unobserve = host
      ? observeVisibility(host, (visible) => {
          visibleRef.current = visible;
          // Resets the modulo, so the first frame back on screen is a kept frame and not a skipped
          // one — which is how an avatar returns from off screen already animating.
          if (visible) frameRef.current = 0;
        })
      : () => {};

    return () => {
      unsubscribe();
      unobserve();
      engineRef.current = null;
    };
    // Mount only. Everything that varies is delivered by the effects below, on purpose.
  }, []);

  // A new silhouette slides into the old one rather than cutting to it.
  const appliedShape = useRef(resolved.shape);
  useEffect(() => {
    if (appliedShape.current === resolved.shape) return;
    appliedShape.current = resolved.shape;
    engineRef.current?.setShape(
      mascotShapeRadii(resolved.shape),
      currentSeconds(),
    );
  }, [resolved.shape]);

  /*
   * The face follows the work, and this is the effect that puts it on.
   *
   * Keyed on `state` and on nothing the person chose, because that is now the only thing that changes
   * it. The engine blends one face into the next over its own morph, so a coworker that starts thinking
   * opens its eyes out rather than cutting to a new face, and one that finishes settles back to the
   * resting face it had before — which is the whole reason the resting face is a separate value from
   * the state faces rather than one of them.
   *
   * `faceFor` is a closure rather than a value so the dependency list reads as what actually moves the
   * face: the state, and the resting face it falls back to. The linter cannot see through it, hence
   * the note.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: faceFor closes over exactly these two; see above
  useEffect(() => {
    const face = faceFor(state);
    if (appliedExpressionRef.current === face) return;
    appliedExpressionRef.current = face;
    const engine = engineRef.current;
    if (engine) applyTierToEngine(engine, tierForSize, face);
  }, [state, tierForSize, restingExpression]);

  useEffect(() => {
    if (appliedState.current === wantsState) return;
    appliedState.current = wantsState;
    engineRef.current?.setState(wantsState, currentSeconds());
  }, [wantsState]);

  /*
   * The resting loop: this mascot's own little sequence, run while nothing is happening.
   *
   * Only while `state` is `idle`. A working or broken coworker has something to say and says it; the
   * moment `wantsState` moves off idle this effect tears its timer down, so the two can never argue
   * about which pose is current. Restoring idle restarts the loop from wherever it had got to rather
   * than from the beginning, which is why the index lives in a ref and not in state.
   *
   * A `setTimeout` per avatar rather than another ticker: this is a pose change every several seconds,
   * not a frame, and a frame loop would keep thirty idle engines sampling forever to drive it.
   */
  const restingIndex = useRef(0);
  useEffect(() => {
    const engine = engineRef.current;
    if (!animated || wantsState !== "idle" || !engine) return;
    if (resting.loop.length < 2) return;

    const holdMs = resting.holdSeconds * 1000;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const advance = () => {
      if (cancelled) return;
      restingIndex.current = (restingIndex.current + 1) % resting.loop.length;
      engine.setState(
        resting.loop[restingIndex.current] ?? "idle",
        currentSeconds(),
      );
      timer = setTimeout(advance, holdMs);
    };

    timer = setTimeout(advance, holdMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [animated, resting, wantsState]);

  return (
    <span
      ref={hostCallbackRef}
      role="img"
      aria-label={name}
      className={`inline-flex shrink-0 items-center justify-center ${className ?? ""}`}
      style={{ height: size, width: size }}
    >
      {/* `color` on the root is what makes a particle's `currentColor` track the chosen body colour
          without the painter having to write a fill onto every dot in the pool. */}
      <svg
        width={size}
        height={size}
        viewBox={VIEW_BOX}
        style={{ display: "block", overflow: "hidden" }}
        color={color}
        aria-hidden="true"
      >
        {/* Every pool below has a fixed slot count, which is what lets a slot be named instead of
         * indexed. `mascot-nodes.ts` says why the count must not grow. */}
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" {...MASK_REGION}>
            <path ref={maskBodyRef} fill="#ffffff" d="" />
            {EYE_SLOTS.map((slot, index) => (
              <path
                key={slot.key}
                ref={eyeRefs[index]}
                fill="#000000"
                display="none"
                d=""
              />
            ))}
          </mask>
        </defs>

        {/* The back half of each orbit ring, drawn before the body so the silhouette occludes it. */}
        {ARC_SLOTS.map((slot, index) => (
          <path
            key={slot.key}
            ref={arcBackRefs[index]}
            fill="none"
            strokeLinecap="round"
            display="none"
            d=""
          />
        ))}

        <path ref={bodyRef} fill={color} d="" mask={`url(#${maskId})`} />

        {/* The front half, drawn over the body. */}
        {ARC_SLOTS.map((slot, index) => (
          <path
            key={slot.key}
            ref={arcFrontRefs[index]}
            fill="none"
            strokeLinecap="round"
            display="none"
            d=""
          />
        ))}

        {DOT_SLOTS.map((slot, index) => (
          <g key={slot.key} ref={dotGroupRefs[index]} display="none">
            <circle
              ref={dotCircleRefs[index]}
              fill="currentColor"
              r="0"
              cx="0"
              cy="0"
            />
            <path ref={dotPathRefs[index]} fill="currentColor" d="" />
          </g>
        ))}

        <circle
          ref={notifDotRef}
          fill="#2496e8"
          display="none"
          r="0"
          cx="0"
          cy="0"
        />
        <circle
          ref={notifNotchRef}
          fill={color}
          display="none"
          r="0"
          cx="0"
          cy="0"
        />
      </svg>
    </span>
  );
});
