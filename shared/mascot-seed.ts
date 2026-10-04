/**
 * Which mascot a coworker gets when nobody chose one, and the face it rests in.
 *
 * This replaces `boring-avatars`' seed-to-gradient mapping, which we could not read or extend: it
 * returned an SVG and nothing else, so the only lever we had was a string. Here a seed picks a shape
 * and a colour out of 56 combinations — 7 shapes by the 8 vivid hues, less whatever a named coworker
 * has reserved — and a resting face out of the faces that read as "at ease", which is enough that
 * two coworkers on the same roster essentially never collide.
 *
 * FNV-1a rather than anything cleverer. It is thirty lines, it has no dependencies, and its one
 * real weakness — correlated input does not desynchronise — does not apply here, because the input is
 * an agent id. A hash function this small being boring is the point: the value has to be identical on
 * every machine that renders an agent, forever, which rules out anything seeded by time or entropy.
 *
 * The axes are read from three separate byte ranges of one hash rather than by hashing three times.
 * Hashing once is what makes them independent: picking a different shape must not reshuffle somebody's
 * colour, and a face that moved with the colour would mean choosing a colour in the customizer quietly
 * gave somebody else a new personality.
 *
 * Colours reserved by a named mascot are excluded from the seed rotation: two coworkers should never
 * be born wearing the same colour, and the one that is anybody's to look at twice must not be matched
 * by an accident of an agent id. See `NAMED_MASCOTS` below.
 */
import { REMII_AGENT_ID } from "./remii";
import {
  isMascotColorId,
  isMascotShapeId,
  MASCOT_COLOR_IDS,
  MASCOT_SHAPE_IDS,
  type MascotChoice,
  type MascotColorId,
  type MascotExpressionId,
  type MascotShapeId,
} from "./mascot-ids";

/**
 * FNV-1a, 32-bit.
 *
 * Returned as three numbers rather than one because the offsets are what keep the axes apart: the
 * colour is read from a different third of the digest than the shape, so no combination of them can
 * alias onto another.
 */
function digest(seed: string): [number, number, number] {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x01000193);
  h ^= h >>> 15;
  const unsigned = h >>> 0;
  return [unsigned >>> 16, (unsigned >>> 8) & 0xff, unsigned & 0xff];
}

/**
 * The colours an undressed coworker may be given: every vivid one, evenly weighted.
 *
 * Two earlier versions of this list were both wrong and both were caught the same way — by rendering a
 * twelve-row roster and looking at it.
 *
 * The first was half `ink`. The reasoning was that this app is greyscale and a saturated blob in a
 * sidebar is a status light. True, and the wrong conclusion: six of twelve coworkers came out black, and
 * a roster of black blobs with greys mixed in is not a design, it is a missing feature.
 *
 * The second excluded red and orange on the grounds that `--destructive` in `app/src/styles.css` is
 * `oklch(0.577 0.245 27.3)` — a red at hue 27, with `orange` sitting on 28 — so a mascot in either would
 * sit beside an activity indicator using that exact hue to mean failure. Also true, and also the wrong
 * conclusion, because it was spent on a grey roster to avoid a rare coincidence. An avatar is the thing
 * somebody is meant to recognise at a glance, the greyscale theme is the app's *chrome* rather than its
 * characters, and a mascot is never an indicator. Warm and punchy is what a mascot is for.
 *
 * So: all eight vivid hues, evenly weighted, *before* the named reservation. `cream` is the only one
 * left out of the defaults, because it rendered a coworker as a ghost on the light surface. `grey`
 * used to be excluded alongside it and is no longer in the palette at all — `ink` and `brown` went the
 * same way earlier. See `shared/mascot-ids.ts` for why none of the three are coming back. `cream` stays
 * in the customizer; this is a default, not a palette.
 */
export const DEFAULT_COLOR_SLOTS: readonly MascotColorId[] = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
];

/**
 * The agents whose mascot is a decision rather than a hash.
 *
 * Remii is the deployment's own chief of staff and is present in every roster of every installation, so
 * it is the one coworker anybody will look at twice. A hash gives it whatever its id happens to land on,
 * which means the product's own assistant looks different on every deployment for no reason — the one
 * avatar that ought to be recognisable is the one that never is.
 *
 * Keyed by id rather than by name because the id is the stable thing: the name is operator-editable in
 * a tenant package and is already resolved from this id in several places, so an id here is what cannot
 * drift.
 *
 * This is a default, not a lock. `mergeMascotChoice` still lets a chosen axis win, so anybody who
 * dislikes a pink cloud can pick another shape and only the parts they did not choose are inherited.
 */
const NAMED_MASCOTS: Record<
  string,
  { mascot: MascotChoice; resting: MascotExpressionId }
> = {
  [REMII_AGENT_ID]: {
    mascot: { shape: "cloud", color: "pink" },
    resting: "curious",
  },
};

