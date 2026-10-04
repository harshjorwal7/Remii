import { expect, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { z } from "zod";
import { RemiLoopAgent } from "../src/remi/loop-agent";

/**
 * A tool that outlives its timeout is TOLD TO STOP, and told so in words the model can act on.
 *
 * The run's own abort already reached tools through the signal, but the TIMEOUT did not. The race
 * resolved with a sentence, the model read it, and the tool carried on regardless — which on a computer
 * is the worst available outcome. A `computer_click` that timed out had almost certainly been sent (the
 * timeout is the response being late, not the action), so the click landed after the model had read
 * "timed out", read the screen, seen no change, and clicked again. A double press caused entirely by our
 * own bookkeeping, and invisible from the outside.
 *
 * So the loop now hands each tool its own controller, aborted when the deadline passes, and the sentence
 * tells the model to look before acting again rather than to repeat the action. Both halves matter: a
 * cancellation the model is not told about still produces a duplicate, and a sentence the tool never
 * receives still produces a late click.
 */

const input: RunAgentInput = {
  threadId: "timeout-thread",
  runId: "timeout-run",
  messages: [{ id: "u1", role: "user", content: "Click the button." }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
};

type RunOutcome = { events: BaseEvent[]; completed: boolean; error?: string };

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

/** One step that asks for the tool, then a closing pass with no tool calls. */
async function modelServer(): Promise<{ url: string; close: () => void }> {
  let step = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.text();
      step += 1;
      const sse = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({
          id: `c${step}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      const body =
        step === 1
          ? `data: ${JSON.stringify({
              id: "c1",
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
                        id: "call_1",
                        type: "function",
                        function: { name: "slow_tool", arguments: "{}" },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            })}\n\ndata: ${JSON.stringify({
              id: "c1",
              object: "chat.completion.chunk",
              created: 1,
              model: "test-model",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            })}\n\ndata: [DONE]\n\n`
          : `${sse({ role: "assistant", content: "All done." }, "stop")}${sse(
              {},
              null,
            )}data: ${JSON.stringify({
              id: "c2",
              object: "chat.completion.chunk",
              created: 1,
              model: "test-model",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\ndata: [DONE]\n\n`;
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}/v1`,
    close: () => server.stop(true),
  };
}

test("a tool that ignores its deadline is aborted, and the model is warned it may have partly run", async () => {
  const server = await modelServer();
  const previous = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = server.url;

  let aborted = false;
  let signalWasPassed = false;
  let ranToCompletion = false;

  const agent = new RemiLoopAgent({
    botId: "timeout-bot",
    systemPrompt: "Call the tool.",
    model: { provider: "openai", model: "test-model" },
    apiKey: "test-key",
    maxSteps: 3,
    maxDurationMs: 30_000,
    toolTimeoutMs: 150,
    tools: [
      {
        name: "slow_tool",
        description: "A tool that outlives its deadline",
        parameters: z.object({}),
        execute: async (_args, signal) => {
          signalWasPassed = Boolean(signal);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 5_000);
            signal?.addEventListener(
              "abort",
              () => {
                // The whole point: the tool was told, rather than left to land a late click.
                aborted = true;
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
          ranToCompletion = true;
          // A tool that ignores the abort and reports success anyway — exactly the shape that used to
          // produce a click landing after the model had moved on.
          return "the click was sent";
        },
      },
    ],
  });

  try {
    const result = await runToCompletion(agent);

    // The tool received a signal it could act on.
    expect(signalWasPassed).toBe(true);
    // And it was aborted when the deadline passed, without waiting out its own five seconds.
    expect(aborted).toBe(true);
    expect(ranToCompletion).toBe(true);

    const toolResults = result.events
      .filter(
        (event) =>
          (event as { type?: string }).type === EventType.TOOL_CALL_RESULT,
      )
      .map((event) => JSON.stringify(event))
      .join(" ");

    /*
     * What the model was told. Not "Error: aborted" — which describes our bookkeeping rather than what
     * happened — and not the tool's own "the click was sent", which is a success the model would act on
     * and which may be a lie.
     */
    expect(toolResults).toContain("timed out");
    expect(toolResults).toContain("partly run");
    expect(toolResults).not.toContain("the click was sent");
  } finally {
    process.env.OPENAI_BASE_URL = previous;
    server.close();
  }
});
