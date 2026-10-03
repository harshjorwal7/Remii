/**
 * The bridge between the ids we persist and the engine that draws them.
 *
 * `shared/mascot-ids.ts` owns the vocabulary, because that is the half the server must agree with.
 * This file owns everything else about those ids: what the engine calls them, what colour they are,
 * what the picker labels them, and which engine animation each product state plays.
 *
 * It is the only file in the app that knows the engine's ids are French. Nothing else should ever
 * name `cercle`, and nothing in the engine should ever know what `pebble` is.
 */

import type { AIState } from "@/components/agents/orb/ai-core";
import type {
  MascotColorId,
  MascotExpressionId,
  MascotShapeId,
} from "../../../shared/mascot-ids";
import {
  type BotExpression,
  DEFAULT_EXPRESSION,
  EXPRESSION_BY_ID,
} from "./bloub/expressions";
import {
  type BotColor,
  type BotShape,
  COLOR_BY_ID,
  COLORS,
  DEFAULT_COLOR,
  DEFAULT_SHAPE,
  SHAPE_BY_ID,
  type ShapeId,
} from "./bloub/skins";
import type { StateId } from "./bloub/states";

/*
 * The engine's own ids, kept as literals rather than looked up by index. Our lists and the engine's
 * are in different orders on purpose — the engine reads its colours in hue order while ours puts
 * `red` first because the customizer leads with the vivid ones — so an index-to-index zip would
 * silently mis-colour most of the palette. Written out, a mismatch is a compile error instead.
 */

const SHAPE_BY_MASCOT_ID: Record<MascotShapeId, ShapeId> = {
  circle: "cercle",
  pebble: "galet",
  squircle: "squircle",
  capsule: "capsule",
  triangle: "triangle",
  hexagon: "hexagone",
  cloud: "nuage",
};

const COLOR_BY_MASCOT_ID: Record<MascotColorId, string> = {
  red: "rouge",
  orange: "orange",
  amber: "ambre",
  green: "vert",
  teal: "turquoise",
  blue: "bleu",
  violet: "violet",
  pink: "rose",
  cream: "creme",
};

const EXPRESSION_BY_MASCOT_ID: Record<MascotExpressionId, string> = {
  neutral: "neutre",
  attentive: "attentif",
  surprised: "surpris",
  excited: "excite",
  happy: "heureux",
  laughing: "hilare",
  angry: "colere",
  sad: "triste",
  scared: "effraye",
  wary: "mefiant",
  confused: "confus",
  curious: "curieux",
  proud: "fier",
  shy: "timide",
  indifferent: "blase",
  sleepy: "somnolent",
};

/** Labels for the picker. Copy lives here rather than in the component so both can reach it. */
const SHAPE_LABELS: Record<MascotShapeId, string> = {
  circle: "Circle",
  pebble: "Pebble",
  squircle: "Squircle",
  capsule: "Capsule",
  triangle: "Triangle",
  hexagon: "Hexagon",
  cloud: "Cloud",
};

const _EXPRESSION_LABELS: Record<MascotExpressionId, string> = {
  neutral: "Neutral",
  attentive: "Attentive",
  surprised: "Surprised",
  excited: "Excited",
  happy: "Happy",
  laughing: "Laughing",
  angry: "Angry",
  sad: "Sad",
  scared: "Scared",
  wary: "Wary",
  confused: "Confused",
  curious: "Curious",
  proud: "Proud",
  shy: "Shy",
  indifferent: "Unimpressed",
  sleepy: "Sleepy",
};

/**
 * A stable lookup of the id we store, so callers never have to remember that the engine wants
 * `ShapeId` and not `MascotShapeId`. Both take the raw string because both get called with values
 * that came out of a database column and have not been validated.
 */
export function mascotShape(id: MascotShapeId): BotShape | undefined {
  return SHAPE_BY_ID.get(SHAPE_BY_MASCOT_ID[id] ?? DEFAULT_SHAPE);
}

export function mascotColor(id: MascotColorId): BotColor | undefined {
  return COLOR_BY_ID.get(COLOR_BY_MASCOT_ID[id] ?? DEFAULT_COLOR);
}

