/**
 * Reading and writing a coworker's mascot.
 *
 * Its own module because two columns and one projection turn into a rule that is easy to get wrong
 * in two places at once: a row can name none of the axes, some of them, or both, and each of
 * those has to survive a read, a save and a duplicate without collapsing into "the default".
 *
 * The face is not here, and was: `mascot_expression` went with migration 0070, because a mascot's
 * expression follows the work the agent is doing rather than a preference, so the app derives it per
 * frame and there is no value for the server to store.
 */
import {
  isMascotColorId,
  isMascotShapeId,
  type MascotChoice,
} from "../../../shared/mascot-ids";

/**
 * What a row says about a mascot, and `null` when the row says nothing at all.
 *
 * Null is returned only when none of the axes is set. A row with one of them comes back as a partial
 * choice, which is what makes "picked a colour, left the shape to the seed" survive a round trip
 * through the database instead of quietly becoming a fully chosen mascot.
 *
 * A column holding an id this build does not recognise is dropped, and the rest of the row is still
 * returned. The alternative — refusing to map the row — would make one unreadable avatar take down the
 * whole roster query, which is a very large blast radius for a cosmetic field, and the client narrows
 * the same values anyway before it draws anything.
 */
export function readMascot(row: {
  mascotShape: string | null;
  mascotColor: string | null;
}): Partial<MascotChoice> | null {
  const mascot: Partial<MascotChoice> = {};

  if (isMascotShapeId(row.mascotShape)) mascot.shape = row.mascotShape;
  if (isMascotColorId(row.mascotColor)) mascot.color = row.mascotColor;

  return Object.keys(mascot).length > 0 ? mascot : null;
}

/**
 * The two column values for a mascot, ready to insert or update.
 *
 * Only ever called with something the request parser already checked against the closed vocabulary,
 * so there is no validation here and none should be added: the gate belongs in one place, and a second
 * one that disagrees with the first is worse than none.
 *
 * Unset axes become SQL NULL rather than being omitted. That is the difference between "use the
 * seed" and "keep whatever is there", and for an insert they are the same thing; for an update they
 * are not, which is why this is only ever applied to a whole mascot that the caller has decided to
 * replace.
 */
export function mascotColumnValues(
  mascot: Partial<MascotChoice> | null | undefined,
): {
  mascotShape: string | null;
  mascotColor: string | null;
} {
  return {
    mascotShape: mascot?.shape ?? null,
    mascotColor: mascot?.color ?? null,
  };
}

/** A mascot per agent id, as a channel or a roster row carries them. */
export type MascotByAgent = Record<string, Partial<MascotChoice>>;

/**
 * Fold the mascot columns of a joined row set into one map keyed by agent id.
 *
 * Both channel queries already inner-join `agent_profiles`, so the mascot costs two more selected
 * columns rather than a second query — which matters on the roster, where the page is read for every
 * scroll. Rows repeat an agent once per channel it is in, so the last write for an id wins, and all
 * the writes for one id carry the same columns anyway.
 *
 * Only chosen axes are recorded. An agent with no choice is simply absent from the map, and that
 * absence is the signal the client uses to fall back to the seed — so this must not be filled in with
 * defaults here, or the roster would show a guessed mascot that then disagreed with the one the
 * profile screen draws.
 */
export function collectMascots(
  rows: Array<{
    agentId: string;
    mascotShape: string | null;
    mascotColor: string | null;
  }>,
): MascotByAgent {
  const mascots: MascotByAgent = {};
  for (const row of rows) {
    const mascot = readMascot(row);
    if (mascot) mascots[row.agentId] = mascot;
  }
  return mascots;
}
