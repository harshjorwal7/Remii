/**
 * How long a person's desktop stays awake after nothing happens on it.
 *
 * ONE NUMBER, DECLARED HERE, because it was written in five places that could disagree and two of
 * them were already wrong.
 *
 * The behaviour came from `PLANS.pro.idleStopMinutes` and the prompt quoted the figure back at the
 * model in three separate strings plus a skill, all of them hardcoding the words "four minutes". That
 * is four copies of a number that decides both what the product costs to run and what the agent
 * believes about its own machine, and the comment beside the behaviour explicitly refused to let the
 * two drift. Meanwhile `E2B_AUTOSTOP_MINUTES` was parsed, validated, documented in `.env.example` and
 * then never read by anything: an operator who set it to 30 to stop paying for resume latency was
 * paying for a 4-minute pause anyway, with nothing to say so.
 *
 * So the number lives here, the plan and the prompts both derive from it, and
 * `desktopIdleStopMinutes()` in the server reads the environment over the top of it. Setting
 * `E2B_AUTOSTOP_MINUTES` now does what it claims; leaving it unset keeps the plan's number, which
 * keeps the prompt and the behaviour identical.
 */

/**
 * The default, in minutes, of nothing happening before a desktop is paused.
 *
 * Four, because that is what the plan has always charged for and the guidance was written around it.
 * Raising it is a cost decision rather than a technical one: a paused sandbox is not billed, so this
 * number is very nearly the monthly computer bill for an idle user.
 */
export const DESKTOP_IDLE_STOP_MINUTES = 4;

/**
 * The number that is actually in force: the environment's if it is set, the default otherwise.
 *
 * This exists so the prompt and the behaviour read the SAME source rather than two sources that
 * happen to agree today. Without it, setting `E2B_AUTOSTOP_MINUTES=30` would give an operator a
 * desktop that stays up for half an hour while the agent is still being told — in three separate
 * sentences — that its machine switches off after four, which is precisely the drift the original
 * comment refused to allow.
 *
 * `process` is read defensively rather than assumed: this module is imported by `bot-prompt.ts`,
 * which reaches both the server and its tests, and an undefined `process` has to mean "default"
 * rather than a crash. The server calls {@link effectiveIdleStopMinutes} through the same helper, so
 * there is one reader rather than two that agree by inspection.
 *
 * The value is read per call rather than cached at import, because the module graph is built before
 * anything has a chance to set the variable in a test, and a cached read would silently ignore it.
 */
export function effectiveIdleStopMinutes(
  environment?: Record<string, string | undefined>,
): number {
  const source =
    environment ??
    (globalThis.process?.env as Record<string, string | undefined> | undefined);
  const raw = source?.E2B_AUTOSTOP_MINUTES?.trim();
  if (!raw) return DESKTOP_IDLE_STOP_MINUTES;
  const minutes = Number(raw);
  // A bad value falls back rather than throwing here. `config.ts` is what refuses a malformed
  // setting, at boot, where refusing it is useful; this runs while composing a prompt, where
  // throwing would take down a module load over a sentence.
  return Number.isFinite(minutes) && minutes >= 0
    ? minutes
    : DESKTOP_IDLE_STOP_MINUTES;
}

/**
 * The same number as the prompt spells it.
 *
 * The agent is told how long its computer sleeps in prose, and a machine that behaves differently
 * from the one it was told about is worse than either number on its own — so the prose is generated
 * rather than typed. Kept as a function because "4" and "four" are both wanted: the skill text reads
 * as a sentence to a person and the prompt text reads as a sentence to a model.
 */
export function idleStopPhrase(
  minutes: number = effectiveIdleStopMinutes(),
): string {
  return minutes === 4 ? "four minutes" : `${minutes} minutes`;
}

/** The figure on its own, for the sentences that quote a number rather than spell it. */
export function idleStopNumber(
  minutes: number = effectiveIdleStopMinutes(),
): string {
  return String(minutes);
}