/**
 * The hex a coworker is actually painted in: its chosen colour, given its own place inside that colour's
 * hue band.
 *
 * Eight seeded hues across a roster of a dozen guarantees collisions, and a shade alone does not fix
 * them: two coworkers can land on nearly the same lightness and read as the same colour however far
 * either is nudged. A real roster had exactly that — a knowledge bot, an onboarding bot and a release
 * bot, all three seeded pink, all three within a shade of one another.
 *
 * What separates them is hue, because hue is the one thing the eye separates at sixteen pixels. So each
 * palette colour is given the band of hue that reaches halfway to its neighbours on the wheel, and a
 * coworker takes one continuous point inside its own band. Pink's neighbours are red and violet and
 * nothing between them, so a pink coworker lands anywhere in a wide arc and two of them cannot land on
 * one another; amber sits between orange and yellow-green and gets a narrow one. That is the whole
 * trick, and it is why the band is derived from the palette rather than set to a constant: a fixed
 * spread wide enough for pink would push red into crimson, and a fixed spread narrow enough for red
 * would leave three pinks the same colour again.
 *
 * Lightness moves a little on top, four per cent either way — deliberately little, because lightness is
 * what makes a colour look muddy when it is pushed far: an amber four per cent down is still amber, and
 * one fifteen per cent down is brown.
 *
 * The neutrals get lightness only. Grey and cream have no chroma, so there is no hue to move, and
 * pretending otherwise would only make this look busier than it is.
 *
 * Stable in the seed, like every other axis of a mascot, so this is the same coworker's colour next
 * session and the same colour on every machine that renders them.
 */
const SHADE_SPREAD = 0.04;

/** The widest a band may be on either side, so no colour can wander off into a third one. */
const HUE_BAND_LIMIT = 18;

/** `#rrggbb` as hue in degrees, saturation and lightness in [0, 1]. */
function hexToHsl(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
  else if (max === g) hue = ((b - r) / delta + 2) * 60;
  else hue = ((r - g) / delta + 4) * 60;
  return [hue, saturation, lightness];
}

