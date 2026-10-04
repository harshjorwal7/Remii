import type { PromptAreaHandle } from "prompt-area";
import { useMemo, useRef, useState } from "react";
import type { CommandOption } from "@/components/channels/composer";
import { useComponentCommands } from "@/lib/commands/component-commands";
import { useRepoCommands } from "@/lib/commands/repo-commands";
import { useSkillCommands } from "@/lib/plugins/skill-commands";

export type CommandPicker = "components" | "repo" | null;

/**
 * The whole `/` surface for one Bot, assembled from the three things that can go in it.
 *
 * THE ORDER IS THE OPPOSITE OF THE VISUAL ONE, and that is the point. `components` and `repo` are
 * the entries a person sees; every component chip follows them. A chip's id is what resolves its
 * instruction on send, so a skill and a component sharing a slug would otherwise be a coin toss
 * decided by array order — skills go first because a skill is a thing a deployment ships by name
 * and a component's slug is derived from a tool name anybody could have written.
 *
 * Pure and exported so those rules can be tested without a channel, and so the running channel and
 * the compose screen are demonstrably built the same way.
 */
export function assembleCommands(input: {
  skillCommands: readonly CommandOption[];
  componentCommands: readonly CommandOption[];
  repoCommands: readonly CommandOption[];
  openComponents: () => void;
  openRepo: () => void;
}): CommandOption[] {
  const entries: CommandOption[] = [...input.skillCommands];

  /*
   * A `/` entry is a promise that there is something behind it. Offering `/components` to a Bot that
   * holds none, or `/repo` to one whose skills point at no repository, is an entry that opens onto
   * an explanation of why the person cannot have what they just asked for.
   */
  if (input.componentCommands.length > 0) {
    entries.push({
      id: "components",
      name: "components",
      description: "Ask for something to be drawn on screen",
      kind: "action",
      run: input.openComponents,
    });
  }

  if (input.repoCommands.length > 0) {
    entries.push({
      id: "repo",
      name: "repo",
      description: "Answer from one of this Bot's repositories",
      kind: "action",
      run: input.openRepo,
    });
  }

  entries.push(...input.componentCommands, ...input.repoCommands);

  return entries;
}

/**
 * The `/` surface for one Bot, in one place.
 *
 * Two callers need this identical assembly — a running channel and the compose screen that starts
 * one — and the second is exactly where the first version of this went wrong: it built the skill
 * menu and then discarded what a chip stood for, so a `/` chip drawn beside the first message was a
 * decoration the Bot never saw. One hook means the two surfaces cannot drift apart.
 */
export function useComposerCommands(agentId: string): {
  commands: CommandOption[];
  editorRef: { current: PromptAreaHandle | null };
  picker: CommandPicker;
  closePicker: () => void;
  insert: (slug: string) => void;
} {
  const editorRef = useRef<PromptAreaHandle>(null);
  const [picker, setPicker] = useState<CommandPicker>(null);

  const skillCommands = useSkillCommands(agentId);
  /*
   * Skills claim their names first. A skill slug is chosen by whoever wrote the skill and is
   * deployment-wide; a component slug is derived here from a tool name, so it is the side that
   * should give way on a collision.
   */
  const skillSlugs = useMemo(
    () => new Set(skillCommands.map((command) => command.id)),
    [skillCommands],
  );
  const componentCommands = useComponentCommands(agentId, skillSlugs);
  const repoCommands = useRepoCommands(agentId, skillSlugs);

  const commands = useMemo(
    () =>
      assembleCommands({
        skillCommands,
        componentCommands,
        repoCommands,
        openComponents: () => setPicker("components"),
        openRepo: () => setPicker("repo"),
      }),
    [componentCommands, repoCommands, skillCommands],
  );

  return {
    commands,
    editorRef,
    picker,
    closePicker: () => setPicker(null),
    /*
     * `insertChip` rather than writing segments: the editor owns its own value, and an injected chip
     * has to go through the same change handler a typed one does or `applyCommandChips` never sees
     * it. The display text is the slug, which is what makes the message go out reading
     * `/show-bar-chart …` and the transcript draw a badge beside it.
     */
    insert: (slug: string) => {
      editorRef.current?.insertChip({
        trigger: "/",
        value: slug,
        displayText: slug,
      });
      editorRef.current?.focus();
    },
  };
}
