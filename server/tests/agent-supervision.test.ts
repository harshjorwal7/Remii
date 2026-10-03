import { describe, expect, test } from "bun:test";
import {
  readDelegationOnly,
  SUPERVISOR_DROPPED_TOOL_NAMES,
  toolsForSupervisorGate,
  withoutSupervisorTools,
} from "../src/agents/supervision";
import { GOG_TOOL_NAMES } from "../src/remi/gog";
import { REMI_RESEARCH_TOOL_NAMES, REMI_TOOL_NAMES } from "../src/remi/tools";

describe("readDelegationOnly", () => {
  test("is true only for the exact boolean", () => {
    expect(readDelegationOnly({ delegationOnly: true })).toBe(true);
  });

  /*
   * The failure that matters: a row that was meant to make a Bot a supervisor
   * and does not. It reads as a worker, so the Bot quietly keeps every tool it
   * was supposed to have given up, and nothing anywhere says why.
   */
  test.each([
    ["absent", {}],
    ["a string", { delegationOnly: "true" }],
    ["a number", { delegationOnly: 1 }],
    ["null", { delegationOnly: null }],
    ["false", { delegationOnly: false }],
  ])("reads %s as a worker", (_label, override) => {
    expect(readDelegationOnly(override)).toBe(false);
  });

  test.each([
    ["null", null],
    ["a string", "delegationOnly"],
    ["a number", 7],
    ["an array", []],
  ])("survives a non-object override (%s)", (_label, override) => {
    expect(readDelegationOnly(override)).toBe(false);
  });

  test("ignores keys belonging to something else in the shared blob", () => {
    expect(
      readDelegationOnly({
        somethingElse: true,
        other: { delegationOnly: true },
      }),
    ).toBe(false);
  });
});

describe("what a supervisor is not given", () => {
  test("covers the whole Google CLI set, sending included", () => {
    for (const name of GOG_TOOL_NAMES) {
      expect(SUPERVISOR_DROPPED_TOOL_NAMES.has(name)).toBe(true);
    }
    // The one that matters most: `gog` is not grant-gated, so deleting every
    // app grant would not have stopped a supervisor mailing anybody.
    expect(SUPERVISOR_DROPPED_TOOL_NAMES.has("gog_gmail_send")).toBe(true);
  });

  test("covers web search and web fetch", () => {
    for (const name of REMI_RESEARCH_TOOL_NAMES) {
      expect(SUPERVISOR_DROPPED_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  test("takes nothing else from the Remi tool set", () => {
    const kept = REMI_TOOL_NAMES.filter(
      (name) => !SUPERVISOR_DROPPED_TOOL_NAMES.has(name),
    );
    // The bookkeeping a supervisor is built out of: the brief and debrief
    // either side of a handoff, and everything it keeps notes in.
    for (const name of [
      "handoff_brief",
      "handoff_debrief",
      "memory_save",
      "memory_search",
      "todo_add",
      "artifact_create",
      "get_chat_history",
    ]) {
      expect(kept).toContain(name);
    }
    // Only the research pair goes, so the set is genuinely narrow.
    expect(REMI_TOOL_NAMES.length - kept.length).toBe(
      REMI_RESEARCH_TOOL_NAMES.length,
    );
  });
});

describe("withoutSupervisorTools", () => {
  const tool = (name: string) => ({ name });

  test("removes the dropped tools and keeps the rest in order", () => {
    expect(
      withoutSupervisorTools([
        tool("delegate_bot"),
        tool("gog_gmail_send"),
        tool("memory_save"),
        tool("web_search"),
        tool("ask_person"),
      ]).map((entry) => entry.name),
    ).toEqual(["delegate_bot", "memory_save", "ask_person"]);
  });

  test("is unconditional, so the caller is what protects a worker", () => {
    /*
     * Not a licence for a caller to filter everything. This exists so the three
     * gates cannot disagree about the list; whether it runs at all is decided
     * by the supervisor flag, and `buildAgent` is where that is asserted.
     */
    const all = [
      tool("delegate_bot"),
      tool("gog_gmail_send"),
      tool("web_search"),
    ];
    expect(withoutSupervisorTools(all).map((entry) => entry.name)).toEqual([
      "delegate_bot",
    ]);
  });

  test("returns a new array rather than the one it was given", () => {
    const tools = [tool("delegate_bot")];
    expect(withoutSupervisorTools(tools)).not.toBe(tools);
  });
});

describe("toolsForSupervisorGate", () => {
  const app = () => ({ name: "GMAIL_SEND_EMAIL" });
  const host = () => [{ name: "host_run_command" }];

  test("grants a worker both sources", async () => {
    expect(
      await toolsForSupervisorGate({
        supervisor: false,
        granted: async () => [app()],
        alsoGranted: host,
      }),
    ).toEqual([app(), ...host()]);
  });

  test("grants a supervisor nothing at all", async () => {
    expect(
      await toolsForSupervisorGate({
        supervisor: true,
        granted: async () => [app()],
        alsoGranted: host,
      }),
    ).toEqual([]);
  });

  /*
   * The reason the sources are functions. Reading grants is not a pure read:
   * it writes an audit row, and on a deployment with a Composio workbench it
   * provisions the sandbox those tools would run in. A supervisor must leave no
   * trace of having looked, so the call has to be skippable — a list argument
   * would already have paid it.
   */
  test("never reads the grants of a supervisor", async () => {
    let read = 0;
    await toolsForSupervisorGate({
      supervisor: true,
      granted: async () => {
        read += 1;
        return [app()];
      },
      alsoGranted: () => {
        read += 1;
        return [host()];
      },
    });
    expect(read).toBe(0);
  });

  test("returns a fresh array, so a caller cannot write into a shared list", async () => {
    const granted = [app()];
    const first = await toolsForSupervisorGate({
      supervisor: false,
      granted: async () => granted,
      alsoGranted: () => [],
    });
    first.push(host());
    expect(granted).toEqual([app()]);
  });
});
