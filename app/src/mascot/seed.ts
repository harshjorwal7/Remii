/**
 * Which mascot a coworker gets when nobody chose one, and the face it rests in.
 *
 * The implementation lives in `shared/mascot-seed.ts` so the app and the server resolve the same
 * seeded mascot from the same agent id. This module re-exports it so the app's existing imports keep
 * working, and to honour the note that the facing rule lives next to the shape/colour vocabulary.
 */
export {
  CHOOSABLE_COLOR_IDS,
  DEFAULT_COLOR_SLOTS,
  mascotChoiceForSeed,
  mergeMascotChoice,
  RESERVED_SEED_COLORS,
  RESTING_EXPRESSION_IDS,
  restingExpressionForSeed,
  SEEDED_COLOR_SLOTS,
} from "../../../shared/mascot-seed";
