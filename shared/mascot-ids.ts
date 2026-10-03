/**
 * The closed vocabulary of a coworker mascot: which body shapes, which colours, and the faces an
 * avatar can wear.
 *
 * TWO OF THOSE THREE ARE A CHOICE AND ONE IS NOT, and the split is the point of this file. Shape and
 * colour are picked, stored and forgotten about — they are what makes one coworker recognisable at a
 * glance. A face is not picked by anybody: it is what the coworker is doing. `app/src/mascot/ids.ts`
 * derives it from the agent's work state, so the vocabulary of faces still has to be closed and shared
 * — the app has to be able to name one and the server has to refuse a value it does not know — but it
 * is not part of `MascotChoice` and it is not a column.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the reason `handoff-markers.ts` gives. The server has
 * to reject a shape it does not recognise, and the app has to draw exactly the shapes the server
 * will accept. A list that lives on one side only is a list the other side guesses at, and the guess
 * is invisible until somebody's saved mascot renders as somebody else's.
 *
 * The ids here are ours, in English, because they are persisted in `agent_profiles` and travel
 * through the API. The engine we render with speaks French — see `app/src/mascot/bloub/UPSTREAM.md`
 * — so `app/src/mascot/ids.ts` holds the translation between the two and is the only place that has
 * to know about either. A rename upstream therefore cannot break a stored row.
 */

/** Body silhouettes. Each is a radial profile, sampled at 64 angles. */
export const MASCOT_SHAPE_IDS = [
  "circle",
  "pebble",
  "squircle",
  "capsule",
  "triangle",
  "hexagon",
  "cloud",
] as const;

export type MascotShapeId = (typeof MASCOT_SHAPE_IDS)[number];

/**
 * Body colours.
 *
 * No black and no brown, and neither is ever coming back. Both were in the original palette and both
 * failed the same test — a row of mascots in a sidebar — for the same reason: at 16 to 40 pixels they
 * read as a hole or as mud rather than as a colour, and on the dark theme the near-black one
 * disappeared into the surface it was drawn on. A mascot is the thing somebody recognises, so a colour
 * that cannot be recognised is not one.
 *
 * No grey either, and this one left more reluctantly than the other two. The argument for keeping it was
 * that a quiet coworker is a choice, and that grey is the one colour nobody mistakes for a status light.
 * The argument against it is that grey is the app's own chrome: every surface, every border, every
 * muted label is already a grey, so a grey mascot is the one avatar on the roster that reads as
 * furniture. It also cannot be told apart from `cream` at 16px, which is the size where telling a
 * coworker from another coworker is the entire job. `cream` stays — it is a colour, and it is pale
 * rather than absent.
 */
export const MASCOT_COLOR_IDS = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
  "cream",
] as const;

export type MascotColorId = (typeof MASCOT_COLOR_IDS)[number];

/**
 * The faces an avatar can wear.
 *
 * The face is four levers — gaze, eye width, eye height and separation — so sixteen of them stay
 * distinguishable at 32px. Which one an avatar wears is `EXPRESSION_FOR_AI_STATE` in
 * `app/src/mascot/ids.ts`: the resting face while idle, and a face that matches the work while it is
 * working.
 */
export const MASCOT_EXPRESSION_IDS = [
  "neutral",
  "attentive",
  "surprised",
  "excited",
  "happy",
  "laughing",
  "angry",
  "sad",
  "scared",
  "wary",
  "confused",
  "curious",
  "proud",
  "shy",
  "indifferent",
  "sleepy",
] as const;

export type MascotExpressionId = (typeof MASCOT_EXPRESSION_IDS)[number];

/**
 * A fully specified mascot. Every field is chosen, because every field has a default.
 *
 * Two axes, not three, and the face is not one of them. A mascot's resting face is hashed from its id
 * like everything else about an unchosen mascot, and its working faces come from its state — a person
 * choosing which expression their coworker wears is choosing how their coworker *looks*, and then the
 * coworker goes on looking like that while it is stuck, or while it is streaming, or while it has
 * failed. The face belongs to the work.
 */
export interface MascotChoice {
  shape: MascotShapeId;
  color: MascotColorId;
}

/**
 * What a mascot looks like before anybody chooses.
 *
 * `ink` rather than a colour, and `circle` rather than one of the seven other silhouettes, because
 * the unchosen case is the overwhelming majority: every agent that has never been customised, and
 * any agent whose stored choice predates this. It should look like a neutral blob that happens to
 * be a coworker, not like a mascot someone picked.
 */
export const DEFAULT_MASCOT: MascotChoice = {
  shape: "circle",
  color: "blue",
};

/**
 * The face an avatar rests in, for a caller that needs one without an agent to read a state off.
 *
 * Not a default in the sense `DEFAULT_MASCOT` is one: this is a face and no face is chosen by
 * default. It is here because `resolveMascotChoice` is a total function over arbitrary input and a
 * consumer of it may have to draw something.
 */
export const DEFAULT_MASCOT_EXPRESSION: MascotExpressionId = "neutral";

/** Narrow an unknown value to a shape id, without pretending a wrong value is close. */
export function isMascotShapeId(value: unknown): value is MascotShapeId {
  return (
    typeof value === "string" &&
    (MASCOT_SHAPE_IDS as readonly string[]).includes(value)
  );
}

export function isMascotColorId(value: unknown): value is MascotColorId {
  return (
    typeof value === "string" &&
    (MASCOT_COLOR_IDS as readonly string[]).includes(value)
  );
}

export function isMascotExpressionId(
  value: unknown,
): value is MascotExpressionId {
  return (
    typeof value === "string" &&
    (MASCOT_EXPRESSION_IDS as readonly string[]).includes(value)
  );
}

/**
 * Read a stored mascot, filling any absent field with its default.
 *
 * This is the whole backwards-compatibility story: `agent_profiles.mascot_*` is nullable and every
 * row written before this feature has both columns null, so the client resolves an agent it has never
 * seen into a mascot without a backfill migration. A field that is present but unrecognised — a row
 * written by a newer version of this app, or a hand-edited one — falls back to the default for that
 * field alone rather than rejecting the mascot whole, so one bad column cannot cost somebody their
 * colour.
 *
 * An `expression` in the input is dropped rather than read. It was a column until migration 0070 and
 * an API field until the same change, and both are gone because the face follows the work rather than
 * a preference; reading it here would mean a client could still send one and believe it worked.
 */
export function resolveMascotChoice(input: unknown): MascotChoice {
  if (typeof input !== "object" || input === null) return DEFAULT_MASCOT;
  const raw = input as Partial<Record<keyof MascotChoice, unknown>>;
  return {
    shape: isMascotShapeId(raw.shape) ? raw.shape : DEFAULT_MASCOT.shape,
    color: isMascotColorId(raw.color) ? raw.color : DEFAULT_MASCOT.color,
  };
}

/**
 * How many distinct mascots exist: 63, from seven shapes and nine colours.
 *
 * Worth knowing because it is the reason an unchosen mascot needs a stable seed rather than a random
 * one, and because it is the ceiling the customizer navigates. It was 1,536 while the face was a third
 * axis a person picked; a face chosen from work rather than from taste multiplies this by nothing,
 * because it is not a thing anybody chooses.
 */
export const MASCOT_COMBINATION_COUNT =
  MASCOT_SHAPE_IDS.length * MASCOT_COLOR_IDS.length;
