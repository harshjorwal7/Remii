import { describe, expect, test } from "bun:test";
import type { BaseEvent, Message } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import {
  eventMessages,
  expandStoredMessage,
  toPartsRow,
} from "../src/threads/local";

/**
 * The durable transcript is rebuilt from events, because drivers promise the
 * event stream and not the messages left on the agent. A turn whose reply
 * streams but never lands in storage reads as a turn that never answered on
 * every reload after it.
 */

const textTriple = (id: string, parts: string[]): BaseEvent[] => [
  { type: EventType.TEXT_MESSAGE_START, messageId: id } as BaseEvent,
  ...parts.map(
    (delta) =>
      ({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: id,
        delta,
      }) as BaseEvent,
  ),
  { type: EventType.TEXT_MESSAGE_END, messageId: id } as BaseEvent,
];

describe("eventMessages", () => {
  test("assembles one assistant message from a start/content/end triple", () => {
    const messages = eventMessages(textTriple("m1", ["Hello", " there"]));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "m1",
      role: "assistant",
      content: "Hello there",
    });
  });

  test("recovers text that arrives with no start event", () => {
    const messages = eventMessages([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m9",
        delta: "orphan",
      } as BaseEvent,
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: "m9", content: "orphan" });
  });

  test("turns tool start/args/end/result into call and result messages", () => {
    const messages = eventMessages([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "c1",
        toolCallName: "search",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "c1",
        delta: '{"q":"x"}',
      } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "c1" } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "c1",
        content: "found",
      } as BaseEvent,
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "assistant" });
    expect(messages[1]).toMatchObject({
      role: "tool",
      toolCallId: "c1",
      content: "found",
    });
  });

  test("ignores lifecycle events", () => {
    expect(
      eventMessages([{ type: EventType.RUN_STARTED } as BaseEvent]),
    ).toEqual([]);
  });

  test("assembles chunked text the built-in loop streams", () => {
    const messages = eventMessages([
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        role: "assistant",
        messageId: "m1",
        delta: "Hello",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        role: "assistant",
        messageId: "m1",
        delta: " there",
      } as BaseEvent,
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "m1",
      role: "assistant",
      content: "Hello there",
    });
  });
});

describe("toPartsRow", () => {
  test("stores text, calls and results as typed parts", () => {
    const row = toPartsRow({
      id: "a1",
      role: "assistant",
      content: "calling",
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: { name: "x", arguments: "{}" },
        },
      ],
    } as Message);

    expect(row).toEqual({
      remi: 1,
      role: "assistant",
      parts: [
        { type: "text", text: "calling" },
        { type: "tool-call", id: "c1", name: "x", args: "{}" },
      ],
    });
  });

  test("stores a tool answer as its own part row", () => {
    const row = toPartsRow({
      id: "t1",
      role: "tool",
      toolCallId: "c1",
      content: "found",
    } as Message);

    expect(row).toEqual({
      remi: 1,
      role: "tool",
      parts: [{ type: "tool-result", id: "c1", result: "found" }],
    });
  });

  test("leaves non-conversation roles as AG-UI", () => {
    const message = {
      id: "act-1",
      role: "activity",
      activityType: "open-generative-ui",
      content: { html: ["<div>"] },
    } as unknown as Message;
    expect(toPartsRow(message)).toBeNull();
  });
});

describe("expandStoredMessage", () => {
  test("reads a parts row back as the AG-UI the browser parses", () => {
    expect(
      expandStoredMessage({
        messageId: "u1",
        role: "user",
        content: {
          remi: 1,
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
      }),
    ).toMatchObject({ id: "u1", role: "user", content: "hi" });
  });

  test("reads tool calls and results back with their ids", () => {
    expect(
      expandStoredMessage({
        messageId: "a1",
        role: "assistant",
        content: {
          remi: 1,
          role: "assistant",
          parts: [{ type: "tool-call", id: "c1", name: "x", args: "{}" }],
        },
      }),
    ).toMatchObject({
      id: "a1",
      role: "assistant",
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: { name: "x", arguments: "{}" },
        },
      ],
    });
    expect(
      expandStoredMessage({
        messageId: "t1",
        role: "tool",
        content: {
          remi: 1,
          role: "tool",
          parts: [{ type: "tool-result", id: "c1", result: "found" }],
        },
      }),
    ).toMatchObject({
      id: "t1",
      role: "tool",
      toolCallId: "c1",
      content: "found",
    });
  });

  test("reads pre-parts rows back untouched", () => {
    expect(
      expandStoredMessage({
        messageId: "old",
        role: "assistant",
        content: { role: "assistant", content: "kept" },
      }),
    ).toMatchObject({ id: "old", role: "assistant", content: "kept" });
  });
});

describe("truncateHistoryMessage", () => {
  test("a mailbox-sized tool result is cut to the history budget, with the cut marked", async () => {
    // Observed live: one 15MB Gmail dump in a 91-message thread. Served raw,
    // the history payload outruns the browser's deadline on every open and
    // the transcript reads as chats that never load.
    const { truncateHistoryMessage, HISTORY_MESSAGE_CHARS } = await import(
      "../src/threads/local"
    );
    const big = "x".repeat(HISTORY_MESSAGE_CHARS + 1000);
    const out = truncateHistoryMessage({
      id: "t1",
      role: "tool",
      content: big,
    } as Message);
    const content = (out as { content: string }).content;
    expect(content.length).toBeLessThan(big.length);
    expect(content).toContain("history trimmed here");
    expect(content.startsWith("x".repeat(100))).toBe(true);
  });

  test("ordinary turns pass through untouched", async () => {
    const { truncateHistoryMessage } = await import("../src/threads/local");
    const msg = {
      id: "t2",
      role: "assistant",
      content: "Hey! What do you need?",
    } as Message;
    expect(truncateHistoryMessage(msg)).toBe(msg);
  });

  test("text parts are cut but structure survives", async () => {
    const { truncateHistoryMessage, HISTORY_MESSAGE_CHARS } = await import(
      "../src/threads/local"
    );
    const big = "y".repeat(HISTORY_MESSAGE_CHARS + 10);
    const out = truncateHistoryMessage({
      id: "t3",
      role: "user",
      content: [{ type: "text", text: big }],
    } as unknown as Message);
    const parts = (out as { content: Array<{ text: string }> }).content;
    expect(parts[0]?.text).toContain("history trimmed here");
  });
});
