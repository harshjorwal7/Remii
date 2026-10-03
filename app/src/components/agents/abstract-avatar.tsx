import { MascotAvatar } from "@/mascot/mascot-avatar";
import type { MascotChoice } from "../../../../shared/mascot-ids";

/**
 * A coworker's mascot at roster size.
 *
 * The wrapper exists so there is exactly one place that decides how a coworker is announced, and it
 * is the same rule `boring-avatars` was given: the name is the accessible name of the image, and the
 * drawing inside is hidden so a screen reader reads the coworker once. `MascotAvatar` applies it
 * itself; this exists to keep the call sites reading `AbstractAvatar` rather than repeating the
 * seed-plus-name pairing in nine places.
 *
 * `mascot` is the stored choice and is usually null, which is the common case and not a
 * placeholder: an undressed coworker is seeded from its own id, so passing null still produces a
 * distinct mascot for every agent.
 */
export function AbstractAvatar({
  name,
  seed,
  mascot,
  size = 40,
}: {
  name: string;
  seed: string;
  /** A chosen mascot. Absent or null falls back to the one seeded from `seed`. */
  mascot?: Partial<MascotChoice> | null;
  size?: number;
}) {
  return (
    // Deliberately not clipped to a circle. Six of the seven silhouettes are not circles, and a
    // pebble with its edge smoothed or a triangle with its corners cut is a different mascot — the
    // seed and the picker both promise seven shapes, so the avatar has to be allowed to show all
    // seven. The `circle` shape supplies its own round edge for anybody who wants one.
    <MascotAvatar name={name} seed={seed} choice={mascot} size={size} />
  );
}
