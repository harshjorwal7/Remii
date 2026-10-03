import { expect, test } from "bun:test";
import { EventType } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { z } from "zod";
import { abortReason, RemiLoopAgent } from "../src/remi/loop-agent";

/**
 * Why an agent stopped partway through a task.
 *
 * Three separate defects all ended a run halfway and all of them were invisible, so none of them
 * showed up as a failure anywhere. They are pinned here together because they share one symptom:
 *
 *  1. The step/time loop read `||` instead of `&&`, so neither budget ever stopped anything and a
 *     turn ran until something outside the loop killed it.
 *  2. A running tool emits nothing while it runs, and this repository ships a stall watchdog that
 *     ends any run silent for 60s. A tool taking 1–2 minutes was therefore cancelled mid-task.
 *  3. Every abort emitted a bare `RUN_FINISHED`, which the browser reads as success.
 *
 * Each is driven through the real agent against a local model stub, because all three are about the
 * shape and timing of a live run and none of them can be observed from a pure function.
 */

const input: RunAgentInput = {
  threadId: "budget-thread",
  runId: "budget-run",
  messages: [{ id: "u1", role: "user", content: "Do the work." }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
};

type RunOutcome = { events: BaseEvent[]; completed: boolean; error?: string };

/** Drive a run to a settled observable and keep everything it said. */
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
 * A model stub that always asks for the same tool, so the loop never reaches its natural end.
 *
 * A turn like this is the one every budget exists for: the model keeps asking, so nothing but a cap
 * will stop it. `maxSteps: 2` keeps the test to two requests against a real HTTP round trip.
 */
function loopingAgent(
  overrides: {
    maxSteps?: number;
    maxDurationMs?: number;
    toolTimeoutMs?: number;
    heartbeatMs?: number;
    tool?: () => Promise<string>;
  } = {},
) {
  const calls: string[] = [];
  return new RemiLoopAgent({
    botId: "budget-bot",
    systemPrompt: "Always call the tool.",
    model: { provider: "openai", model: "test-model" },
    apiKey: "test-key",
    maxSteps: overrides.maxSteps ?? 2,
    maxDurationMs: overrides.maxDurationMs ?? 60_000,
    ...(overrides.toolTimeoutMs === undefined
      ? {}
      : { toolTimeoutMs: overrides.toolTimeoutMs }),
    ...(overrides.heartbeatMs === undefined
      ? {}
      : { heartbeatMs: overrides.heartbeatMs }),
    tools: [
      {
        name: "loop_forever",
        description: "A tool that keeps the turn going",
        parameters: z.object({}),
        execute: async () => {
          calls.push("called");
          return overrides.tool ? await overrides.tool() : "again";
        },
      },
    ],
  });
}

/**
 * A local OpenAI-shaped server, because the loop reaches a real endpoint and the budgets are about
 * how long that takes.
 *
 * `stream: true` is always requested, so this answers SSE and not JSON — the loop's `streamStep`
 * reads `delta` chunks off the wire, and a non-streaming reply is silently read as a model that
 * asked for nothing. Which is itself worth knowing: that shape produces an empty step, the loop
 * breaks on "no tool calls", and the run ends at once having done nothing.
 */
async function modelServer(): Promise<{ url: string; close: () => void }> {
  let step = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.text();
      step += 1;
      const chunk = {
        id: `chatcmpl-${step}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${step}`,
                  type: "function",
                  function: { name: "loop_forever", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      const done = {
        id: `chatcmpl-${step}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
      const body = `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`;
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}/v1`,
    close: () => {
      server.stop(true);
    },
  };
}

test("the step budget stops the loop at the cap instead of running to the time limit", async () => {
  /*
   * THE BUG. The loop read `step < maxSteps || elapsed < maxDurationMs`, so it stopped only once
   * BOTH were exhausted — at least `maxSteps` steps AND the full duration. With a one-minute time
   * budget and a step cap of 2, the run below would have taken a minute instead of two requests.
   */
  const server = await modelServer();
  const previous = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = server.url;
  try {
    const agent = loopingAgent({ maxSteps: 2, maxDurationMs: 60_000 });
    const startedAt = Date.now();
    const result = await runToCompletion(agent);
    const elapsed = Date.now() - startedAt;

    // Two steps of tool calls, then the closing summary pass.
    const toolCalls = result.events.filter(
      (event) =>
        (event as { type?: string }).type === EventType.TOOL_CALL_RESULT,
    );
    expect(toolCalls.length).toBe(2);

    // The proof that `||` is gone: the run finishes in well under the minute it was budgeted.
    // With the old condition this waited out the whole `maxDurationMs` before stopping.
    expect(elapsed).toBeLessThan(20_000);
    expect(result.completed).toBe(true);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previous;
  }
});

test("a tool that outlasts a stall watchdog still finishes the turn", async () => {
  /*
   * THE BUG. `AGENT_STALL_TIMEOUT_MS` ships at 60_000 and the tool timeout is 120_000, so a tool
   * taking 90s was killed by the watchdog mid-task — the result was computed, pushed into the
   * conversation, and then thrown away because the caller had already cancelled the run.
   *
   * Stand-in for the watchdog here: silence of over a second ends the turn, which is the same rule
   * at a scale a test can run. Before the heartbeat this failed — the turn was cancelled at 1s with
   * the tool still executing. It has to pass with a tool that outlives the window.
   */
  const SILENCE_LIMIT_MS = 1_000;
  const HEARTBEAT_MS = 200;
  let lastChunkAt = Date.now();
  let cancelled = false;
  const timer = setInterval(() => {
    if (Date.now() - lastChunkAt >= SILENCE_LIMIT_MS) cancelled = true;
  }, 25);

  const server = await modelServer();
  const previous = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = server.url;
  try {
    const agent = loopingAgent({
      maxSteps: 1,
      toolTimeoutMs: 5_000,
      // The same ratio the shipped default keeps against a 60s watchdog, brought down to a scale a
      // test can run in: five heartbeats inside the window the watchdog would have ended the turn.
      heartbeatMs: HEARTBEAT_MS,
      tool: () =>
        new Promise((resolve) => setTimeout(() => resolve("slow"), 2_500)),
    });

    const outcome = await new Promise<RunOutcome>((resolve, reject) => {
      const events: BaseEvent[] = [];
      agent.run(input).subscribe({
        // The watchdog's clock is driven by chunks, which is exactly what the heartbeat beats on.
        next: (event) => {
          lastChunkAt = Date.now();
          events.push(event);
        },
        error: (error: unknown) =>
          reject(error instanceof Error ? error : new Error(String(error))),
        complete: () => resolve({ events, completed: true }),
      });
    });

    expect(cancelled).toBe(false);
    expect(outcome.completed).toBe(true);

    // The tool's result reached the conversation, so the work was not thrown away.
    const results = outcome.events.filter(
      (event) =>
        (event as { type?: string }).type === EventType.TOOL_CALL_RESULT,
    );
    expect(results.length).toBe(1);
    expect(JSON.stringify(results[0])).toContain("slow");
  } finally {
    clearInterval(timer);
    server.close();
    if (previous === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previous;
  }
});

test("an aborted run reports why, instead of finishing as though it succeeded", async () => {
  /*
   * THE BUG. Every abort used to emit `RUN_FINISHED` with no reason, which is what the browser
   * reads as a finished turn: the transcript closes, the composer unlocks, and nothing says the
   * work was cut off. A `RUN_ERROR` is what every stop-already-handed-UI listens to.
   */
  const server = await modelServer();
  const previous = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = server.url;
  try {
    const toolStarted = Promise.withResolvers<void>();
    const agent = loopingAgent({
      maxSteps: 1,
      toolTimeoutMs: 30_000,
      tool: () =>
        new Promise((resolve) => {
          // Stopped only once the tool is genuinely running, so the abort lands mid-task rather
          // than before the run has a controller to abort.
          toolStarted.resolve();
          setTimeout(() => resolve("late"), 30_000);
        }),
    });

    const outcome = new Promise<RunOutcome>((resolve, reject) => {
      const events: BaseEvent[] = [];
      agent.run(input).subscribe({
        next: (event) => {
          events.push(event);
          // The moment the tool is running, the work is genuinely under way.
          if ((event as { type?: string }).type === EventType.TOOL_CALL_END) {
            void toolStarted.promise.then(() => {
              agent.abortRunWithReason(
                "This turn was stopped before the Bot finished answering.",
              );
            });
          }
        },
        error: (error: unknown) =>
          reject(error instanceof Error ? error : new Error(String(error))),
        complete: () => resolve({ events, completed: true }),
      });
    });

    const result = await outcome;

    // Not a bare finish: the run carries a sentence about being stopped.
    const errors = result.events.filter(
      (event) => (event as { type?: string }).type === EventType.RUN_ERROR,
    );
    expect(errors.length).toBe(1);
    expect((errors[0] as { message?: string }).message).toContain("stopped");
    expect(
      result.events.filter(
        (event) => (event as { type?: string }).type === EventType.RUN_FINISHED,
      ),
    ).toHaveLength(0);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previous;
  }
});

test("abortReason says what stopped the run, and never invents a cause", () => {
  const named = new AbortController();
  named.abort(new Error("The loop breaker stopped this turn."));
  expect(abortReason(named.signal)).toBe("The loop breaker stopped this turn.");

  const plain = new AbortController();
  plain.abort();
  // An anonymous abort is the one case with genuinely nothing of ours to report. The platform's
  // own DOMException text is used rather than ours, because it is the honest description and
  // inventing a more specific cause would be a guess.
  expect(abortReason(plain.signal)).toBe("The operation was aborted.");
});
