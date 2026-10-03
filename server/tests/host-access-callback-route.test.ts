import { describe, expect, test } from "bun:test";
import { mintRunAssertion } from "../src/agents/callback-token";
import { loadConfig } from "../src/config";
import { createHostAccessBroker } from "../src/host-access/broker";
import { hostAccessTools } from "../src/host-access/tools";
import { createTestApp } from "./support/app";
import { testEnvironment } from "./support/environment";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function appWithHostDispatcher(
  broker: ReturnType<typeof createHostAccessBroker>,
) {
  return createTestApp({
    config: loadConfig(
      testEnvironment({
        AGENT_TOOL_TOKEN: "legacy-agent-tool-token",
        KEY_ENCRYPTION_KEY: KEY,
      }),
    ),
    parts: {
      hostAccessBroker: broker,
      desktopHostToken: "desktop-token",
      /*
       * The dispatcher these routes call into, wired to the same broker.
       *
       * WAS a hand-written list of twenty-five `undefined`s and then `broker`, `"desktop-token"` and
       * the dispatcher. The three landed on `deploymentToolCaller`, `composio` and `cronTick` — the
       * broker sits at position 25 and the list put it at 26 — so the callback route had no broker,
       * queued nothing, and the poll loop below spun out with `lease` still null. Every position is
       * optional, so nothing here was a type error.
       *
       * Named now, and `app-helper.test.ts` is what notices if the signature moves again.
       */
      deploymentToolCaller: async ({
        name,
        args,
        botId,
        actorId,
        initiator,
      }: {
        name: string;
        args: unknown;
        botId: string;
        actorId: string;
        initiator: unknown;
      }) => {
        if (!name.startsWith("host_")) return null;
        const tool = hostAccessTools({
          broker,
          botId,
          actorId,
          initiator,
        }).find((candidate) => candidate.name === name);
        if (!tool) return { text: "not available", isError: true };
        const text = await tool.execute(args);
        return { text, isError: false };
      },
    },
  });
}

describe("host access tools on the signed agent callback route", () => {
  test("dispatches host_read_file through the broker as the signed Bot and actor", async () => {
    const broker = createHostAccessBroker();
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });
    broker.nextDesktopOperation();
    const app = appWithHostDispatcher(broker);

    const responsePromise = app.request("/api/agent-tools/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-remii-agent-token": "legacy-agent-tool-token",
      },
      body: JSON.stringify({
        name: "host_read_file",
        args: { grantId: "grant-1", path: "notes.txt" },
        // These must be ignored. The signed run below is the only identity source.
        botId: "bot-b",
        actorId: "user-b",
        run: mintRunAssertion(
          { botId: "bot-a", actorId: "user-a", runId: "run-a" },
          KEY,
        ),
      }),
    });
    let lease = null as ReturnType<typeof broker.nextDesktopOperation>;
    for (let attempt = 0; attempt < 20; attempt++) {
      lease = broker.nextDesktopOperation();
      if (lease?.operations[0]) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(lease?.operations[0]).toMatchObject({
      kind: "read_file",
      botId: "bot-a",
      actorId: "user-a",
      grantId: "grant-1",
      relativePath: "notes.txt",
    });
    broker.resolveDesktopOperation({
      operationId: lease!.operations[0]!.operationId,
      ok: true,
      result: { content: "hello" },
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: JSON.stringify({ content: "hello" }),
      isError: false,
    });
  });
});
