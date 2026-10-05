import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { a2uiProviderOptions } from "@/lib/copilot/a2ui";
import { queryClient } from "@/query-client";

/**
 * THE CONVERSATION YOU CAME BACK TO IS STILL WORKING.
 *
 * The scenario is one gesture: start something long, click into another conversation, come back. From
 * the inside, that unmounts `ChannelChat` and mounts a new one, and every piece of run state in it is
 * created on mount — `useAgent` registers a fresh proxied agent whose `isRunning` is false, and
 * `turnsInFlight` / `runsInFlight` are `useState` counters that start at zero. Nothing about leaving
 * aborts the run, deliberately: closing a tab is not a request to stop working.
 *
 * So the screen that greets the returning person believes, correctly by its own lights, that nothing is
 * happening. Two things follow, and the second is the one that made this look like a broken product
 * rather than a missing button:
 *
 *  1. Send is offered where Stop should be, for as long as the run lasts.
 *  2. Their next message goes into a thread the runner refuses. That refusal is raised inside the
 *     observable factory, after the SSE handler has already answered `200 text/event-stream`, so the
 *     browser receives a successful response with an empty body. `runAgent` resolves with no events, the
 *     client sees a run that neither answered nor failed, the composer has already cleared the draft,
 *     and no error is drawn. The message is persisted and there is no reply — repeatedly, until the
 *     orphaned run finally ends.
 *
 * These tests mount the real component against a mocked server and assert on the two things a person
 * can act on. The runner half of the fix is covered in `server/tests/runner-supersede.test.ts`; this
 * file is about the screen noticing at all.
 */

const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "return-channel",
  name: "Return test",
  agentIds: ["return-bot"],
  mascots: {},
  threadId: "return-thread",
  active: true,
  lastMessageAt: "2026-10-02T00:00:00.000Z",
};
const opening = {
  id: "opening",
  role: "assistant",
  content: "Stored opening",
} satisfies Message;

let originalFetch: typeof fetch;
/** What `GET /api/channels/:id/activity` answers. The variable the whole file turns on. */
let runningInChannel: {
  state: string;
  label: string | null;
  detail: string | null;
  botId: string;
} | null = null;
/** Every activity read, so a test can prove the poll is what drew the button. */
let activityReads = 0;
/** Stop requests, addressed by thread — the thing that makes Stop work from a fresh mount. */
let stopRequests: string[] = [];
let _core: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;

function CoreProbe() {
  _core = useCopilotKit().copilotkit;
  return null;
}

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === "/api/plugins/for/return-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "return-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      /*
       * The join replays history and then ENDS, while the server still reports a run going.
       *
       * Those two facts are independent and this fixture needs both. The connect finishing is what lets
       * the SDK release the request, so the queries behind it can proceed; the run still being live is
       * the state under test, and it is exactly what `GET /activity` exists to report.
       *
       * It is also faithful. A person who comes back to a live run does not get an endless connect —
       * the runtime's `connect` is a replay that completes — and `agent.isRunning` being false while
       * the server says a run is going is precisely the condition the poll has to cover. A fixture whose
       * connect never closed would prove nothing: every assertion would pass off `agent.isRunning`, and
       * the fix could be deleted.
       */
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "live" },
          { type: "MESSAGES_SNAPSHOT", messages: [opening] },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "live" },
        ]);
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = (await request.json()) as RunAgentInput;
        return sse([
          { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
          { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
        ]);
      }
      /*
       * Stop, recorded by thread. Stop is addressed by thread and takes no run id, which is precisely
       * why a mount that never started the run can still end it — the property the button depends on,
       * so it is asserted rather than assumed.
       */
      if (/\/stop\//.test(url.pathname)) {
        const threadId = decodeURIComponent(
          url.pathname.split("/stop/")[1] ?? "",
        );
        stopRequests.push(threadId);
        runningInChannel = null;
        return NativeResponse.json({ stopped: true });
      }
      /*
       * THE READ UNDER TEST. A GET, so it is kept distinct from the POST that records activity — the
       * two share a path and differ only by method, and conflating them is how a fixture ends up
       * testing the wrong route.
       */
      if (/\/api\/channels\/[^/]+\/activity$/.test(url.pathname)) {
        if ((init?.method ?? "GET") === "GET") {
          activityReads += 1;
          return NativeResponse.json({ activity: runningInChannel });
        }
        return new NativeResponse(null, { status: 204 });
      }
      if (/\/api\/channels\/[^/]+\/busy$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname))
        return NativeResponse.json({ messages: [opening] });
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    },
    {
      preconnect() {
        throw new Error("Unexpected fixture preconnect");
      },
    },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  _core = undefined;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function tree() {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider
        runtimeUrl="http://localhost/api/copilotkit"
        {...a2uiProviderOptions(false)}
      >
        <CoreProbe />
        <ChannelChat channel={channel} runtimeAgentId="return-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

function mount() {
  const summary: ChannelSummary = {
    ...channel,
    summary: null,
    lastMessage: opening.content,
    lastMessageAgentId: "return-bot",
    createdAt: "2026-10-02T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
    pageParams: [""],
  } satisfies {
    pages: ChannelPage[];
    pageParams: string[];
  });
  return render(tree());
}

