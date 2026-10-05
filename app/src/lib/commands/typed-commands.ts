import type { CommandOption } from "@/components/channels/composer";
import { normalizeCommandName } from "@/lib/commands/slug";

/**
 * Resolve hand-typed `/command` text into command ids, so a command typed straight into the box
 * (rather than picked from the `/` dropdown) still reaches the send path with its instruction.
 *
 * Only the LEADING run of `/word` tokens is a command candidate — a slash mid-sentence is ordinary
 * prose, and a `/word` the command table does not know stops the scan entirely rather than
 * guessing further into the message.
 *
 * Matching is by the normalised name, so `/barchart`, `/bar-chart` and `/showBarChart` all reach
 * the same command, and a skill slug wins over a same-named component because first match in the
 * assembled list wins (skills are assembled first).
 */
export function typedCommandIds(
  text: string,
  commands: readonly CommandOption[],
): string[] {
  const byName = new Map<string, string>();
  for (const command of commands) {
    /*
     * An `action` is not a command in this sense: `/components` opens a picker in the browser and
     * carries nothing to the runtime, so resolving it here would put an id on the send that resolves
     * to no instruction. Typed by hand it stays the prose it was.
     */
    if (command.kind === "action") continue;
    const key = normalizeCommandName(command.name);
    if (key && !byName.has(key)) {
      byName.set(key, command.id);
    }
  }

  const ids: string[] = [];
  let rest = text;
  for (;;) {
    const match = /^\s*\/([a-zA-Z0-9-]+)/.exec(rest);
    if (!match) break;
    const id = byName.get(normalizeCommandName(match[1]));
    if (!id) break;
    ids.push(id);
    rest = rest.slice(match[0].length);
  }
  return ids;
}
