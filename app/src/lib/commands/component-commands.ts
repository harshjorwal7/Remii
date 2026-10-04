import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { CommandOption } from "@/components/channels/composer";
import { commandSlug } from "@/lib/commands/slug";
import {
  agentComponentsQueryOptions,
  type GrantedComponent,
} from "@/lib/components/queries";

/**
 * The components this Bot holds, as `/` commands a picker can insert.
 *
 * These are `hidden`: the dropdown shows one `/components` entry and the components behind it,
 * because a flat menu of every granted component is a list nobody scrolls. A chip is still inserted
 * as `/show-bar-chart`, which is what makes it resolve on send and draw a badge in the transcript
 * exactly as a skill does.
 *
 * THE PAYLOAD IS INSTRUCTION, NOT SCHEMA. The model is already handed this component's name and
 * parameters as a tool definition, so repeating them here would spend context restating a tool the
 * model can see. What it cannot infer from a tool list is that a person asked for this one.
 *
 * Pure and exported separately from the hook so the list can be tested without a query client, and
 * so the picker and the menu are demonstrably built from the same rows.
 */
export function componentCommands(
  components: readonly GrantedComponent[],
  reserved: ReadonlySet<string> = new Set(),
): CommandOption[] {
  /*
   * One namespace, so a collision is resolved rather than merged: the skill keeps the name. A
   * deployment can name a skill whatever it likes and nothing stops somebody naming one
   * `show-bar-chart`, and two commands answering to one chip would send two instructions for a
   * keystroke the person made once.
   */
  const taken = new Set(reserved);
  const commands: CommandOption[] = [];

  for (const component of components) {
    const slug = commandSlug(component.name);
    /*
     * An empty slug is a name with nothing in it a person could type, and two of those would
     * collide on the same empty string, so neither is offered.
     */
    if (!slug || taken.has(slug)) continue;
    taken.add(slug);

    commands.push({
      id: slug,
      name: slug,
      description: component.description,
      kind: "chip" as const,
      hidden: true,
      prompt: `The person asked for this on screen. Draw it with the \`${component.name}\` component rather than answering in prose.`,
    });
  }

  return commands;
}

export function useComponentCommands(
  agentId: string,
  reserved: ReadonlySet<string> = new Set(),
): CommandOption[] {
  const { data } = useQuery(agentComponentsQueryOptions(agentId));

  return useMemo(
    () => componentCommands(data ?? [], reserved),
    [data, reserved],
  );
}
