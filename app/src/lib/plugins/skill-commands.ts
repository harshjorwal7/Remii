import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { CommandOption } from "@/components/channels/composer";
import { type PluginSkill, skillListQueryOptions } from "@/lib/plugins/queries";

/**
 * THE LIST IS THE SAME ONE THE SKILLS PAGE DRAWS, and every row is a command. `GET
 * /api/plugins/skills` returns every skill the caller can see — the deployment's and their own,
 * granted to this Bot or not — so a skill added on the Skills page shows up in the composer's menu
 * without waiting for a Bot grant.
 *
 * A SKILL THAT IS NOT ENABLED FOR THIS BOT IS STILL A COMMAND, BUT IS LABELLED. The Bot then
 * holds no tools for that skill, so the run answers from prose rather than executing anything;
 * the label makes that visible in the menu before the person commits to it.
 */
export function skillCommands(
  skills: readonly PluginSkill[],
  agentId: string,
): CommandOption[] {
  return skills.map((skill) => {
    const enabled = skill.grantedTo.includes(agentId);
    return {
      id: skill.slug,
      name: skill.slug,
      description: enabled
        ? skill.summary || skill.title
        : `Not enabled for this Bot. ${skill.summary || skill.title}`,
      kind: "chip" as const,
      /*
       * A CHIP, NOT AN EXPANSION. `prompt` used to paste the skill's whole instruction into the
       * box, which meant a person watched a paragraph they did not write appear over the message
       * they were typing, and had to scroll past it to reach their own words.
       *
       * The chip stays, one token wide, and `channel-chat` reads `draft.commandIds` on send and
       * puts the instruction in front of the run.
       */
      prompt: skill.instructions,
    };
  });
}

export function useSkillCommands(agentId: string): CommandOption[] {
  const { data } = useQuery(skillListQueryOptions());
  return useMemo(
    () => skillCommands(data?.skills ?? [], agentId),
    [data, agentId],
  );
}
