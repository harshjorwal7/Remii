import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/client";
import type { AbstractAgent, BaseEvent, Message } from "@ag-ui/client";
import { lastValueFrom, toArray } from "rxjs";
import { eq } from "drizzle-orm";
import { threadMessages } from "../src/db/schema";
import { PostgresAgentRunner, createThreadStore } from "../src/threads/local";
import { testDatabase, } from "./support/database";

/**
 * A RUN'S EVENTS MUST NAME THE RUN'S THREAD.
 *
 * A run has one thread: the one its messages are persisted to. Every event that leaves the run also
 * claims a thread, and the two can disagree — the AG-UI agent mints a thread of its own for the
 * events it emits, as a bare `randomUUID` that is never registered in `threads` and that no channel,
 * lock, or history read can resolve.
 *
 * CopilotKit's Intelligence runner reconciles this on the `RUN_STARTED` it builds
 * (`event.threadId = request.threadId`). The plain in-memory runner — the base of the
 * `PostgresAgentRunner` this deployment uses — forwards the agent's events verbatim and only fills
 * in a missing `input`, so nothing corrects the id.
 *
 * That phantom is load-bearing downstream, not cosmetic. A delegated handoff records the asking
 * run's thread as `from.threadId`, and the roster resolves a run's channel by reading it back. A
 * thread that resolves to nothing yields no channel, so the `run_activity` row loses it — which is
 * how a real chat turn ended up with an activity row carrying a thread id absent from the database
 * and a channel indicator that could not be attributed.
 *
 * `PostgresAgentRunner` therefore re-stamps outgoing events with the thread it is running on.
 */

const database = testDatabase();
const store = createThreadStore(database);

/**
 * An agent that behaves like the real ones: it emits a `RUN_STARTED` carrying a thread of its own,
 * minted as a bare UUID, rather than the thread the run was started on.
 */
const agentWithOwnThread = (
  ownThreadId: string,
  runId: string,
): AbstractAgent => {
  const agent = {
    agentId: "phantom-thread-agent",
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      agent.messages = messages;
      return agent;
    },
    async runAgent(
      _input: unknown,
      handlers?: { onEvent?: (payload: { event: BaseEvent }) => void },
    ) {
      handlers?.onEvent?.({
        event: {
          type: EventType.RUN_STARTED,
          threadId: ownThreadId,
          runId,
        } as BaseEvent,
      });
    },
  };
  return agent as unknown as AbstractAgent;
};

const runOn = async (threadId: string, agent: AbstractAgent, runId: string) => {
  const runner = new PostgresAgentRunner(store);
  const input = {
    threadId,
    runId,
    state: {},
    messages: [{ id: `m-${randomUUID()}`, role: "user", content: "hello" }],
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const events = await lastValueFrom(
    runner.run({ threadId, agent, input } as never).pipe(toArray()) as Promise<
      BaseEvent[]
    >,
  );
  return { events, threadId };
};

describe("run events name the run's thread", () => {
  test("an event stamped with the agent's own thread is re-stamped with the run's thread", async () => {
    const threadId = `55569917-dab5-8d1e-9c6a-${randomUUID()}`;
    const ownThreadId = randomUUID();
    const { events } = await runOn(
      threadId,
      agentWithOwnThread(ownThreadId, "run-1"),
      "run-1",
    );

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.threadId).toBe(threadId);
    }
  });

  test("the thread the events name is the thread the messages were persisted to", async () => {
    const threadId = `55569917-dab5-8d1e-9c6a-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const agent = agentWithOwnThread(randomUUID(), runId);
    const { events } = await runOn(threadId, agent, runId);

    // The message the run was given, identified by the id the input carried.
    const messageId = (agent.messages[0]?.id ?? null) as string | null;
    expect(messageId).not.toBeNull();

    const persisted = await database
      .selectDistinct({ threadId: threadMessages.threadId })
      .from(threadMessages)
      .where(eq(threadMessages.messageId, messageId as string));
    expect(persisted.length).toBeGreaterThan(0);

    const persistedThreadIds = new Set(persisted.map((row) => row.threadId));
    expect(persistedThreadIds.has(threadId)).toBe(true);
    for (const event of events) {
      expect(persistedThreadIds.has(event.threadId)).toBe(true);
    }
  });

  test("an event already carrying the run's thread is passed through untouched", async () => {
    const threadId = `55569917-dab5-8d1e-9c6a-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const { events } = await runOn(
      threadId,
      agentWithOwnThread(threadId, runId),
      runId,
    );

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.threadId).toBe(threadId);
    }
  });
});
