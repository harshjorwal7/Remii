import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * WATCHING A BOT WORK, AND THEN NOT HAVING TO.
 *
 * The request these hold shut is that a turn's commands and reasoning are visible while the answer
 * is being produced, and stop being the thing on screen the moment the answer arrives. Before this,
 * every step a Bot took was a permanent row in the transcript: a shell command, a file read, a
 * search — each a full line, each in the same voice as the answer, so a conversation with twenty
 * turns in it carried sixty lines of process at the same weight as the thing the person came back
 * to read.
 *
 * Four things are asserted, and the third is the one that is easy to get wrong:
 *
 *  1. The work of a turn is ONE row, not one per step.
 *  2. It is open while the answer is still being produced, and says `Working`.
 *  3. It folds when the answer's first token arrives.
 *  4. A person who opened it themselves is not overridden by that fold.
 *
 * THE PROVIDER IS NOT DECORATION. A tool row calls the SDK's `useRenderToolCall`, which throws
 * outside a `CopilotKitProvider` — so these are the same real tool rows the channel draws, not a
 * stand-in for them, and the fallback line (`ServerToolLine`) is what answers a tool the browser has
 * no renderer for, which is the ordinary case now that tools execute on the server.
 *
 * THE HARNESS IS THIS REPOSITORY'S: `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`. bun walks every file into one process, and a document another file tore down mid-run
 * fails invisibly.
 */

const NativeResponse = globalThis.Response;
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  /*
   * The provider asks the runtime what this deployment supports before it will render anything, and
   * an unanswered request is a real socket to a server that is not running. Answering the one
   * endpoint it asks about is enough; everything else is refused, which is also what happens to a
   * tool call a Bot makes when no server tool holds the name.
   */
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      if (url.pathname.endsWith("/info")) {
        return NativeResponse.json({
          version: "fixture",
          agents: { fixture: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      }
      return NativeResponse.json({ error: "not found" }, { status: 404 });
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
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const QUESTION: Message = {
  id: "user-1",
  role: "user",
  content: "Group the open issues.",
};

/** One step: the Bot thought, then called something. */
function step(id: string, thought: string, callId: string): Message[] {
  return [
    { id: `${id}-reasoning`, role: "reasoning", content: thought },
    {
      id,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: callId,
          type: "function",
          // Named for what it reads as on screen: this projection draws the word, not the name.
          function: { name: "computer_run_command", arguments: "{}" },
        },
      ],
    },
  ];
}

const ANSWER: Message = {
  id: "answer-1",
  role: "assistant",
  content: "Here is how those issues group.",
};

/** The group rows this transcript drew. */
function groups(container: HTMLElement): HTMLDetailsElement[] {
  return Array.from(
    container.querySelectorAll("details.thought-process"),
  ) as HTMLDetailsElement[];
}

function headerText(group: HTMLDetailsElement | undefined): string {
  return group?.querySelector("summary")?.textContent ?? "";
}

function transcript(props: {
  busy?: boolean;
  messages: Message[];
}): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ChatTranscript {...props} />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

test("the steps of one turn are drawn as one open row that says it is working", async () => {
  const { container } = render(
    transcript({
      busy: true,
      messages: [
        QUESTION,
        ...step("a1", "reading the board", "call-1"),
        ...step("a2", "grouping them", "call-2"),
      ],
    }),
  );
  await settleReactWork();

  const drawn = groups(container);
  // Two steps, one row: this is the whole complaint about watching a Bot work. Counted by the
  // sentence each step draws rather than by a class, because a step whose result has not arrived is
  // deliberately not a disclosure — `ToolLine` draws a running call as one plain line.
  expect(drawn).toHaveLength(1);
  expect(container.textContent).toContain("Ran a command on the computer");
  expect(drawn[0]?.open).toBe(true);
  expect(headerText(drawn[0])).toContain("Working");
});

test("the model's own thinking is drawn with the steps, not dropped", async () => {
  const { container } = render(
    transcript({
      busy: true,
      messages: [QUESTION, ...step("a1", "reading the board", "call-1")],
    }),
  );
  await settleReactWork();

  expect(container.textContent).toContain("reading the board");
});

test("the row folds the moment the answer starts arriving", async () => {
  const working = [QUESTION, ...step("a1", "reading the board", "call-1")];
  const { container, rerender } = render(
    transcript({ busy: true, messages: working }),
  );
  await settleReactWork();
  expect(groups(container)[0]?.open).toBe(true);

  rerender(transcript({ busy: true, messages: [...working, ANSWER] }));
  await settleReactWork();

  const folded = groups(container)[0];
  expect(folded?.open).toBe(false);
  expect(headerText(folded)).toContain("Worked");
});

/*
 * A PERSON'S OWN TOGGLE WINS. Somebody who opens a group to read what a command actually printed
 * does not have it taken away by the answer arriving a second later. The next test is what keeps
 * this from being satisfied by a component that never folds at all.
 */
test("a group a person closed stays closed when the answer arrives", async () => {
  const working = [QUESTION, ...step("a1", "reading the board", "call-1")];
  const { container, rerender } = render(
    transcript({ busy: true, messages: working }),
  );
  await settleReactWork();

  await act(async () => {
    const group = groups(container)[0];
    if (group === undefined) throw new Error("expected a group row");
    group.open = false;
    group.dispatchEvent(new Event("toggle"));
  });

  rerender(transcript({ busy: true, messages: [...working, ANSWER] }));
  await settleReactWork();

  expect(groups(container)[0]?.open).toBe(false);
});

test("a group nobody touched folds on its own when the answer arrives", async () => {
  const working = [QUESTION, ...step("a1", "reading the board", "call-1")];
  const { container, rerender } = render(
    transcript({ busy: true, messages: working }),
  );
  await settleReactWork();

  rerender(transcript({ busy: true, messages: [...working, ANSWER] }));
  await settleReactWork();

  expect(groups(container)[0]?.open).toBe(false);
});

/*
 * A CONVERSATION THAT NEVER TOOK A STEP IS NOT GIVEN A DISCLOSURE. A disclosure with one line in it
 * is chrome around nothing, and a plain exchange has to reach the screen exactly as it always did.
 */
test("a turn with no steps of its own draws no group", async () => {
  const { container } = render(
    transcript({
      messages: [
        QUESTION,
        {
          id: "answer-1",
          role: "assistant",
          content: "They group into three themes.",
        },
      ],
    }),
  );
  await settleReactWork();

  expect(groups(container)).toHaveLength(0);
  expect(container.textContent).toContain("They group into three themes.");
});

/*
 * TWO TURNS ARE TWO GROUPS, and only the one being worked on is open. A finished group in a
 * conversation with a live run above it must not spring back open, which is why the header reads
 * both `answered` and `busy` rather than either alone.
 */
test("only the turn still being worked on is open", async () => {
  const { container } = render(
    transcript({
      busy: true,
      messages: [
        QUESTION,
        ...step("a1", "reading the board", "call-1"),
        { id: "answer-1", role: "assistant", content: "Three themes." },
        { id: "user-2", role: "user", content: "now do the second board" },
        ...step("a2", "opening the second board", "call-2"),
      ],
    }),
  );
  await settleReactWork();

  const drawn = groups(container);
  expect(drawn).toHaveLength(2);
  expect(drawn[0]?.open).toBe(false);
  expect(drawn[1]?.open).toBe(true);
});
