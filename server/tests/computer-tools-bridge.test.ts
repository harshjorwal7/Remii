import { describe, expect, test } from "bun:test";
import { computerToolsFor } from "../src/computer/tools";
import type { ActionActor, ComputerGateway } from "../src/computer/gateway";
import { ActionRefusedError } from "../src/computer/gateway";
import {
  ElementNotFoundError,
  HumanHasControlError,
  StaleSnapshotError,
} from "../src/computer/client";

/**
 * THE COMPUTER, AS A BOT CAN REACH IT.
 *
 * The gateway was fully built and fully governed the whole time: policy on every action, an audit row
 * for every one, a target guard, and a computer per (person, Bot). It was reachable from exactly one
 * place — signed-in HTTP, by the app's live screen. Not one line joined it to the tool list a run is
 * given.
 *
 * That produced a failure no test caught. `COMPUTER_TOOLS` was declared in `schema.ts` and referenced
 * by nothing; the eleven names existed only as policy keys and audit action strings; the prompt told
 * every Bot it had "real hands" and named two tools — `computer_request_help` and
 * `computer_request_secret` — that existed nowhere in the codebase. So a Bot asked for a coworker it
 * could not create and a capability it did not hold reported the absence confidently and invented an
 * administrator to explain it.
 *
 * These tests assert the two properties that make the bridge real: a worker is OFFERED the tools, and
 * a supervisor is not, because a supervisor that can browse is one that does the work itself instead
 * of arranging it.
 */

const ACTOR: ActionActor = { id: "person-1", userId: "person-1" };

/** A gateway that fails every call loudly, so an unexpected call is obvious rather than silent. */
const unusedGateway = () =>
  new Proxy({} as ComputerGateway, {
    get() {
      throw new Error("this test should not reach the computer");
    },
  });

const namesOf = (tools: { name: string }[]) =>
  tools.map((tool) => tool.name).sort();

describe("the computer bridge", () => {
  const tools = computerToolsFor({
    gateway: unusedGateway(),
    actor: ACTOR,
    botId: "general-assistant",
    allowShell: true,
  });

  test("offers a worker every way to drive its own browser and its own files", () => {
    expect(namesOf(tools)).toEqual([
      "computer_click",
      "computer_key",
      "computer_list_files",
      "computer_navigate",
      "computer_read",
      "computer_read_file",
      "computer_request_help",
      "computer_run_command",
      "computer_scroll",
      "computer_snapshot",
      "computer_type",
      "computer_write_file",
    ]);
  });

  test("can reach the web, which is the whole point for an app with no connector", () => {
    /*
     * The case that started all of this: WhatsApp is not connected, and no connector exists for it.
     * What exists is a browser. Without `computer_navigate` the deployment has no way to reach a
     * service it has not been given an API for, and the only correct answer left is to refuse.
     */
    expect(namesOf(tools)).toContain("computer_navigate");
    expect(namesOf(tools)).toContain("computer_snapshot");
  });

  test("can ask a person for help, and cannot ask for a secret it was not given", () => {
    expect(namesOf(tools)).toContain("computer_request_help");
    // `requestSecret` exists on the gateway and is deliberately not bridged: the masked input the
    // person would type into is a UI surface, and offering the tool without it would be the same
    // false promise this whole file exists to end.
    expect(namesOf(tools)).not.toContain("computer_request_secret");
  });

  test("offers a shell, inside this Bot's own workspace", () => {
    /*
     * Phase 4. Withheld through Phase 3 for a specific reason: on ONE computer a shell was a
     * cross-Bot escape, because the workspace was a single shared directory. That is no longer true —
     * the workspace is per Bot and the Bot id is signed — so the shell is a command in this Bot's own
     * sandbox rather than in the machine.
     *
     * It is still the largest thing in this list, and the test says so by naming the reason it is
     * safe rather than leaving "it is offered" to stand as the whole claim.
     */
    expect(namesOf(tools)).toContain("computer_run_command");
  });

  test("the shell takes a command, and is the only tool that runs one", () => {
    const shell = tools.find((t) => t.name === "computer_run_command");
    const parameters = shell?.parameters as unknown as { shape?: unknown };
    const shape = Object.keys(parameters?.shape as object);
    expect(shape).toContain("command");
    // Nothing else here executes anything; a tool that quietly grew a `command` would be the same
    // capability under a different name.
    for (const tool of tools) {
      if (tool.name === "computer_run_command") continue;
      const keys = Object.keys(
        (tool.parameters as unknown as { shape?: unknown }).shape as object,
      );
      expect(keys).not.toContain("command");
    }
  });

  test("every tool is named the way the prompt names it", () => {
    // The two spellings are not interchangeable and a drift here is the original bug in miniature.
    for (const tool of tools) {
      expect(tool.name.startsWith("computer_")).toBe(true);
      expect(tool.ref).toBe(`computer/${tool.name}`);
    }
  });
});

