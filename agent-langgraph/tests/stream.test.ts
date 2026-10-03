import { describe, expect, test } from "bun:test";
import {
  EMPTY_REPLY_FALLBACK,
  isLoopLimit,
  LOOP_LIMIT_FALLBACK,
  type RunStreamEvent,
  streamRun,
} from "../src/stream";

/**
 * The reader that turns a run's framework events into the AG-UI wire.
 *
 * Driven with hand-built event streams rather than a real graph, because the thing worth pinning is
 * the translation: which AG-UI events a given sequence of framework events produces, and — the case
 * this suite exists for — that a run which produced nothing a person can see still ends on a visible
 * line rather than a silent RUN_FINISHED. The empty-reply guard used to live in the graph's state,
 * where this reader never looks, so it never reached the surface; the assertions below are on what
 * the surface actually receives.
 */

const RUN = { runId: "run_1", threadId: "thread_1" };

/** Collect what streamRun sends, as plain `{type, ...}` records. */
async function collect(
  events: RunStreamEvent[] | (() => Promise<AsyncIterable<RunStreamEvent>>),
): Promise<Array<Record<string, unknown>>> {
  const sent: Array<Record<string, unknown>> = [];
  const makeEvents =
    typeof events === "function"
      ? events
      : async () =>
          (async function* () {
            for (const event of events) yield event;
          })();
  await streamRun(makeEvents, RUN, (event) =>
    sent.push(event as unknown as Record<string, unknown>),
  );
  return sent;
}

const types = (sent: Array<Record<string, unknown>>) =>
  sent.map((event) => event.type);

const modelStream = (content: unknown): RunStreamEvent => ({
  event: "on_chat_model_stream",
  data: { chunk: { content } },
});

describe("a run that produces nothing a person can see", () => {
  test("an empty reply ends on the fallback line, not a silent RUN_FINISHED", async () => {
    // No stream deltas, no tool calls: the shape a strict provider returns on a run it will not
    // answer, and the shape the graph ends immediately.
    const sent = await collect([]);

    expect(types(sent)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(sent[1]).toMatchObject({ delta: EMPTY_REPLY_FALLBACK });
    // The message the fallback is drawn as has to be a real, closed message the surface can render.
    expect(sent[0]).toMatchObject({
      role: "assistant",
      messageId: "msg_run_1_0",
    });
  });

  test("a reply that is only a reasoning summary counts as empty", async () => {
    // The Responses API puts a reasoning model's private working in a content block with a `text`
    // field under a non-text type. It is never shown, so a reply carrying only that is silent to the
    // person and must reach the same fallback — the case the old state-based guard got wrong, because
    // it read any `text` field as visible.
    const sent = await collect([
      modelStream([{ type: "reasoning", text: "thinking it over" }]),
    ]);

    expect(types(sent)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(sent[1]).toMatchObject({ delta: EMPTY_REPLY_FALLBACK });
  });
});

describe("a run that does produce something is left alone", () => {
  test("streamed prose is forwarded and no fallback is added", async () => {
    const sent = await collect([modelStream("Hel"), modelStream("lo")]);

    expect(types(sent)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(sent[1]).toMatchObject({ delta: "Hel" });
    expect(sent[2]).toMatchObject({ delta: "lo" });
    // The fallback text appears nowhere.
    expect(sent.some((event) => event.delta === EMPTY_REPLY_FALLBACK)).toBe(
      false,
    );
  });

  test("responses-API content blocks are forwarded as text", async () => {
    const sent = await collect([
      modelStream([
        { type: "reasoning", text: "private" },
        { type: "text", text: "shown" },
      ]),
    ]);

    expect(types(sent)).toContain("TEXT_MESSAGE_CONTENT");
    expect(sent.find((e) => e.type === "TEXT_MESSAGE_CONTENT")).toMatchObject({
      delta: "shown",
    });
    expect(sent.some((event) => event.delta === EMPTY_REPLY_FALLBACK)).toBe(
      false,
    );
  });

  test("a tool the surface owns is reported with no result and no fallback", async () => {
    // The model asked for a browser-side tool; the graph ends the run without running it, so the
    // tools node never fires and the call is drained at the end with no result. It is still a thing
    // the surface has to do, so the run is not silent and gets no fallback.
    const sent = await collect([
      {
        event: "on_chat_model_end",
        data: {
          output: {
            tool_calls: [
              { id: "call_1", name: "show_chart", args: { kind: "bar" } },
            ],
          },
        },
      },
    ]);

    expect(types(sent)).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ]);
    expect(sent[0]).toMatchObject({
      toolCallId: "call_1",
      toolCallName: "show_chart",
    });
    expect(sent[1]).toMatchObject({ delta: JSON.stringify({ kind: "bar" }) });
    // A drained surface call carries no result — that is the surface's half.
    expect(types(sent)).not.toContain("TOOL_CALL_RESULT");
  });

  test("a tool this deployment ran is reported with its result and no fallback", async () => {
    const sent = await collect([
      {
        event: "on_chat_model_end",
        data: {
          output: {
            tool_calls: [{ id: "call_2", name: "search", args: { q: "cats" } }],
          },
        },
      },
      {
        event: "on_chain_end",
        name: "tools",
        data: {
          output: {
            messages: [{ tool_call_id: "call_2", content: "found 3" }],
          },
        },
      },
    ]);

    expect(types(sent)).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "RUN_FINISHED",
    ]);
    expect(sent[3]).toMatchObject({ toolCallId: "call_2", content: "found 3" });
    expect(sent.some((event) => event.delta === EMPTY_REPLY_FALLBACK)).toBe(
      false,
    );
  });
});

