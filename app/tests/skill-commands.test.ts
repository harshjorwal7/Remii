import { describe, expect, test } from "bun:test";
import type { PluginSkill } from "@/lib/plugins/queries";
import { skillCommands } from "@/lib/plugins/skill-commands";

const granted = (slug: string): PluginSkill => ({
  id: slug,
  slug,
  ownerUserId: null,
  title: slug,
  summary: `summary of ${slug}`,
  instructions: `instructions of ${slug}`,
  origin: "catalogue",
  installedBy: null,
  grantedTo: ["bot-1"],
  tools: [],
  repo: null,
});

describe("skillCommands", () => {
  test("maps every visible skill to a command, enabled or not", () => {
    const commands = skillCommands([granted("a"), granted("b")], "bot-1");

    expect(commands.map((c) => c.id)).toEqual(["a", "b"]);
    expect(commands[0]?.kind).toBe("chip");
    expect(commands[0]?.prompt).toContain("instructions of a");
  });

  test("labels a skill that is not enabled for the Bot", () => {
    const commands = skillCommands(
      [{ ...granted("a"), grantedTo: [] }],
      "bot-1",
    );

    expect(commands[0]?.description).toContain("Not enabled for this Bot");
  });

  test("leaves a granted skill's summary unlabelled", () => {
    const commands = skillCommands([granted("a")], "bot-1");

    expect(commands[0]?.description).toBe("summary of a");
  });
});