describe("what a refusal says back", () => {
  const run = async (name: string, error: unknown) => {
    const failing = {
      ...unusedGateway(),
    } as unknown as Record<string, unknown>;
    for (const method of [
      "navigate",
      "read",
      "snapshot",
      "click",
      "type",
      "key",
      "scroll",
      "readFile",
      "writeFile",
      "listFiles",
      "requestHelp",
    ]) {
      failing[method] = async () => {
        throw error;
      };
    }
    const tools = computerToolsFor({
      gateway: failing as unknown as ComputerGateway,
      actor: ACTOR,
      botId: "general-assistant",
      allowShell: true,
    });
    const tool = tools.find((t) => t.name === name)!;
    const args: Record<string, unknown> = {
      computer_navigate: { url: "https://example.test" },
      computer_click: { ref: "e1", snapshotId: 1 },
      computer_type: { ref: "e1", snapshotId: 1, text: "hi" },
      computer_key: { key: "Enter" },
      computer_scroll: {},
      computer_read_file: { path: "notes.md" },
      computer_write_file: { path: "notes.md", contents: "x" },
      computer_list_files: {},
      computer_request_help: { reason: "sign in" },
      computer_read: {},
      computer_snapshot: {},
    }[name];
    return tool.execute(args);
  };

  test("a person holding the browser is told to wait, not to retry", async () => {
    /*
     * The one that matters most, and the easiest to get backwards. A Bot's own `request_help` is
     * what put a person in the seat, so "a person has control" is the answer arriving. Telling the
     * model to retry sends it round the same refusal until the turn ends; telling it to wait is what
     * lets it continue when the browser is handed back.
     */
    const answer = await run(
      "computer_click",
      new HumanHasControlError("a person has control"),
    );
    expect(answer).toMatch(/wait/i);
    expect(answer).toMatch(/do not retry/i);
    expect(answer).not.toMatch(/stack|at Object|Error:/i);
  });

  test("a stale snapshot sends the Bot back for a fresh one", async () => {
    const answer = await run(
      "computer_click",
      new StaleSnapshotError("snapshot 3 is superseded by 4"),
    );
    expect(answer).toMatch(/computer_snapshot/i);
    expect(answer).toMatch(/refs/i);
  });

  test("a missing element says which call to make instead", async () => {
    const answer = await run(
      "computer_click",
      new ElementNotFoundError("no element e1"),
    );
    expect(answer).toMatch(/computer_snapshot/i);
  });

  test("a boundary refusal names the boundary rather than reading as a fault", async () => {
    /*
     * Distinguishable on purpose. A deployment boundary and a broken computer look identical to a
     * model given a stack trace, and the right response to each is different: one means stop and do
     * something else, the other means try again.
     */
    const answer = await run(
      "computer_navigate",
      new ActionRefusedError("example.test is not allowed"),
    );
    expect(answer).toMatch(/boundaries/i);
    expect(answer).toContain("example.test is not allowed");
  });

  test("an unexpected fault still says what failed", async () => {
    const answer = await run(
      "computer_navigate",
      new Error("computer is unavailable"),
    );
    expect(answer).toContain("computer is unavailable");
  });
});

describe("asking for help is visible in the roster", () => {
  const bridge = async (
    requestHelp: (reason: string) => Promise<{ requested: boolean }>,
  ) => {
    const asked: string[] = [];
    const failing = {} as Record<string, unknown>;
    failing.requestHelp = requestHelp;
    const tools = computerToolsFor({
      gateway: failing as unknown as ComputerGateway,
      actor: ACTOR,
      botId: "general-assistant",
      allowShell: true,
      onHelpRequested: ({ reason }) => {
        asked.push(reason);
      },
    });
    const tool = tools.find((t) => t.name === "computer_request_help")!;
    return { tool, asked };
  };

  test("a request that landed tells the roster", async () => {
    /*
     * The whole point of this addition. The request is stored on the computer and written to the
     * audit trail, and both of those are invisible to somebody who is not already looking at the
     * screen — so a Bot could sit on a QR code with the only sign of it a dot on an unopened channel.
     */
    const { tool, asked } = await bridge(async () => ({ requested: true }));
    const answer = await tool.execute({ reason: "scan this QR code" });
    expect(answer).toMatch(/^Asked\./);
    expect(asked).toEqual(["scan this QR code"]);
  });

  test("a Bot that already has control is not reported as needing one", async () => {
    // A false "needs you" in the roster is the failure this was added to prevent, in the other
    // direction: a Bot that is working must not look like it is blocked.
    const { tool, asked } = await bridge(async () => ({ requested: false }));
    const answer = await tool.execute({ reason: "anything" });
    expect(answer).toMatch(/already has control/i);
    expect(asked).toEqual([]);
  });

  test("a refused request is not reported as needing one", async () => {
    const { tool, asked } = await bridge(async () => {
      throw new ActionRefusedError(
        "this deployment will not hand over the browser",
      );
    });
    const answer = await tool.execute({ reason: "sign in" });
    expect(answer).toMatch(/boundaries/i);
    expect(asked).toEqual([]);
  });

  test("an empty reason still carries something the person can read", async () => {
    const { tool, asked } = await bridge(async () => ({ requested: true }));
    await tool.execute({});
    expect(asked[0]).toBeTruthy();
  });
});

describe("the shell is offered only where isolation has made it safe", () => {
  const build = (allowShell: boolean) =>
    computerToolsFor({
      gateway: unusedGateway(),
      actor: ACTOR,
      botId: "general-assistant",
      allowShell,
    });

  test("offered when the deployment's isolation answers for it", () => {
    expect(namesOf(build(true))).toContain("computer_run_command");
  });

  test("withheld where nothing answers the question", () => {
    /*
     * A shell is confined by its working directory, not by a jail — `bash` will `cd ..` and the
     * file tools' refusal of `..` does not reach a command line. So the only real control is WHO ELSE
     * IS ON THIS MACHINE, which the provider decides: one computer per Bot puts the container between
     * them, and a shared computer is only reachable at all on a deployment that has asserted a
     * single tenant. Neither answer holds here, so the tool is simply not built.
     *
     * Withheld rather than refused at call time, so a Bot is never offered something it may not run.
     */
    const names = namesOf(build(false));
    expect(names).not.toContain("computer_run_command");
    // And it is the shell alone: the rest of the computer is unaffected.
    expect(names).toContain("computer_navigate");
    expect(names).toContain("computer_snapshot");
  });
});
