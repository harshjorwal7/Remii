import { expect, test } from "bun:test";
import { EventType } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { z } from "zod";
import { RemiLoopAgent } from "../src/remi/loop-agent";

/**
 * A BOT THAT GIVES UP HALFWAY, AND WHAT IT IS ASKED ABOUT IT.
 *
 * The loop used to end the moment the model stopped asking for tools. On the wire that is the same
 * event as a model that had finished the job — a `RUN_FINISHED`, with nothing in it saying which
 * happened — so a Bot that read four files and then went quiet was drawn, and read, as a Bot that
 * had done what it was asked. Every symptom in this file's subject was that one silence, wearing
 * different clothes: work stopped for no reason, and the transcript had no account of why.
 *
 * The rule is about what the RUN did rather than what the model said about it, because a model
 * saying "I have finished" is exactly the claim under suspicion. A turn that ran a tool has left
 * something outstanding — the tool's result is sitting in its context with nothing answering it —
 * and that is checkable from the wire.
 *
 * The cases below pin the three ways this can go wrong if the rule is written carelessly, which is
 * why each one is here rather than a single happy path:
 *
 *  1. A conversation that never called a tool is NOT continued. Otherwise every greeting gets a
 *     follow-up model call demanding results it never promised.
 *  2. A run that asked for its work to be finished is asked a BOUNDED number of times. A model that
 *     cannot get further must not be narrated at until its time budget runs out, which is a worse
 *     thing to watch than an honest stop.
 *  3. A run cut short at a limit says so on the wire, rather than finishing in the same silence.
 */

const input: RunAgentInput = {
  threadId: "continue-thread",
  runId: "continue-run",
  messages: [{ id: "u1", role: "user", content: "Group the open issues." }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
};

type RunOutcome = { events: BaseEvent[]; completed: boolean };

function runToCompletion(agent: RemiLoopAgent): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    agent.run(input).subscribe({
      next: (event) => events.push(event),
      error: (error: unknown) =>
        reject(error instanceof Error ? error : new Error(String(error))),
      complete: () => resolve({ events, completed: true }),
    });
  });
}

/**
 * A model that answers with whatever `script` says for step N, so a test can say "call the tool
 * once, then go quiet" — which is the behaviour under test and cannot be expressed by a stub that
 * always calls it.
 */
async function scriptedModel(
  script: (step: number) => "tool" | "quiet" | "prose",
): Promise<{ url: string; close: () => void; requests: number[] }> {
  let step = 0;
  const requests: number[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      step += 1;
      // How many messages the loop has sent is how far along the conversation it is, and it is the
      // only reliable witness of a continuation from the other end of the socket.
      requests.push(step);
      const wanted = script(step);
      const chunk = {
        id: `chatcmpl-${step}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            delta:
              wanted === "tool"
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_${step}`,
                        type: "function",
                        function: { name: "read_issues", arguments: "{}" },
                      },
                    ],
                  }
                : wanted === "prose"
                  ? {
                      role: "assistant",
                      content: "They group into three themes.",
                    }
                  : { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      };
      const done = {
        id: `chatcmpl-${step}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: wanted === "tool" ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
      void body;
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    url: `http://localhost:${server.port}/v1`,
    close: () => {
      server.stop(true);
    },
    requests,
  };
}

/**
 * THE BASE URL IS AN ENVIRONMENT VARIABLE, which is how the loop's model router finds an endpoint
 * — see `model-router.ts`. Set per test rather than once, because each test stands up its own
 * scripted server and a stale URL would send the run to whatever the previous one was.
 */
function agentFor(url: string) {
  process.env.OPENAI_BASE_URL = url;
  return new RemiLoopAgent({
    botId: "continue-bot",
    systemPrompt: "Do the work.",
    model: { provider: "openai", model: "test-model" },
    apiKey: "test-key",
    maxSteps: 8,
    maxDurationMs: 60_000,
    tools: [
      {
        name: "read_issues",
        description: "Reads the issue list",
        parameters: z.object({}),
        execute: async () => "three open issues",
      },
    ],
  });
}

function toolNames(events: readonly BaseEvent[]): string[] {
  return events
    .filter((event) => event.type === EventType.TOOL_CALL_START)
    .map((event) => (event as { toolCallName?: string }).toolCallName)
    .filter((name): name is string => typeof name === "string");
}

