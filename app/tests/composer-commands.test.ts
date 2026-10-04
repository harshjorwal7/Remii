import { describe, expect, test } from "bun:test";
import type { CommandOption } from "@/components/channels/composer";
import { assembleCommands } from "@/lib/commands/use-composer-commands";

/**
 * The assembly rule this whole change rests on: the `/` menu is short, and the long list lives
 * behind a picker as hidden chips that still resolve. These are the tests for the two halves of
 * that, and for the order that decides which of two same-named commands wins.
 */

const skill = (id: string): CommandOption => ({
  id,
  name: id,
  description: `${id} skill`,
  kind: "chip",
});

const component = (id: string): CommandOption => ({
  id,
  name: id,
  description: `${id} component`,
  kind: "chip",
  hidden: true,
  prompt: "Draw it.",
});

const noop = () => {};

function assemble(input: {
  skills?: string[];
  components?: string[];
  repos?: string[];
}) {
  return assembleCommands({
    skillCommands: (input.skills ?? []).map(skill),
    componentCommands: (input.components ?? []).map(component),
    repoCommands: (input.repos ?? []).map((id) => ({
      ...component(id),
      prompt: "Read it.",
    })),
    openComponents: noop,
    openRepo: noop,
  });
}

describe("assembleCommands", () => {
  test("offers the skills and nothing else for a Bot with only skills", () => {
    expect(assemble({ skills: ["find-a-document"] }).map((c) => c.id)).toEqual([
      "find-a-document",
    ]);
  });

  test("adds one components entry rather than one per component", () => {
    // The reason a picker exists: thirty-five components in a 240px popover is a list nobody
    // scrolls, and prompt-area's dropdown has no section headers to hide them behind.
    const commands = assemble({
      components: ["show-bar-chart", "show-table", "ask-approval"],
    });

    expect(commands.map((c) => c.id)).toEqual([
      "components",
      "show-bar-chart",
      "show-table",
      "ask-approval",
    ]);
  });

  test("keeps the picker entry out of the way of the skills", () => {
    const commands = assemble({
      skills: ["find-a-document"],
      components: ["show-table"],
    });
    expect(commands.map((c) => c.id)).toEqual([
      "find-a-document",
      "components",
      "show-table",
    ]);
  });

  test("adds a repo entry only when a repository is behind it", () => {
    expect(
      assemble({ components: ["show-table"] }).map((c) => c.id),
    ).not.toContain("repo");
    expect(
      assemble({ repos: ["repo-how-we-deploy"] }).map((c) => c.id),
    ).toContain("repo");
  });

  test("the entries run a client action rather than reaching the runtime", () => {
    // `action` is the one kind whose chip is removed on selection, so the chip never travels.
    const [componentsEntry] = assemble({ components: ["show-table"] });
    expect(componentsEntry.id).toBe("components");
    expect(componentsEntry.kind).toBe("action");
  });

  test("opens the right picker", () => {
    const opened: string[] = [];
    const commands = assembleCommands({
      skillCommands: [],
      componentCommands: [component("show-table")],
      repoCommands: [component("repo-how-we-deploy")],
      openComponents: () => opened.push("components"),
      openRepo: () => opened.push("repo"),
    });

    for (const command of commands) {
      command.run?.();
    }
    expect(opened).toEqual(["components", "repo"]);
  });

  test("puts the hidden chips after the skills, so a skill wins a shared name", () => {
    const commands = assembleCommands({
      skillCommands: [skill("show-table")],
      componentCommands: [component("show-table")],
      repoCommands: [],
      openComponents: noop,
      openRepo: noop,
    });

    // Both rows exist — the second is what a stale picker insert still needs — but the first match
    // is the skill, which is the one a deployment chose by name.
    expect(commands.find((c) => c.id === "show-table")?.description).toBe(
      "show-table skill",
    );
  });

  test("every hidden chip still carries an instruction", () => {
    const commands = assemble({
      components: ["show-table"],
      repos: ["repo-how-we-deploy"],
    });

    for (const command of commands.filter((c) => c.hidden)) {
      expect(command.prompt).toBeTruthy();
    }
  });
});