describe("message boundaries across a multi-turn run", () => {
  test("prose after a tool result opens a new message id", async () => {
    const sent = await collect([
      modelStream("Let me check"),
      {
        event: "on_chat_model_end",
        data: {
          output: { tool_calls: [{ id: "call_3", name: "search", args: {} }] },
        },
      },
      {
        event: "on_chain_end",
        name: "tools",
        data: {
          output: { messages: [{ tool_call_id: "call_3", content: "done" }] },
        },
      },
      modelStream("Here it is"),
    ]);

    const firstText = sent.find((e) => e.type === "TEXT_MESSAGE_START");
    const lastText = [...sent]
      .reverse()
      .find((e) => e.type === "TEXT_MESSAGE_START");
    expect(firstText).toMatchObject({ messageId: "msg_run_1_0" });
    // Reusing one id reopens a message the surface already closed and drops the second half; the
    // close between turns has to advance it.
    expect(lastText).toMatchObject({ messageId: "msg_run_1_1" });
    expect(firstText?.messageId).not.toBe(lastText?.messageId);
  });
});

describe("a failure mid-stream", () => {
  test("an open message is closed and the run ends on RUN_ERROR", async () => {
    const sent = await collect(async () =>
      (async function* () {
        yield modelStream("half a sentence");
        throw new Error("provider hung up");
      })(),
    );

    expect(types(sent)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_ERROR",
    ]);
    expect(sent.at(-1)).toMatchObject({ message: "provider hung up" });
    // A run that errored is not also finished.
    expect(types(sent)).not.toContain("RUN_FINISHED");
  });

  test("a failure opening the stream is reported as RUN_ERROR", async () => {
    const sent = await collect(async () => {
      throw new Error("could not build graph");
    });

    expect(types(sent)).toEqual(["RUN_ERROR"]);
    expect(sent[0]).toMatchObject({ message: "could not build graph" });
  });
});

/*
 * The tool loop running out of steps is an outcome, not a fault.
 *
 * It used to reach the surface as the framework's own exception — a recursion-limit sentence naming
 * a step count this Bot does not use, plus a troubleshooting URL for a graph the person cannot see.
 * Worse, arriving as RUN_ERROR made it a refusal the delivery would offer again, so one Bot going
 * round its loop cost five whole runs and four minutes of a conversation that had already stopped
 * moving. It now ends as a finished turn carrying a sentence about the person's own question.
 */
describe("a run that runs out of tool-loop steps", () => {
  test("ends finished, with a sentence rather than a framework error", async () => {
    const sent = await collect(async () => {
      throw new Error(
        "Recursion limit of 25 reached without hitting a stop condition. Troubleshooting URL: https://docs.langchain.com/oss/javascript/langgraph/GRAPH_RECURSION_LIMIT/",
      );
    });

    expect(types(sent)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    const words = sent
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => String((event as { delta?: unknown }).delta ?? ""))
      .join("");
    expect(words).toBe(LOOP_LIMIT_FALLBACK);
    // None of the framework's own wording reaches the person.
    expect(words).not.toContain("Recursion limit");
    expect(words).not.toContain("Troubleshooting URL");
  });

  test("is recognised whatever the framework calls it", () => {
    expect(isLoopLimit(new Error("Recursion limit of 12 reached"))).toBe(true);
    expect(isLoopLimit(new Error("recursionLimit"))).toBe(true);
    expect(isLoopLimit("Recursion limit")).toBe(true);
    expect(isLoopLimit(new Error("provider hung up"))).toBe(false);
    expect(isLoopLimit(new Error("fetch failed"))).toBe(false);
  });

  test("a real failure is still an error, not a finished turn", async () => {
    const sent = await collect(async () => {
      throw new Error("provider hung up");
    });

    expect(types(sent)).toContain("RUN_ERROR");
    expect(types(sent)).not.toContain("RUN_FINISHED");
  });
});

/*
 * A run that already said its answer is finished, however it stopped.
 *
 * This is the case that made a real audit look broken. The run read DNS, DMARC, TLS and CORS,
 * wrote its report, stated its findings — and then reached the graph's step bound, which was reported
 * as a failure. The answer was already on the wire. Worse, the delivery read the failure as worth
 * retrying and ran the whole audit again, four more times, against a target that had asked for one
 * non-destructive pass.
 *
 * So the bound is where a long job stops, not a verdict on it, and a run that has spoken is closed
 * as it stands.
 */
describe("a long run that already spoke before the bound", () => {
  /** A run that streamed real prose, and only then ran out of steps. */
  const spokeThenRanOut = () =>
    collect(async () =>
      (async function* (): AsyncGenerator<RunStreamEvent> {
        yield modelStream("Assessment complete. Report saved.");
        throw new Error(
          "Recursion limit of 60 reached without hitting a stop condition.",
        );
      })(),
    );

  test("keeps the answer and finishes, rather than reporting a failure", async () => {
    const sent = await spokeThenRanOut();

    expect(types(sent)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(sent[1]).toMatchObject({
      delta: "Assessment complete. Report saved.",
    });
    // Not a failure, so nothing retries the whole job.
    expect(types(sent)).not.toContain("RUN_ERROR");
  });

  test("does not overwrite a real answer with the bound's own sentence", async () => {
    const sent = await spokeThenRanOut();

    const words = sent
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => String((event as { delta?: unknown }).delta ?? ""))
      .join("");
    expect(words).toBe("Assessment complete. Report saved.");
    expect(words).not.toBe(LOOP_LIMIT_FALLBACK);
  });

  test("a run that reached the bound having said nothing still gets the sentence", async () => {
    const sent = await collect(async () => {
      throw new Error(
        "Recursion limit of 60 reached without hitting a stop condition.",
      );
    });

    expect(types(sent)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(sent[1]).toMatchObject({ delta: LOOP_LIMIT_FALLBACK });
  });
});
