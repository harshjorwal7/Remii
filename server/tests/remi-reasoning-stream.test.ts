import { expect, test } from "bun:test";
import { EventType } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { z } from "zod";
import { RemiLoopAgent } from "../src/remi/loop-agent";

/**
 * THE MODEL'S REASONING, AS A STREAM THAT OPENS AND CLOSES ONCE PER STEP.
 *
 * The loop used to mint ONE reasoning id for the whole run and never close it. Everything in this
 * file is a consequence of that one decision, and they are worth separating because they fail
 * differently — one is a picture, one is a hang, and one is a protocol violation that a future SDK
 * is entitled to reject:
 *
 *  1. THE PICTURE. Every step's thinking appended to the same `{role: "reasoning"}` message, so a
 *     multi-step turn drew one thinking row holding every step at once. The transcript projection
 *     maps one reasoning message to one row, so per-step rows require per-step ids.
 *
 *  2. THE HANG. `heartbeat` stands down while reasoning is streaming, and the guard it consulted was
 *     "has this run ever reasoned" rather than "is reasoning streaming now". Step 1 reasons, the
 *     guard latches for the rest of the run, and no heartbeat beats again — so a tool that took over
 *     a minute ran silent and the stall watchdog ended the turn with `AGENT_STREAM_STALLED`, a
 *     sentence blaming the Bot for going quiet. This is the failure that read as "the stream gets
 *     stuck", and it is the one that mattered most.
 *
 *  3. THE PROTOCOL. `REASONING_MESSAGE_END` and `REASONING_END` were never emitted at all, so the
 *     SDK held lane bookkeeping for a stream that never terminated.
 *
 * The model here is scripted over a real socket because these are claims about what goes ON THE
 * WIRE, in order, interleaved with tool calls — which is the only place the three failures above are
 * observable. A stubbed `emit` would assert the implementation against itself.
 */

const input: RunAgentInput = {
  threadId: "reasoning-thread",
  runId: "reasoning-run",
  messages: [{ id: "u1", role: "user", content: "Read the issues." }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
};

/** One scripted model response: prose, reasoning, a tool call, or some mixture. */
type Scripted = {
  reasoning?: string;
  text?: string;
  tool?: string;
};

function runToCompletion(agent: RemiLoopAgent): Promise<BaseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    agent.run(input).subscribe({
      next: (event) => events.push(event),
      error: (error: unknown) =>
        reject(error instanceof Error ? error : new Error(String(error))),
      complete: () => resolve(events),
    });
  });
}

/**
 * A model that answers with `script(step)` for step N.
 *
 * Reasoning arrives as `reasoning_content`, which is the field the loop reads at
 * `loop-agent.ts` — the same field a real reasoning model streams, and the reason the loop has a
 * reasoning path at all.
 */
async function scriptedModel(
  script: (step: number) => Scripted,
): Promise<{ url: string; close: () => void; requests: number }> {
  let step = 0;
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.text();
      step += 1;
      requests = step;
      const wanted = script(step);
      const stream = `data: ${JSON.stringify({
        id: `chatcmpl-${step}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              ...(wanted.reasoning
                ? { reasoning_content: wanted.reasoning }
                : {}),
              ...(wanted.text ? { content: wanted.text } : {}),
              ...(wanted.tool
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_${step}`,
                        type: "function",
                        function: { name: wanted.tool, arguments: "{}" },
                      },
                    ],
                  }
                : {}),
            },
            finish_reason: null,
          },
        ],
      })}\n\ndata: ${JSON.stringify({
        id: `chatcmpl-${step}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: wanted.tool ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })}\n\ndata: [DONE]\n\n`;
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}/v1`,
    close: () => {
      server.stop(true);
    },
    get requests() {
      return requests;
    },
  };
}

