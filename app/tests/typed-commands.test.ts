import { describe, expect, test } from "bun:test";
import type { CommandOption } from "@/components/channels/composer";
import { typedCommandIds } from "@/lib/commands/typed-commands";

/**
 * A command typed straight into the box never becomes a chip — prompt-area only materialises one on
 * selection — so without this it reached the model as prose with no instruction behind it. These
 * hold the resolution, and the fact that it stops at the first token it does not recognise.
 */

const commands: CommandOption[] = [
  // Skills first, as `assembleCommands` orders them: a name a deployment chose wins a collision.
  { id: "bar-chart", name: "bar-chart", kind: "chip", prompt: "Draw a chart." },
  { id: "show-bar-chart", name: "show-bar-chart", kind: "chip", hidden: true },
  { id: "table", name: "table", kind: "chip" },
  { id: "find-a-document", name: "find-a-document", kind: "chip" },
  { id: "components", name: "components", kind: "action" },
];

describe("typedCommandIds", () => {
  test("resolves the leading token", () => {
    expect(typedCommandIds("/table revenue by team", commands)).toEqual([
      "table",
    ]);
  });

  test("resolves every spelling of a name to the same command", () => {
    // The transcript badge and this must agree, or a chip arrives with no instruction behind it.
    for (const typed of ["/barchart", "/bar-chart", "/BarChart"]) {
      expect(typedCommandIds(`${typed} x`, commands)).toEqual(["bar-chart"]);
    }
  });

  test("resolves a hidden command, which is what a parked draft may carry", () => {
    expect(typedCommandIds("/show-bar-chart x", commands)).toEqual([
      "show-bar-chart",
    ]);
  });

  test("reads a run of commands", () => {
    expect(typedCommandIds("/table /find-a-document please", commands)).toEqual(
      ["table", "find-a-document"],
    );
  });

  test("stops at a word that is not a command", () => {
    // Rather than reaching further into the message: a slash later on is somebody's prose.
    expect(typedCommandIds("/shrug /table", commands)).toEqual([]);
    expect(typedCommandIds("look at /table", commands)).toEqual([]);
  });

  test("ignores a command that only makes sense as a dropdown pick", () => {
    expect(typedCommandIds("/components something", commands)).toEqual([]);
  });

  test("resolves nothing from an empty table", () => {
    expect(typedCommandIds("/table", [])).toEqual([]);
  });
});
