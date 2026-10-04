import { describe, expect, test } from "bun:test";
import type {
  DesktopComputerUse,
  DesktopMachine,
} from "../src/computer/desktop-stream";
import type { DesktopActionRecord } from "../src/computer/desktop-tools";
import { desktopToolsFor } from "../src/computer/desktop-tools";

/**
 * Every action on the computer leaves a row.
 *
 * The audit vocabulary for this — `computer.action_allowed`, `_refused`, `_failed` — was written for the
 * browser gateway, and that gateway is switched off in this deployment. The E2B desktop is the only
 * computer a model can reach, and it recorded nothing at all: every click, keystroke and shell command
 * the agent performed vanished the moment the turn ended.
 *
 * That is what these lock down. The record is the only thing that makes a misclick investigable, and
 * the shape that matters is the three-way outcome — a refusal and a failure read identically to a
 * caller but mean opposite things on a trail.
 */

const stubUse = (over: Partial<DesktopComputerUse> = {}): DesktopComputerUse =>
  ({
    screenshot: {
      takeCompressed: async () => ({}),
      takeCompressedRegion: async () => ({}),
      takeFullScreen: async () => ({}),
    },
    mouse: {
      move: async () => {},
      click: async () => {},
      drag: async () => {},
      scroll: async () => {},
    },
    keyboard: {
      type: async () => {},
      press: async () => {},
      hotkey: async () => {},
    },
    display: {
      getInfo: async () => ({ displays: [] }),
      getWindows: async () => ({ windows: [] }),
    },
    accessibility: { getTree: async () => ({ root: null }) },
    ...over,
  }) as unknown as DesktopComputerUse;

const stubMachine = (over: Partial<DesktopMachine> = {}): DesktopMachine =>
  ({
    exec: async () => ({ exitCode: 0, stdout: "" }),
    readFile: async () => "",
    writeFile: async () => {},
    listFiles: async () => [],
    ...over,
  }) as unknown as DesktopMachine;

const harness = (
  over: {
    onAction?: (r: DesktopActionRecord) => void;
    controlHolder?: () => Promise<"bot" | "human" | null>;
    machine?: DesktopMachine;
  } = {},
) => {
  const records: DesktopActionRecord[] = [];
  const tools = desktopToolsFor({
    // The queue is keyed by person, so these are not optional decoration — they are what an acting call
    // is serialised against.
    actor: { id: "person-1" },
    botId: "bot-1",
    resolve: async () => ({
      computerUse: stubUse(),
      machine: over.machine ?? stubMachine(),
      displayWidth: 1920,
      displayHeight: 1080,
    }),
    // Always wired, because a test that asserts a row was recorded and a tool that was never asked to
    // record one is a test that passes for the wrong reason.
    onAction: (record) => {
      records.push(record);
      // Returned, not just called: the point of these tests is that a reporter which rejects is
      // swallowed by `report`, and that can only be observed if the harness hands the rejection on
      // rather than dropping it on the floor as an unhandled one.
      return over.onAction?.(record);
    },
    ...(over.controlHolder ? { controlHolder: over.controlHolder } : {}),
  });
  return {
    records,
    tools,
    find: (name: string) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`no tool named ${name}`);
      return tool;
    },
  };
};

/**
 * Let queued and fire-and-forget work land.
 *
 * Acting tool calls now go through a per-computer queue, so a click resolves a couple of microtasks
 * later than it used to rather than immediately. Waiting on a fixed microtask count would make these
 * tests a race; this is long enough for a queue hop and still fast.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("what the computer records about itself", () => {
  test("an action that worked is recorded as allowed", async () => {
    const { records, find } = harness();
    await find("computer_click").execute({ x: 10, y: 10 });
    await settle();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tool: "computer_click",
      effect: "write",
      outcome: "allowed",
    });
  });

  test("a refusal is not recorded as a failure", async () => {
    /*
     * A person holding the wheel is the ordinary case, not an outage. Folding refusals in with
     * failures would report a broken computer every time somebody took over, which is the fastest way
     * to make a trail nobody reads.
     */
    const { records, find } = harness({
      controlHolder: async () => "human",
    });
    await find("computer_click")
      .execute({ x: 10, y: 10 })
      .catch(() => undefined);
    await settle();

    expect(records).toHaveLength(1);
    expect(records[0]!.outcome).toBe("refused");
  });

  test("a throw that is not a refusal is recorded as a failure", async () => {
    const { records, find } = harness({
      machine: stubMachine({
        exec: async () => {
          throw new Error("the sandbox connection reset");
        },
      }),
    });
    await find("computer_shell")
      .execute({ command: "ls" })
      .catch(() => undefined);
    await settle();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tool: "computer_shell",
      outcome: "failed",
    });
    expect(records[0]!.detail).toContain("connection reset");
  });

  test("reading the screen is recorded too", async () => {
    const { records, find } = harness();
    await find("computer_screen").execute({});
    await settle();

    expect(records).toHaveLength(1);
    // "What did it look at" is the context for every action that followed it.
    expect(records[0]!.effect).toBe("read");
  });

  test("the record never carries what was typed", async () => {
    const { records, find } = harness();
    await find("computer_type").execute({ text: "hunter2-correct-horse" });
    await settle();

    const row = records[0]!;
    expect(row.tool).toBe("computer_type");
    expect(JSON.stringify(row)).not.toContain("hunter2");
  });

  test("a failing reporter never fails the action", async () => {
    /*
     * The trail is worth having and is not worth a turn. If an audit insert could fail the click, the
     * record would become the reason the computer is slow — and the one time it matters, a full disk
     * would take the computer down rather than leave a gap in the log.
     */
    const { find } = harness({
      onAction: () => {
        throw new Error("audit table is full");
      },
    });

    await expect(
      find("computer_click").execute({ x: 10, y: 10 }),
    ).resolves.toBeDefined();
  });

  test("a reporter that rejects is swallowed", async () => {
    const { find } = harness({
      onAction: async () => {
        throw new Error("audit insert failed");
      },
    });

    await expect(
      find("computer_click").execute({ x: 10, y: 10 }),
    ).resolves.toBeDefined();
  });

  test("every desktop tool is covered, by construction", async () => {
    /*
     * Eleven tools exist today and more will be added. Instrumenting each body is how one of them ends
     * up unrecorded and nobody notices, so the wrapper is what makes the record complete — this asserts
     * the property that matters: reporting lives in the definition of a tool, not in its body.
     */
    const { tools, records } = harness();
    for (const tool of tools) {
      await tool.execute({}).catch(() => undefined);
    }
    await settle();

    expect(records).toHaveLength(tools.length);
    expect(new Set(records.map((r) => r.tool)).size).toBe(tools.length);
  });
});