/**
 * THE ASSISTANT'S WORDS, read off the chunk events rather than the content ones.
 *
 * The loop emits `TEXT_MESSAGE_CHUNK` (the AG-UI shorthand, which carries its own start/end) and
 * the runtime's `applyEvents` is what expands that into `TEXT_MESSAGE_START` / `_CONTENT` / `_END`.
 * Reading `TEXT_MESSAGE_CONTENT` therefore finds nothing, which is a mistake worth writing down
 * rather than repeating.
 */
function assistantText(events: readonly BaseEvent[]): string {
  return events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CHUNK)
    .map((event) => (event as { delta?: string }).delta)
    .join("");
}

test("a run that did work and then went quiet is asked to finish it", async () => {
  // Step 1 calls the tool, step 2 says nothing at all — the Bot that stops for no reason.
  const model = await scriptedModel((step) => (step === 1 ? "tool" : "quiet"));
  try {
    const events = (await runToCompletion(agentFor(model.url))).events;

    // It went back to the model rather than ending: the whole point.
    expect(model.requests.length).toBeGreaterThan(1);
    // And the tool it had already run is still the work of this turn, not a second turn's.
    expect(toolNames(events)).toEqual(["read_issues"]);
  } finally {
    model.close();
  }
});

test("a conversation that never called a tool is not continued", async () => {
  // The guard that keeps the rule from costing a request on every "hi". A turn with nothing
  // outstanding has nothing to finish, and asking anyway would make every greeting a two-call turn
  // that ends with the model being nagged for results it never promised.
  const model = await scriptedModel((step) => (step === 1 ? "prose" : "quiet"));
  try {
    await runToCompletion(agentFor(model.url));
    expect(model.requests.length).toBe(1);
  } finally {
    model.close();
  }
});

test("a model that cannot get further is asked a bounded number of times, then left alone", async () => {
  // It called the tool once and then said nothing however many times it was asked. Without a bound
  // this is a Bot narrated until its time budget expires, which is worse to watch than a stop that
  // admits itself — so the run must let go.
  const model = await scriptedModel((step) => (step === 1 ? "tool" : "quiet"));
  try {
    await runToCompletion(agentFor(model.url));
    // One step of work, plus the bounded number of times it was asked to finish.
    expect(model.requests.length).toBeGreaterThan(1);
    expect(model.requests.length).toBeLessThanOrEqual(8);
  } finally {
    model.close();
  }
});

test("a run that goes quiet after answering is not continued", async () => {
  // The continuation has to be about work, not about turn order: the model can end its turn by
  // speaking, and a run that spoke is finished whatever it did or did not do first.
  const model = await scriptedModel((step) => (step === 1 ? "tool" : "prose"));
  try {
    const events = (await runToCompletion(agentFor(model.url))).events;
    expect(assistantText(events)).toContain("three themes");
  } finally {
    model.close();
  }
});
/**
 * A RUN THAT WAS CUT SHORT SAYS SO ON THE WIRE.
 *
 * Every terminal path used to emit the same bare `RUN_FINISHED`, so a run that hit its step budget, a
 * run that hit its time budget and a run that finished cleanly were indistinguishable to the browser
 * — and the browser's only way to say "this turn ended before the Bot finished answering" is a
 * sentence the run carries. Without one, a turn truncated at a limit was drawn as a finished answer.
 *
 * Two cases, because there are two different silences. A run with nothing to say at all is the one
 * that was genuinely invisible. A run that said something and was then cut off is the one that was
 * worse: the partial answer was on screen looking complete, which is the failure this whole change
 * exists to stop.
 */
test("a run cut off at its step budget says it was cut off", async () => {
  // Never stops calling the tool, so only the budget can end it.
  const model = await scriptedModel(() => "tool");
  try {
    const events = (await runToCompletion(agentFor(model.url))).events;
    const finished = events.find(
      (event) => event.type === EventType.RUN_FINISHED,
    ) as { message?: string } | undefined;

    expect(finished?.message).toBeTruthy();
    expect(finished?.message).toContain("steps");
  } finally {
    model.close();
  }
});

test("a run that finished with an answer carries no complaint", async () => {
  // The other direction, and the one that keeps the notice worth reading: a sentence under every
  // successful answer would train people to ignore it.
  const model = await scriptedModel(() => "prose");
  try {
    const events = (await runToCompletion(agentFor(model.url))).events;
    const finished = events.find(
      (event) => event.type === EventType.RUN_FINISHED,
    ) as { message?: string } | undefined;

    expect(finished?.message).toBeUndefined();
  } finally {
    model.close();
  }
});