/**
 * Colours a seeded mascot is forbidden from, because a named mascot already wears them.
 *
 * Deriving this from `NAMED_MASCOTS` rather than hardcoding it is the whole point: add a named
 * coworker and their colour leaves the seed rotation automatically, instead of the next hash collision
 * being filed as a bug.
 */
export const RESERVED_SEED_COLORS: readonly MascotColorId[] = Array.from(
  new Set<MascotColorId>(
    Object.values(NAMED_MASCOTS).map((named) => named.mascot.color),
  ),
);

/**
 * Every colour the hash may actually hand over: the default palette, minus the named reservation.
 *
 * This is what `mascotChoiceForSeed` draws from. `DEFAULT_COLOR_SLOTS` stays the full declared
 * palette for anything that means "all of them" rather than "what a seed picks" — the customizer
 * keeps offering pink, and only the seeded default stops handing it out.
 */
export const SEEDED_COLOR_SLOTS: readonly MascotColorId[] =
  DEFAULT_COLOR_SLOTS.filter((color) => !RESERVED_SEED_COLORS.includes(color));

/**
 * The faces a mascot may rest in.
 *
 * Handing one of them out as a coworker's permanent resting face would mean a mascot sitting there
 * looking alarmed, or miserable, or delighted, for as long as it had nothing to do, which is a state
 * rather than a personality.
 *
 * These ten are the faces that read as a coworker at ease at sixteen pixels, which is where the roster
 * lives. Ten is enough that two coworkers resting side by side are not the same face, and a resting
 * face is the smallest thing that tells them apart.
 */
const RESTING_EXPRESSION_IDS: readonly MascotExpressionId[] = [
  "neutral",
  "attentive",
  "happy",
  "proud",
  "curious",
  "shy",
  "indifferent",
  "sleepy",
  "confused",
  "wary",
];

/**
 * A complete mascot for a seed, and always a complete one.
 *
 * Never partially specified: every caller wants to draw, and a caller that had to know which fields
 * were missing would end up drawing the same default blob the unchosen case uses, defeating the
 * point of seeding at all.
 */
export function mascotChoiceForSeed(seed: string): MascotChoice {
  const named = NAMED_MASCOTS[seed];
  if (named) return { ...named.mascot };

  const [shapeBits, colorBits] = digest(seed);
  const shape: MascotShapeId =
    MASCOT_SHAPE_IDS[shapeBits % MASCOT_SHAPE_IDS.length] ??
    MASCOT_SHAPE_IDS[0];
  const color: MascotColorId =
    SEEDED_COLOR_SLOTS[colorBits % SEEDED_COLOR_SLOTS.length] ??
    SEEDED_COLOR_SLOTS[0];
  return { shape, color };
}

/**
 * The face a coworker rests in, for when nothing is happening to it.
 *
 * Hashed from the same digest as the shape and the colour, on its own byte range, so it is as stable
 * as they are and as independent of them: choosing a colour in the customizer must not give a coworker
 * a new personality.
 */
export function restingExpressionForSeed(seed: string): MascotExpressionId {
  const named = NAMED_MASCOTS[seed];
  if (named) return named.resting;

  const [, , expressionBits] = digest(seed);
  return (
    RESTING_EXPRESSION_IDS[expressionBits % RESTING_EXPRESSION_IDS.length] ??
    "neutral"
  );
}

/**
 * Every colour a person can choose: the whole palette, re-exported.
 *
 * Here rather than imported at each use site so that the difference between the default subset above
 * and what the customizer offers is stated in one place. A test asserts the customizer still reaches
 * all twelve — narrowing the default must never quietly narrow the choice.
 */
export { MASCOT_COLOR_IDS as CHOOSABLE_COLOR_IDS, RESTING_EXPRESSION_IDS };

/**
 * Fill in whatever the caller has not already chosen.
 *
 * Two axes, since the face stopped being one: nothing here returns an expression, and a stored one is
 * ignored rather than honoured.
 *
 * The shape of this function is the compatibility rule, and it is worth stating plainly: a stored
 * choice names only the fields somebody actually picked. Name them and you inherit the seeded
 * mascot; leave one out and that axis is seeded while the others stay chosen. So a person who has
 * only ever picked a colour gets every coworker they have in a different shape rather than eight
 * identical circles, which is the reading that makes a partly-customised mascot look like a bug.
 *
 * `seed` is required rather than optional because there is no correct answer without one, and
 * returning the shared default here would quietly collapse every seeded agent onto one mascot.
 */
export function mergeMascotChoice(
  chosen: Partial<MascotChoice> | null | undefined,
  seed: string,
): MascotChoice {
  const seeded = mascotChoiceForSeed(seed);
  return {
    shape:
      chosen && isMascotShapeId(chosen.shape) ? chosen.shape : seeded.shape,
    color:
      chosen && isMascotColorId(chosen.color) ? chosen.color : seeded.color,
  };
}
