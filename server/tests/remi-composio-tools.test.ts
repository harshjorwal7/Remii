import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  searchAndBatchToolsFor,
} from "../src/remi/composio-tools";
import { connectAppTool } from "../src/agents/connect-app";
import type { GrantedTool } from "../src/plugins/tools";
import { grantedTools } from "../src/plugins/tools";
import type { PluginStore } from "../src/plugins/store";

/**
 * Composio on demand, minus the network.
 *
 * Search ranks the run's own grant list and batch executes within it. What pins the
 * contract is the boundary: batch never runs itself or the ask-person exit, unknown names
 * answer as sentences rather than throws, and every offered name is one the callback
 * router knows.
 */

function granted(name: string, description: string): GrantedTool {
  return {
    name,
    description,
    parameters: z.object({}),
    ref: `test/${name}`,
    execute: async () => `result-of-${name}`,
  };
}

const tools = [
  granted("GMAIL_SEND", "Send an email via Gmail"),
  granted("SLACK_POST", "Post a message to Slack"),
  granted("memory_search", "Recall what is known"),
];

describe("composio_search_tools", () => {
  const search = searchAndBatchToolsFor(tools).find(
    (tool) => tool.name === "composio_search_tools",
  )!;

  test("ranks matching actions for a use case", async () => {
    const answer = await search.execute({ use_case: "send an email" });

    expect(answer).toContain("GMAIL_SEND");
    expect(answer).not.toContain("SLACK_POST");
  });

  test("says to connect when nothing matches", async () => {
    const answer = await search.execute({ use_case: "fax a platypus" });

    expect(answer).toContain("connect_app");
  });

  test("needs a use case", async () => {
    const answer = await search.execute({});

    expect(answer).toContain("Say what");
  });
});

describe("multi_execute", () => {
  const batch = searchAndBatchToolsFor(tools).find(
    (tool) => tool.name === "multi_execute",
  )!;

  test("runs several tools and collects every answer", async () => {
    const answer = await batch.execute({
      calls: [
        { tool: "GMAIL_SEND", args: {} },
        { tool: "memory_search", args: {} },
      ],
    });

    expect(answer).toContain("result-of-GMAIL_SEND");
    expect(answer).toContain("result-of-memory_search");
  });

  test("unknown names answer, never throw", async () => {
    const answer = await batch.execute({
      calls: [{ tool: "nope", args: {} }],
    });

    expect(answer).toContain("not available");
  });

  test("never runs itself or the ask-person exit", async () => {
    const answer = await batch.execute({
      calls: [
        { tool: "multi_execute", args: {} },
        { tool: "ask_person", args: {} },
      ],
    });

    expect(answer).not.toContain("result-of-");
  });
});

test("connect_app enables a missing app and returns the connect link", async () => {
  let added: Record<string, unknown> | null = null;
  const tool = connectAppTool({
    from: { botId: "bot", actorId: "user", runId: "run" },
    broker: {
      listApps: async () => [
        {
          slug: "gmail",
          name: "Gmail",
          connection: { kind: "consent", scheme: "OAUTH2" },
        },
      ],
      authorize: async () => ({ redirectUrl: "https://connect.example/gmail" }),
    } as never,
    pluginStore: {
      brokeredAppRow: async () => null,
      addBrokeredApp: async (input: Record<string, unknown>) => {
        added = input;
        return { id: "composio-gmail", authScheme: "OAUTH2" };
      },
    } as never,
    appUrl: "http://localhost:3001",
  });

  const answer = JSON.parse(await tool.execute({ app: "gmail" }));

  expect(added).not.toBeNull();
  expect(added!.slug).toBe("gmail");
  expect(answer.ok).toBe(true);
  expect(answer.connectUrl).toBe("https://connect.example/gmail");
});

describe("Composio workbench", () => {
  test("prepares one user sandbox and exposes only sandbox tools", async () => {
    let prepared = "";
    const calls: Array<{ toolSlug: string; args: Record<string, unknown> }> =
      [];
    const store = {
      workbench: {
        prepare: async (userId: string) => {
          prepared = userId;
        },
        execute: async (request: {
          toolSlug: string;
          args: Record<string, unknown>;
        }) => {
          calls.push({ toolSlug: request.toolSlug, args: request.args });
          return "sandbox-result";
        },
      },
      listForAgent: async () => ({ tools: [], skills: [] }),
    } as unknown as PluginStore;

    const offered = await grantedTools({
      store,
      botId: "bot",
      actorId: "user-1",
    });

    expect(prepared).toBe("user-1");
    expect(offered.map((tool) => tool.name)).toEqual([
      "composio_workbench",
      "composio_sandbox_bash",
    ]);
    expect(await offered[0]?.execute({ code: "print(1)" })).toBe(
      "sandbox-result",
    );
    expect(calls).toEqual([
      {
        toolSlug: "COMPOSIO_REMOTE_WORKBENCH",
        args: { code_to_execute: "print(1)" },
      },
    ]);
  });
});
