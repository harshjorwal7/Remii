import { describe, expect, test } from "bun:test";
import { componentCommands } from "@/lib/commands/component-commands";
import { commandSlug } from "@/lib/commands/slug";
import type { GrantedComponent } from "@/lib/components/queries";

/**
 * A component chip is a skill chip with a different payload, so what matters is that the name is
 * typeable and that the id is unique against everything else in the same namespace.
 */

function granted(
  name: string,
  description = "Show something.",
): GrantedComponent {
  return { name, description, title: name, kind: "card" };
}

describe("commandSlug", () => {
  test("kebabs a camelCase tool name into something typeable", () => {
    // Not cosmetic: the transcript's chip regex is lower-case only, so an un-kebabed name would
    // go out as prose with no badge beside it.
    expect(commandSlug("showBarChart")).toBe("show-bar-chart");
    expect(commandSlug("askApproval")).toBe("ask-approval");
  });

  test("collapses anything that is not a lower-case letter, digit or hyphen", () => {
    expect(commandSlug("custom_My Widget")).toBe("custom-my-widget");
    expect(commandSlug("weird!!name")).toBe("weird-name");
  });

  test("trims leading and trailing separators", () => {
    expect(commandSlug("_privateThing_")).toBe("private-thing");
  });

  test("returns nothing for a name with nothing typeable in it", () => {
    // The caller drops these rather than offering a command nobody can type.
    expect(commandSlug("!!!")).toBe("");
  });
});

describe("componentCommands", () => {
  test("registers a held component as a chip carrying the tool name", () => {
    const commands = componentCommands([granted("showBarChart")]);

    expect(commands).toHaveLength(1);
    expect(commands[0].id).toBe("show-bar-chart");
    expect(commands[0].name).toBe("show-bar-chart");
    expect(commands[0].kind).toBe("chip");
  });

  test("keeps the chip out of the dropdown but in the resolution table", () => {
    // Hidden because the menu offers one `/components` entry rather than thirty-five of these.
    // Not absent, because a chip already in the draft still has to resolve on send.
    expect(componentCommands([granted("showTable")])[0].hidden).toBe(true);
  });

  test("tells the model to draw rather than to describe", () => {
    const [command] = componentCommands([granted("showPieChart")]);

    expect(command.prompt).toContain("showPieChart");
    expect(command.prompt).toContain("rather than answering in prose");
  });

  test("does not restate the schema the tool definition already carries", () => {
    // The description reaches the model as a tool either way; repeating it would spend context.
    const [command] = componentCommands([
      granted("showTable", "Supply up to eight columns."),
    ]);

    expect(command.prompt).not.toContain("eight columns");
  });

  test("carries the published description for the menu", () => {
    expect(
      componentCommands([granted("showTable", "Eight columns, 100 rows.")])[0]
        .description,
    ).toBe("Eight columns, 100 rows.");
  });

  test("yields to a skill that already owns the name", () => {
    // Two commands answering to one chip would send two instructions for one keystroke.
    const commands = componentCommands(
      [granted("showTable")],
      new Set(["show-table"]),
    );

    expect(commands).toEqual([]);
  });

  test("keeps two components whose names kebab the same apart by offering only one", () => {
    const commands = componentCommands([
      granted("showTable"),
      granted("show_table"),
    ]);

    expect(commands).toHaveLength(1);
  });

  test("drops a component nobody could type", () => {
    expect(componentCommands([granted("!!!")])).toEqual([]);
  });

  test("registers every held component, so the picker has one chip per choice", () => {
    const commands = componentCommands([
      granted("showBarChart"),
      granted("askApproval"),
      granted("showActivityReport"),
    ]);

    expect(commands.map((command) => command.id)).toEqual([
      "show-bar-chart",
      "ask-approval",
      "show-activity-report",
    ]);
  });
});