/** The inverse, spelled out because `hsl()` in a stylesheet is not available to a canvas attribute. */
function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const m = lightness - chroma / 2;
  const [r, g, b] =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return `#${[r, g, b]
    .map((channel) =>
      Math.round((channel + m) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * How far each palette colour's hue may travel either side of itself: half the gap to the neighbour
 * below it on the wheel, half the gap to the one above.
 *
 * Measured off the palette at load, so it follows the palette. Repitching the palette to hold up on a
 * dark theme moved several hues, and the bands moved with them without anything here changing — which is
 * the point of measuring rather than tabulating.
 *
 * Keyed by the engine's colour id, and only for the chromatic entries: the neutrals are left out,
 * because their hue is an artefact of there being no chroma, and sorting them into the wheel would have
 * them claim a band next to red that red does not have.
 */
const HUE_BANDS: ReadonlyMap<string, readonly [number, number]> = (() => {
  const chromatic = COLORS.map((color) => ({
    id: color.id,
    hsl: hexToHsl(color.hex),
  }))
    .filter((color) => color.hsl[1] >= 0.12)
    .sort((a, b) => a.hsl[0] - b.hsl[0]);
  const bands = new Map<string, readonly [number, number]>();
  const gap = (from: number, to: number) => ((to - from + 360) % 360) / 2;
  for (let i = 0; i < chromatic.length; i++) {
    const here = chromatic[i];
    const previous = chromatic[(i - 1 + chromatic.length) % chromatic.length];
    const next = chromatic[(i + 1) % chromatic.length];
    if (!here || !previous || !next) continue;
    bands.set(here.id, [
      Math.min(gap(previous.hsl[0], here.hsl[0]), HUE_BAND_LIMIT),
      Math.min(gap(here.hsl[0], next.hsl[0]), HUE_BAND_LIMIT),
    ]);
  }
  return bands;
})();

/**
 * A seeded value in [0, 1), one per salt so hue and shade do not move together.
 *
 * The whole 32 bits of the hash rather than a bucket of it, and that is the difference between a jitter
 * that mostly works and one that works. Coarse buckets mean neighbouring seeds land on neighbouring
 * buckets, and with twenty-odd coworkers per hue, a bucket count low enough to be legible hands out
 * near-identical fills to about a quarter of the pairs sharing a colour — the exact artefact this was
 * added to remove. A continuous value makes two coworkers the same fill something the hash essentially
 * never does.
 */
function seedUnit(seed: string, salt: number): number {
  return seedByte(seed, salt) / 2 ** 32;
}

export function mascotFill(id: MascotColorId, seed: string): string {
  const color = mascotColor(id);
  const base = color?.hex ?? COLORS[0]?.hex ?? "#1f7dff";
  const [hue, saturation, lightness] = hexToHsl(base);
  const band = color ? HUE_BANDS.get(color.id) : undefined;
  // A colour with no band is a neutral, or an id this build does not know: it keeps its hue and moves
  // its lightness only.
  const [below = 0, above = 0] = band ?? [0, 0];
  const turned = hue - below + seedUnit(seed, 0x2d) * (below + above);
  const shaded = Math.min(
    0.92,
    Math.max(0.12, lightness + (seedUnit(seed, 0x71) - 0.5) * 2 * SHADE_SPREAD),
  );
  if (turned === hue && shaded === lightness) return base;
  return hslToHex(turned, saturation, shaded);
}

/**
 * The face an avatar wears, for a face somebody named.
 *
 * Reachable only from `mascotExpressionFor`, which is where the naming happens. Kept as its own
 * function because the translation table below is a compile-time check: a face added to the engine's
 * sixteen and not to this record would not draw, and would not fail here either, so the record is
 * written out in full rather than derived.
 */
export function mascotExpression(
  id: MascotExpressionId,
): BotExpression | undefined {
  return EXPRESSION_BY_ID.get(
    EXPRESSION_BY_MASCOT_ID[id] ?? DEFAULT_EXPRESSION,
  );
}

/**
 * The face each product state wears.
 *
 * Nobody picks this. It is the answer to "what is this thing doing", asked of the one thing that knows,
 * which is the state the agent is in — so a coworker that is thinking looks like it, one that has
 * finished looks pleased with itself, and one that has failed looks wary rather than cheerful. A chosen
 * face could not do that: it would be one face held for the whole life of the coworker, and the face
 * would disagree with the work every second the coworker was busy.
 *
 * `idle` is the exception and it has to be. There is no work to mirror when nothing is happening, and
 * a face that changed for its own sake would flicker; so idle wears the mascot's own resting face,
 * hashed from its seed, which is what gives two coworkers different faces rather than sixteen clones
 * of one. That face is a personality, not a state, and it lives in `seed.ts`.
 *
 * The rest are a reading of the six states `ai-core.tsx` defines. `attentive` for listening, because a
 * coworker being spoken to is leaning in; `curious` for thinking, which is what a face does while it
 * works something out; `excited` for streaming, where the work is arriving; `happy` for done; `wary`
 * for error, the one that is not `sad` because a failed turn is not a bereavement and `wary` is what
 * reads at sixteen pixels.
 *
 * Which of these is actually VISIBLE depends on the engine state the animation uses, not on this table:
 * a state that draws its own measured face ignores the expression entirely. `idle` and `swirl` both
 * keep the resting face and both wear it, and `swirl` is what `listening`, `thinking` and `streaming`
 * map to — which is why those three have faces to choose from and the other three are listed for the
 * record. See `STATE_FOR_AI_STATE`.
 */
const EXPRESSION_FOR_AI_STATE: Record<AIState, MascotExpressionId | "seeded"> =
  {
    idle: "seeded",
    listening: "attentive",
    thinking: "curious",
    streaming: "excited",
    done: "happy",
    error: "wary",
  };

/**
 * The face for a state, given the mascot's own resting face for when there is no state to mirror.
 *
 * The fallback is spelled out rather than left to the caller, because "a face for a state" that can
 * return nothing is a face some surface will forget to handle, and every surface that draws a mascot
 * draws one every frame.
 */
export function mascotExpressionFor(
  state: AIState | null | undefined,
  resting: MascotExpressionId,
): MascotExpressionId {
  const wanted = EXPRESSION_FOR_AI_STATE[state ?? "idle"] ?? "seeded";
  return wanted === "seeded" ? resting : wanted;
}

export function shapeLabel(id: MascotShapeId): string {
  return SHAPE_LABELS[id];
}

/**
 * Every colour, as hex, in the order the picker shows them.
 *
 * Read once at module scope: this is a static table, and calling `mascotColor` per swatch per render
 * would rebuild twelve map lookups to produce the same answer.
 */
export const MASCOT_COLOR_SWATCHES: ReadonlyArray<{
  id: MascotColorId;
  hex: string;
}> = (Object.keys(COLOR_BY_MASCOT_ID) as MascotColorId[]).map((id) => ({
  id,
  hex: mascotColor(id)?.hex ?? COLORS[0]?.hex ?? "#1f7dff",
}));

/**
 * The radial profile the engine morphs the body to. `null` means "the engine's own measured
 * silhouette", which is what an avatar with no stored choice uses.
 */
export function mascotShapeRadii(id: MascotShapeId | null): number[] | null {
  return id ? (mascotShape(id)?.radii ?? null) : null;
}

/**
 * Which engine animation plays for each product state.
 *
 * `ai-core.tsx` asks every surface to express a state in its own material rather than bolting one
 * shared graphic on top, and a mascot is that argument taken literally: the same six states, drawn as
 * a character.
 *
 * EVERY STATE HERE KEEPS THE BODY, and that is a hard constraint rather than a preference. Upstream's
 * states declare `baseBody`: when it is false the state draws its own silhouette and the chosen shape is
 * discarded. Only `idle`, `wink`, `notify` and `swirl` are true.
 *
 * `wide` is the fourth state that keeps the body and the one nothing here may point at. It is the
 * measured eyes-wide-open hold, and it is wrong for every surface this product draws it on. Its capsules
 * are 0.875 of a ball radius tall against a resting 0.412 — eyes more than twice the height of the
 * face they sit in — so at 32px it is not a surprised coworker, it is a mask with two holes in it, and
 * the enlargement every avatar under 48px applies (see `mascot-avatar.tsx`) pushes it past the edge of
 * the silhouette on the narrow shapes. It was `listening` until now, which is the state a coworker sits
 * in for as long as somebody is talking to it.
 *
 * `listening` takes `swirl` instead, which is what `thinking` already has: the rings flare for the
 * first 1.3s of the state and then fade out, leaving the resting face alive underneath. An avatar being
 * talked to gets the same entrance a working one does, and never bulges.
 *
 * The two this used to point at are exactly the two that break a roster:
 *
 * - `thinking` shrinks the body to the middle of three pulsing dots. On a 32px avatar the coworker
 *   vanishes and three specks appear, which reads as the row breaking rather than as an agent working.
 * - `alert` flies an exclamation mark to +0.73 radii and off the other side, leaving a lone stroke in
 *   the middle of the avatar box.
 *
 * Both are the clearest "busy" and "broken" signals the engine has, and both are the wrong signal here:
 * a triangle that stays a triangle while a coworker works is indistinguishable from a coworker that
 * has stopped, and this product already has real activity indicators — the roster's typing badge, the
 * per-channel activity brief, the run state on the card. The mascot's job is to be a recognisable
 * coworker, and losing the face to say something a badge already says is a bad trade at any size.
 *
 * `notify` earns `error` instead: a blue pip on the shoulder, body intact. It is unmistakable, it
 * survives being shrunk to 16px, and the face is still there to be recognised afterwards.
 */
const STATE_FOR_AI_STATE: Record<AIState, StateId> = {
  idle: "idle",
  listening: "swirl",
  thinking: "swirl",
  streaming: "swirl",
  done: "wink",
  error: "notify",
};

export function mascotStateFor(state: AIState): StateId {
  return STATE_FOR_AI_STATE[state] ?? "idle";
}

/**
 * The loop a mascot rests in when nothing is happening, one per coworker.
 *
 * Without this every avatar in the product sits in the same pose forever, and the shape, colour and
 * expression that make them distinct are doing all the work of telling a roster apart. Two coworkers
 * with different silhouettes still read as clones when they are identically still. Giving each one its
 * own short loop is what makes a roster feel inhabited: one blinks, one looks up, one flicks its
 * rings, one is on the phone.
 *
 * Drawn only from the body-preserving set above, and that is the constraint that makes this safe to do
 * at all. A resting loop is the one place a mascot changes pose on its own, so anything in it that
 * redrew the body would make a coworker vanish at a moment nobody did anything. `wide` was one of those
 * four states until now, and it had more than its share of the eight loops below: five of the eight
 * sequences went through the eyes-wide-open hold, which means half the roster in the product bulged on
 * a timer, with no one having done anything.
 *
 * What is left is four moves — still, a blink, a ring flourish, a shoulder pip — and there are far more
 * sequences through them than there are states, so variety comes from the ordering rather than from the
 * cast. Two coworkers given different sequences still drift apart, because the holds are jittered per
 * seed and a loop leads and returns to `idle`.
 *
 * Every sequence leads with `idle` and returns to it, because the resting face is the chosen
 * expression and the others are departures from it — the reverse would make the neutral pose a
 * special occasion.
 */
const RESTING_LOOPS: ReadonlyArray<ReadonlyArray<StateId>> = [
  // The still one. Roughly a quarter of coworkers are this, and that is deliberate: a roster where
  // everything wriggles is as unreadable as one where nothing does.
  ["idle"],
  ["idle", "swirl"],
  ["idle", "wink"],
  ["idle", "notify"],
  ["idle", "swirl", "idle", "wink"],
  ["idle", "wink", "idle", "swirl"],
  ["idle", "notify", "idle", "wink"],
  ["idle", "swirl", "idle", "notify"],
  ["idle", "wink", "idle", "swirl", "idle", "notify"],
  ["idle", "notify", "idle", "swirl", "idle", "wink"],
];

/**
 * Seconds a mascot holds one pose of its loop before moving on.
 *
 * Long enough that a loop reads as a character rather than as an animation, and jittered per mascot so
 * that a roster does not change posture in unison — the giveaway that a single clock is driving
 * everything on screen. The range overlaps the loops above so that two coworkers sharing a sequence
 * still drift apart.
 */
const RESTING_HOLD_SECONDS: readonly [number, number] = [3.8, 12.4];

/** Named so the lookup above needs no non-null assertion on an array index. */
const RESTING_LOOPS_FALLBACK: ReadonlyArray<StateId> = ["idle"];

/**
 * One salted 32-bit hash of a seed, well mixed.
 *
 * The two rounds of multiply-shift-xor at the end are not decoration. Agent ids and the invented
 * placeholders beside them are strings that differ in their last character or two, and a single FNV
 * avalanche leaves the low bits of those visibly correlated — which is invisible while every caller only
 * wanted a value mod ten and is not invisible at all for the colour jitter, where the whole value is the
 * answer. With one round, two hundred ids that differ only in their suffix produced ninety distinct
 * fills; with two, two hundred.
 */
function seedByte(seed: string, salt: number): number {
  let h = (0x811c9dc5 ^ salt) >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i) + salt;
    h = Math.imul(h, 0x01000193);
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A coworker's resting loop and how long it holds each pose.
 *
 * Both come from the seed, so they are stable: a coworker does not acquire a new personality on every
 * render, and two machines showing the same roster show the same postures at the same rate.
 */
export function restingLoopFor(seed: string): {
  loop: ReadonlyArray<StateId>;
  holdSeconds: number;
} {
  const loop =
    RESTING_LOOPS[seedByte(seed, 0x5a) % RESTING_LOOPS.length] ??
    RESTING_LOOPS_FALLBACK;
  const [low, high] = RESTING_HOLD_SECONDS;
  const spread = seedByte(seed, 0x3c) % 1000;
  return { loop, holdSeconds: low + (spread / 1000) * (high - low) };
}