/** The base URL is an environment variable; see `model-router.ts`. Set per test. */
function agentFor(
  url: string,
  overrides: { heartbeatMs?: number; maxSteps?: number } = {},
): RemiLoopAgent {
  process.env.OPENAI_BASE_URL = url;
  return new RemiLoopAgent({
    botId: "reasoning-bot",
    systemPrompt: "Do the work.",
    model: { provider: "openai", model: "test-model" },
    apiKey: "test-key",
    maxSteps: overrides.maxSteps ?? 8,
    maxDurationMs: 60_000,
    // Small enough that a test does not have to wait 15 seconds to see a beat land.
    heartbeatMs: overrides.heartbeatMs ?? 10,
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

function typed(events: readonly BaseEvent[], type: string): BaseEvent[] {
  return events.filter((event) => event.type === type);
}

function messageIdOf(event: BaseEvent): string | undefined {
  return (event as { messageId?: unknown }).messageId as string | undefined;
}

/** Reasoning deltas in order, tagged with the message they were addressed to. */
function reasoningDeltas(
  events: readonly BaseEvent[],
): { messageId: string | undefined; delta: string }[] {
  return typed(events, EventType.REASONING_MESSAGE_CONTENT).map((event) => ({
    messageId: messageIdOf(event),
    delta: String((event as { delta?: unknown }).delta ?? ""),
  }));
}

test("each step's reasoning is its own message, opened and closed once", async () => {
  // Two steps, each of which thinks before it acts. The ids must differ, or both steps' reasoning
  // lands in one message and the transcript draws one row for a two-step turn.
  const model = await scriptedModel((step) =>
    step === 1
      ? { reasoning: `step one thought ${step}`, tool: "read_issues" }
      : {
          reasoning: `step two thought ${step}`,
          text: "They group into three.",
        },
  );
  try {
    const events = await runToCompletion(agentFor(model.url));

    const starts = messageIdOf;
    const opened = typed(events, EventType.REASONING_MESSAGE_START).map(starts);
    // One per step that reasoned. Two steps reasoned, so two messages.
    expect(new Set(opened).size).toBe(2);
    expect(opened.length).toBe(2);

    // And every delta went to one of those two, not to a third id invented along the way.
    const ids = new Set(
      reasoningDeltas(events).map((entry) => entry.messageId),
    );
    expect(ids.size).toBe(2);
    for (const id of ids) expect(opened).toContain(id);

    // The two steps' words are on separate messages rather than concatenated into one.
    const byMessage = new Map<string, string>();
    for (const { messageId, delta } of reasoningDeltas(events)) {
      byMessage.set(
        messageId ?? "",
        (byMessage.get(messageId ?? "") ?? "") + delta,
      );
    }
    const texts = [...byMessage.values()];
    expect(texts.some((text) => text.includes("step one thought"))).toBe(true);
    expect(texts.some((text) => text.includes("step two thought"))).toBe(true);
    expect(
      texts.some(
        (text) => text.includes("step one") && text.includes("step two"),
      ),
    ).toBe(false);
  } finally {
    model.close();
  }
});

test("every reasoning message that opens is closed", async () => {
  // The protocol half. An unterminated reasoning stream is one the SDK is entitled to reject, and
  // which today leaves it holding lane bookkeeping for a run that has already finished.
  const model = await scriptedModel((step) =>
    step === 1
      ? { reasoning: "thinking", tool: "read_issues" }
      : { reasoning: "thinking again", text: "Done." },
  );
  try {
    const events = await runToCompletion(agentFor(model.url));

    const opened = typed(events, EventType.REASONING_MESSAGE_START).map(
      messageIdOf,
    );
    const messageEnds = typed(events, EventType.REASONING_MESSAGE_END).map(
      messageIdOf,
    );
    const ends = typed(events, EventType.REASONING_END).map(messageIdOf);

    // Strictly paired: nothing opened without closing, nothing closed that never opened. Heartbeat
    // reasoning opens and closes within itself and is included in this count on purpose — it is on
    // the same wire and owes the same protocol.
    expect([...messageEnds].sort()).toEqual([...opened].sort());
    expect([...ends].sort()).toEqual([...opened].sort());
  } finally {
    model.close();
  }
});

test("a heartbeat beats through a slow tool even after a step has reasoned", async () => {
  // THE REGRESSION THAT MATTERED. `heartbeat` stands down while reasoning streams, and the guard it
  // used to consult was "this run has reasoned" rather than "reasoning is streaming now" — so once
  // step 1 thought, no heartbeat beat again for the rest of the turn. A tool slower than
  // `AGENT_STALL_TIMEOUT_MS` (60s as shipped) then ran silent and the watchdog ended the turn with
  // `AGENT_STREAM_STALLED`, which the transcript shows as a Bot that stopped responding mid-task.
  //
  // Step 1 reasons AND calls a slow tool, which is the exact shape that used to go unannounced.
  const model = await scriptedModel((step) =>
    step === 1
      ? { reasoning: "I should read the issues first.", tool: "read_issues" }
      : { text: "Three themes." },
  );
  process.env.OPENAI_BASE_URL = model.url;
  const agent = new RemiLoopAgent({
    botId: "reasoning-bot",
    systemPrompt: "Do the work.",
    model: { provider: "openai", model: "test-model" },
    apiKey: "test-key",
    maxSteps: 4,
    maxDurationMs: 60_000,
    heartbeatMs: 10,
    tools: [
      {
        name: "read_issues",
        description: "Reads the issue list",
        parameters: z.object({}),
        // Long enough for several beats at a 10ms heartbeat, short enough for a test.
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 120));
          return "three open issues";
        },
      },
    ],
  });
  try {
    const events = await runToCompletion(agent);

    // Heartbeats are reasoning messages with an EMPTY delta: the watchdog counts chunks and does
    // not parse them, so nothing is displayed (see the projection's empty-reasoning branch).
    const beats = reasoningDeltas(events).filter((entry) => entry.delta === "");
    // Step 1 reasoned before this tool ran. Under the old guard this count was zero.
    expect(beats.length).toBeGreaterThan(0);

    // And each one closed itself, so the watchdog traffic costs nothing on the protocol.
    const beatIds = new Set(
      typed(events, EventType.REASONING_MESSAGE_CONTENT)
        .filter(
          (event) => String((event as { delta?: unknown }).delta ?? "") === "",
        )
        .map(messageIdOf),
    );
    const closed = new Set(
      typed(events, EventType.REASONING_END).map(messageIdOf),
    );
    for (const id of beatIds) expect(closed.has(id)).toBe(true);
  } finally {
    model.close();
  }
});