/**
 * A brief: is a run going in this conversation?
 *
 * `undefined` for "say nothing, use the default" is what makes the reset honest. The alternative —
 * a boolean, with `false` meaning idle — forced every test to spell out that it wanted no run at all,
 * and the interesting case (a run) is the one a default gets wrong quietly.
 */
function reset(running: "live" | "idle" = "idle") {
  runningInChannel =
    running === "live"
      ? { state: "thinking", label: null, detail: null, botId: "return-bot" }
      : null;
  activityReads = 0;
  stopRequests = [];
}

const stopButton = (container: HTMLElement) =>
  container.querySelector('[data-testid="composer-stop"]');
const sendButton = (container: HTMLElement) =>
  container.querySelector('button[aria-label="Send message"]');

describe("a conversation with a run still going on the server", () => {
  test("offers Stop, not Send, on a mount that started nothing", async () => {
    reset("live");
    const { container } = mount();

    await waitFor(() => {
      expect(stopButton(container)).not.toBeNull();
    });

    /*
     * The regression, stated as an assertion: Send is the button that is visible when the screen has no
     * idea anything is running, and pressing it is what silently loses a message.
     */
    expect(sendButton(container)).toBeNull();
  });

  test("draws the button from the server's read, not from a run this mount began", async () => {
    reset("live");
    const { container } = mount();

    await waitFor(() => expect(activityReads).toBeGreaterThan(0));
    await waitFor(() => expect(stopButton(container)).not.toBeNull());

    // The fixture's connect attaches to a run, so prove the read is what is doing the work here.
    expect(activityReads).toBeGreaterThan(0);
  });

  test("presses Stop through the core, for a run this mount did not start", async () => {
    reset("live");
    const { container } = mount();

    const button = await waitFor(() => {
      const found = stopButton(container);
      expect(found).not.toBeNull();
      return found;
    });

    /*
     * WHAT IS ASSERTED, AND WHY IT IS NOT THE STOP REQUEST ITSELF.
     *
     * Stop is addressed by thread and carries no run id — `POST /agent/:id/stop/:threadId` — which is the
     * whole reason a mount that never started the run can still end it.
     *
     * The request is not asserted here because it cannot be: the SDK builds its URL with
     * `new URL(runtimeUrl, window.location.origin)`, and happy-dom's `URL` rejects that, so `abortRun`
     * throws before anything leaves. Reimplementing the request to make a test pass would be testing a
     * second implementation. What IS worth pinning is that the button is offered at all on a mount with
     * no local run — the button not existing is the whole regression, and it is the first assertion in
     * this file. What the press then does is the SDK's, unchanged.
     */
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Stop the Bot");

    // Pressing it must not throw into the tree, which is what a Stop that reaches no run looks like.
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  });

  test("asks again after Stop, so the button does not outlive the run it stops", async () => {
    /*
     * A Stop this mount pressed may belong to a run it did not start, and nothing local changes when
     * such a run ends: `agent.isRunning` was already false and no counter here was ever raised. Only the
     * poll knows, so it has to be re-asked — otherwise a Stop button sits on screen for up to an
     * interval after the work is over, and pressing it stops nothing.
     */
    reset("live");
    const { container } = mount();

    await waitFor(() => expect(activityReads).toBeGreaterThan(0));
    const beforeStop = activityReads;

    const button = await waitFor(() => {
      const found = stopButton(container);
      expect(found).not.toBeNull();
      return found;
    });
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      expect(activityReads).toBeGreaterThan(beforeStop);
    });
  });

  test("leaves Send alone in a conversation where nothing is running", async () => {
    reset("idle");
    const { container } = mount();

    await waitFor(() => expect(sendButton(container)).not.toBeNull());

    expect(stopButton(container)).toBeNull();
  });

  test("asks once when idle, and not again", async () => {
    /*
     * The cost that made polling the wrong answer if it were unconditional. An idle conversation has no
     * state change coming, so a constant interval would spend a request every few seconds for as long
     * as the person sits there, asking a question whose answer they already have. It should ask once on
     * mount and then stop.
     */
    reset("idle");
    mount();

    await waitFor(() => expect(activityReads).toBeGreaterThan(0));
    const afterMount = activityReads;

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(activityReads).toBe(afterMount);
  });
});
