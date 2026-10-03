import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LLMock } from "@copilotkit/aimock";
import { toolsForSupervisorGate } from "../src/agents/supervision";
import {
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
} from "../src/copilot";
import type { GrantedTool } from "../src/plugins/tools";
import { loadTenantPackage } from "../src/tenant-package";
import { REMII_AGENT_ID } from "../../shared/remii";

/**
 * The three supervisor gates, asserted against the tool list a model is
 * actually handed rather than against the code that assembles it.
 *
 * A gate is only real if the model cannot see past it, and the model sees one
 * thing: the request body. So every test here runs a real turn against a
 * recording model and reads back the `tools` array that went out. Asserting on
 * the assembler's return value instead would pass even if a later step put the
 * tools back — which is exactly how a supervisor ends up a supervisor in the
 * code and a worker with a browser in the request.
 */

const packagePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../examples/fintech",
);

const stub = (name: string, description = `${name} tool`): GrantedTool => ({
  name,
  description,
  ref: `test/${name}`,
  effect: "read",
  parameters: { type: "object", properties: {} },
  execute: async () => `${name} ran`,
});

/** Everything a fully-equipped worker holds, so each gate has something to remove. */
const GRANTED = [
  stub("GMAIL_SEND_EMAIL", "Send an email"),
  stub("composio_workbench", "Reach the app catalogue"),
];
const HANDOFF = [
  stub("delegate_bot", "Hand work to a coworker"),
  stub("message_bot", "Message a coworker"),
  stub("ask_person", "Ask the person"),
  stub("gog_gmail_send", "Send mail through the local Google CLI"),
  stub("web_search", "Search the web"),
  stub("web_open", "Open a page"),
  stub("memory_save", "Remember something"),
  stub("handoff_brief", "Compile a brief before delegating"),
];
/** A browser the client offers to whichever Bot is in the conversation. */
const BROWSER_TOOL = {
  name: "computer_navigate",
  description: "Drive the computer",
  parameters: { type: "object", properties: {} },
};

async function requestSentToModel(options: {
  delegationOnly: boolean;
  frontendTools?: unknown[];
}): Promise<{ tools: string[]; systemPrompt: string }> {
  const tenantPackage = await loadTenantPackage(packagePath);
  const model = runtimeModelForEnvironment(tenantPackage.model, {});
  const recorder = new LLMock();
  const originalBase = process.env.OPENAI_BASE_URL;
  try {
    process.env.OPENAI_BASE_URL = await recorder.start();
    recorder.onMessage(/.*/, { type: "text", content: "Understood." });
    const agents = await resolveRuntimeAgents(
      () => [
        {
          id: REMII_AGENT_ID,
          name: "Remii",
          type: "built_in" as const,
          systemPrompt: "You are the chief of staff.",
          delegationOnly: options.delegationOnly,
        },
      ],
      model,
      async () => "synthetic-model-key",
      undefined,
      // The grants door, as the deployment assembles it: every app a connected
      // account offers, plus host access.
      async () =>
        toolsForSupervisorGate({
          supervisor: options.delegationOnly,
          granted: async () => GRANTED,
          alsoGranted: () => [stub("host_run_command")],
        }),
      undefined,
      // A deployment with a computer, so the prompt and the browser both have
      // something to offer and there is something for the gates to refuse.
      "YOU HAVE A COMPUTER. Use computer_navigate to browse.",
      undefined,
      undefined,
      // `agentFetch` — how a remote Bot is dialled. Absent; this one is local.
      undefined,
      // The handoff door, beside which the Google CLI and web tools arrive.
      // The per-run function itself, not a factory for one.
      async () => HANDOFF,
    );
    // Deliberately not cloned. `RunBuiltAgent` inherits `AbstractAgent.clone`,
    // which copies the base fields and so loses the per-run `build` that adds
    // the handoff tools — a clone of it silently runs the unnarrowed Bot.
    const agent = agents[REMII_AGENT_ID];
    if (!agent) throw new Error("Expected the Bot to be built.");
    agent.addMessage({
      id: "m1",
      role: "user",
      content: "Research this and email it to me.",
    });
    await agent.runAgent({
      tools: (options.frontendTools ?? [BROWSER_TOOL]) as never,
    });
    const body = recorder.getRequests()[0]?.body as
      | {
          tools?: Array<{ function?: { name?: string } }>;
          messages?: Array<{ role?: string; content?: unknown }>;
        }
      | undefined;
    return {
      tools: (body?.tools ?? [])
        .map((tool) => tool.function?.name)
        .filter((name): name is string => typeof name === "string"),
      systemPrompt: String(
        body?.messages?.find((message) => message.role === "system")?.content ??
          "",
      ),
    };
  } finally {
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBase;
    await recorder.stop();
  }
}

describe("a worker is untouched", () => {
  test("keeps its apps, its Google CLI, its web tools and its browser", async () => {
    const { tools: sent } = await requestSentToModel({ delegationOnly: false });

    for (const name of [
      "GMAIL_SEND_EMAIL",
      "host_run_command",
      "composio_workbench",
      "gog_gmail_send",
      "web_search",
      "web_open",
      "computer_navigate",
      "composio_search_tools",
      "multi_execute",
    ]) {
      expect(sent).toContain(name);
    }
  });
});

describe("a supervisor is given none of its own capabilities", () => {
  test("cannot send mail by either of the two doors", async () => {
    const { tools: sent } = await requestSentToModel({ delegationOnly: true });
    // The grant, and the CLI tool that is not grant-gated at all.
    expect(sent).not.toContain("GMAIL_SEND_EMAIL");
    expect(sent).not.toContain("gog_gmail_send");
  });

  test("cannot research, open a page, or run a command", async () => {
    const { tools: sent } = await requestSentToModel({ delegationOnly: true });
    for (const name of ["web_search", "web_open", "host_run_command"]) {
      expect(sent).not.toContain(name);
    }
  });

  test("is not offered a browser the client volunteered", async () => {
    const { tools: sent } = await requestSentToModel({ delegationOnly: true });
    expect(sent).not.toContain("computer_navigate");
  });

  test("is not offered a catalogue search over tools it does not hold", async () => {
    const { tools: sent } = await requestSentToModel({ delegationOnly: true });
    expect(sent).not.toContain("composio_search_tools");
    expect(sent).not.toContain("multi_execute");
  });

  test("keeps what supervising is made of", async () => {
    const { tools: sent } = await requestSentToModel({ delegationOnly: true });
    for (const name of [
      "delegate_bot",
      "message_bot",
      "ask_person",
      "handoff_brief",
      "memory_save",
    ]) {
      expect(sent).toContain(name);
    }
  });
});

describe("a supervisor's prompt does not advertise what it cannot use", () => {
  test("is told about the computer when it may drive one", async () => {
    const { systemPrompt } = await requestSentToModel({
      delegationOnly: false,
    });
    expect(systemPrompt).toContain("YOU HAVE A COMPUTER");
  });

  test("is not told about the computer when it may not", async () => {
    /*
     * The gate that costs nothing to skip and a run to waste: a prompt that
     * describes a browser the model is not offered produces tool calls for it,
     * every one of which comes back as unknown, until the step budget is gone.
     */
    const { systemPrompt } = await requestSentToModel({ delegationOnly: true });
    expect(systemPrompt).not.toContain("YOU HAVE A COMPUTER");
  });

  test("still carries its own role", async () => {
    const { systemPrompt } = await requestSentToModel({ delegationOnly: true });
    expect(systemPrompt).toContain("You are the chief of staff.");
  });
});
