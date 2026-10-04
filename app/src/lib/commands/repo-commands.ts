import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { CommandOption } from "@/components/channels/composer";
import {
  agentPluginsQueryOptions,
  type GrantedPlugins,
} from "@/lib/plugins/queries";

/**
 * The only part of a granted skill this cares about.
 *
 * Structurally `GrantedPlugins["skills"][number]`, named rather than written out so this stays the
 * granted shape if that payload grows: this list is built from the grant endpoint, not from the
 * Skills page, and the two are not the same rows.
 */
type RepoBearingSkill = Pick<
  GrantedPlugins["skills"][number],
  "slug" | "title" | "repo"
>;

/**
 * The repositories this Bot's granted skills point at, as `/` commands a picker can insert.
 *
 * The three `repo_*` tools are already offered to any Bot carrying a repo-bearing skill, so this
 * command grants nothing and reaches nothing new. What it changes is what the model is asked to do
 * with them: an unprompted model answers from what it knows about a project, and the repository is
 * only opened when somebody's question makes opening it the obvious first move.
 *
 * Namespaced `repo-` rather than reusing the skill's slug on purpose. A chip's id is what resolves
 * its instruction on send, so sharing the slug would make one keystroke carry both the skill's
 * instruction and this one — and the transcript badge can only ever name the first of them.
 *
 * Pure and exported separately from the hook, so the picker and the menu are demonstrably built
 * from the same rows.
 */
export function repoCommands(
  skills: readonly RepoBearingSkill[],
  reserved: ReadonlySet<string> = new Set(),
): CommandOption[] {
  const taken = new Set(reserved);
  const commands: CommandOption[] = [];

  for (const skill of skills) {
    if (!skill.repo) continue;

    const slug = `repo-${skill.slug}`;
    if (taken.has(slug)) continue;
    taken.add(slug);

    /*
     * The branch and folder the author chose, named here because they are what decide whether a
     * file the model wants is in this repository at all — and `repo_overview` reports the branch it
     * read rather than the one that was asked for.
     */
    const where = [skill.repo.ref, skill.repo.path && `${skill.repo.path}/`]
      .filter(Boolean)
      .join(" ");

    commands.push({
      id: slug,
      name: slug,
      description: skill.repo.url,
      kind: "chip" as const,
      hidden: true,
      prompt: [
        `Answer from the repository \`${skill.repo.url}\`${where ? ` at ${where}` : ""}.`,
        "Do not answer from what you already know about this project: read what is actually there.",
        "Start with repo_overview, then repo_search to find a path and repo_read_file to read it.",
      ].join(" "),
    });
  }

  return commands;
}

export function useRepoCommands(
  agentId: string,
  reserved: ReadonlySet<string> = new Set(),
): CommandOption[] {
  const { data } = useQuery(agentPluginsQueryOptions(agentId));

  return useMemo(
    () => repoCommands(data?.skills ?? [], reserved),
    [data, reserved],
  );
}