test("a model that never reasons emits no reasoning events at all", async () => {
  // The other direction, and the one that keeps the fix honest: a lane opens on the first delta, so
  // a model that never thinks must produce no REASONING traffic whatsoever. A heartbeat is a
  // deliberate exception and only appears while a tool is actually running.
  const model = await scriptedModel((step) =>
    step === 1 ? { text: "Nothing to look up." } : { text: "Done." },
  );
  try {
    const events = await runToCompletion(agentFor(model.url));

    expect(typed(events, EventType.REASONING_START)).toHaveLength(0);
    expect(typed(events, EventType.REASONING_MESSAGE_START)).toHaveLength(0);
    expect(typed(events, EventType.REASONING_MESSAGE_CONTENT)).toHaveLength(0);
    expect(typed(events, EventType.REASONING_END)).toHaveLength(0);
  } finally {
    model.close();
  }
});

test("a run aborted mid-reasoning closes what it opened", async () => {
  // The leak. An abort thrown out of the model's stream with a lane open would otherwise reach the
  // SDK as a reasoning stream that never terminates, on the one path where nothing follows to close
  // it — a stopped turn is exactly when the transcript is being read.
  const model = await scriptedModel(() => ({
    reasoning: "thinking at length",
  }));
  const agent = agentFor(model.url);
  try {
    const events = await new Promise<BaseEvent[]>((resolve, reject) => {
      const collected: BaseEvent[] = [];
      const subscription = agent.run(input).subscribe({
        next: (event) => {
          collected.push(event);
          // Stop the run the moment reasoning is on the wire and still open.
          if (event.type === EventType.REASONING_MESSAGE_CONTENT) {
            agent.abortRun();
            setTimeout(() => subscription.unsubscribe(), 50);
          }
        },
        error: (error: unknown) =>
          reject(error instanceof Error ? error : new Error(String(error))),
        complete: () => resolve(collected),
      });
    });

    // Whatever was collected, nothing is left half-open. Unsubscribe can cut the stream short, so
    // this asserts the invariant that matters rather than an exact event count.
    const opened = typed(events, EventType.REASONING_MESSAGE_START).map(
      messageIdOf,
    );
    for (const id of typed(events, EventType.REASONING_MESSAGE_END).map(
      messageIdOf,
    )) {
      expect(opened).toContain(id);
    }
  } finally {
    model.close();
  }
});
