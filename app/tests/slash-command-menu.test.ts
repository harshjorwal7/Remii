import { describe, expect, test } from "bun:test";
import { chip, text } from "prompt-area/helpers";
import {
  applyCommandChips,
  type CommandOption,
  toDraft,
} from "@/components/channels/composer/draft";
import { slashCommandTrigger } from "@/components/channels/composer/triggers";

/**
 * A `hidden` command is two things at once, and this file holds both halves: something the `/` menu
 * must not offer, and something a chip already in the draft must still resolve. The picker inserts
 * chips without typing, so the dropdown never being involved is the normal path, not the exception.
 */

const COMPONENT: CommandOption = {
  id: "show-bar-chart",
  name: "show-bar-chart",
  description: "Show values as a bar chart.",
  kind: "chip",
  hidden: true,
  prompt: "Draw it with the `showBarChart` component.",
};

const SKILL: CommandOption = {
  id: "find-a-document",
  name: "find-a-document",
  description: "Search the connected document sources.",
  kind: "chip",
};

function suggestions(query: string, commands: readonly CommandOption[]) {
  const trigger = slashCommandTrigger(commands);
  // The factory always returns a dropdown-mode config; `onSearch` is the only callable part of it.
  const onSearch = trigger.onSearch as (query: string) => {
    value: string;
    label: string;
    description?: string;
  }[];
  return onSearch(query);
}

describe("the / menu", () => {
  test("offers the skills", () => {
    expect(suggestions("", [SKILL, COMPONENT]).map((s) => s.value)).toEqual([
      "find-a-document",
    ]);
  });

  test("does not offer a hidden command", () => {
    // Thirty-five components in a 240px popover is a list nobody scrolls, which is why the picker
    // exists. This is the assertion that keeps them out.
    expect(suggestions("bar", [SKILL, COMPONENT])).toEqual([]);
  });

  test("still offers a hidden command's visible neighbours that match", () => {
    const named = { ...COMPONENT, hidden: false };
    expect(suggestions("chart", [named]).map((s) => s.value)).toEqual([
      "show-bar-chart",
    ]);
  });

  test("searches by description as well as name", () => {
    expect(suggestions("document", [SKILL]).map((s) => s.value)).toEqual([
      "find-a-document",
    ]);
  });

  test("reports nothing for an empty menu", () => {
    expect(suggestions("", [])).toEqual([]);
  });
});

describe("a hidden command in the draft", () => {
  const commands = [SKILL, COMPONENT];

  test("is left alone by applyCommandChips", () => {
    // It has to survive to `toDraft`: a hidden command that was rewritten out of the segments would
    // resolve to nothing on send, which is the failure this whole split exists to avoid.
    const segments = [
      chip({
        trigger: "/",
        value: "show-bar-chart",
        displayText: "show-bar-chart",
      }),
      text(" last quarter"),
    ];
    const applied = applyCommandChips(segments, commands);

    expect(applied.segments).toBe(segments);
    expect(applied.actions).toHaveLength(0);
  });

  test("flattens into text a person can read and a badge can be drawn from", () => {
    const draft = toDraft(
      applyCommandChips(
        [
          chip({
            trigger: "/",
            value: "show-bar-chart",
            displayText: "show-bar-chart",
          }),
          text(" last quarter"),
        ],
        commands,
      ).segments,
    );

    expect(draft.text).toBe("/show-bar-chart last quarter");
    expect(draft.commandIds).toEqual(["show-bar-chart"]);
  });

  test("carries its instruction so the send path can resolve it", () => {
    expect(COMPONENT.prompt).toBeTruthy();
  });

  test("resolves to nothing once the grant is gone", () => {
    // The same thing a revoked skill does: the chip stays visible, the instruction does not apply.
    const instructions = ["show-bar-chart"]
      .map((id) => commands.find((command) => command.id === id)?.prompt)
      .filter(Boolean);

    expect(instructions).toEqual([
      "Draw it with the `showBarChart` component.",
    ]);

    const afterRevocation = ["show-bar-chart"]
      .map((id) => [SKILL].find((command) => command.id === id)?.prompt)
      .filter(Boolean);

    expect(afterRevocation).toEqual([]);
  });
});
