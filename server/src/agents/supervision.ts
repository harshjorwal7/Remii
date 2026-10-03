// Strict per-user SaaS sandbox: the column stays
// in the database for compatibility, but every row is private.
import { GOG_TOOL_NAMES } from "../remi/gog";
import { REMI_RESEARCH_TOOL_NAMES } from "../remi/tools";

/**
 * What makes a Bot a supervisor, and what it therefore may not do.
 *
 * A supervisor is a Bot whose job is to get other Bots to do the work. That is
 * only a role if it is also a limit, so the flag below is enforced in three
 * places — the grants it is offered, the tools built for it, and the tools a
 * browser is allowed to hand it — and all three read from here.
 *
 * Why it lives in its own module: the three gates are in three different files
 * and a supervisor is only real if all three agree. A list of what a supervisor
 * loses, written once, is the one thing that cannot drift out of step with
 * itself. A gate that named its own tools would drift the first time somebody
 * added a tool to the wrong list.
 */

/**
 * Whether a row's `agents.override` blob marks the Bot as a supervisor.
 *
 * `agents.override` is a shared blob that other things will grow keys into, so
 * it is read as a stranger: a non-object, a missing key, or any value that is
 * not the boolean `true` all mean "a worker". That is the safe direction — a
 * worker keeps every tool it had, so a typo in a row costs nothing.
 */
export function readDelegationOnly(override: unknown): boolean {
  if (!override || typeof override !== "object") return false;
  return (override as { delegationOnly?: unknown }).delegationOnly === true;
}

/**
 * The capabilities a supervisor is not given, by tool name.
 *
 * Both groups are the same kind of thing — a way of *doing* the work rather
 * than arranging for it — and they are listed together because they are lost
 * together:
 *
 * - The `gog` set is Google Workspace through the machine's own CLI. It is not
 *   grant-gated at all, which is the part that is easy to miss: it is offered to
 *   whichever Bot is running whenever the binary resolves, so a supervisor that
 *   kept it would still be able to send mail even with every app grant deleted.
 *   `gog_status` goes with the rest, since knowing the CLI is wired up is only
 *   interesting to a Bot that was going to use it.
 * - Web search and web fetch are how a supervisor would simply do the research
 *   herself. Everything else in the Remi tool set is a supervisor's own
 *   bookkeeping — memory, notes, todos, schedules, artifacts, the brief and
 *   debrief either side of a handoff — and stays.
 */
export const SUPERVISOR_DROPPED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...GOG_TOOL_NAMES,
  ...REMI_RESEARCH_TOOL_NAMES,
]);

/**
 * The tools a supervisor keeps: everything it was offered that is not on the
 * list above.
 *
 * Applied as a filter rather than as an allow-list on purpose. An allow-list
 * would have to be updated every time a supervisor tool is added, and the day
 * somebody forgot, a supervisor would quietly lose the ability to delegate —
 * the one failure that looks exactly like a supervisor working correctly.
 */
export function withoutSupervisorTools<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  return tools.filter((tool) => !SUPERVISOR_DROPPED_TOOL_NAMES.has(tool.name));
}

/**
 * Gate one: what a Bot is granted, decided by whether it is a supervisor.
 *
 * Takes the two sources as functions rather than as lists so that the granted
 * read is never made for a supervisor. That is not only a cost: reading grants
 * writes the audit row and, for a deployment with a Composio workbench,
 * provisions the sandbox the tools would run in. A supervisor that is never
 * offered an app should leave no trace of having looked.
 *
 * Returns a new array, so a caller adding to the result cannot write back into
 * a list another Bot is holding.
 */
export async function toolsForSupervisorGate<T>(options: {
  supervisor: boolean;
  granted: () => Promise<readonly T[]>;
  /** Supplied rather than spread so the pair can be read as one decision. */
  alsoGranted: () => readonly T[];
}): Promise<T[]> {
  if (options.supervisor) return [];
  return [...(await options.granted()), ...options.alsoGranted()];
}
