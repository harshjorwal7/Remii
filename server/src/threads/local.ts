import { randomUUID } from "node:crypto";
import type { AbstractAgent, BaseEvent, Message } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import {
  type AgentRunnerRunRequest,
  InMemoryAgentRunner,
} from "@copilotkit/runtime/v2";
import { and, asc, eq, sql } from "drizzle-orm";
import { Observable } from "rxjs";
import type { Database } from "../db/client";
import { threadLocks, threadMessages, threads } from "../db/schema";

/**
 * Durable threads in Postgres, replacing the Intelligence platform store.
 *
 * Every conversation a person, routine or hop runs in is a row in `threads`
 * with its messages beside it. The canonical stored form is the AG-UI
 * message itself; readers that speak the old platform row shape convert on
 * the way out. Thread ids are minted locally and unguessable; per-person
 * access rides on channel membership and the agent roster, exactly as it did
 * with platform threads.
 */

export type HistoryRow = {
  id: string;
  role: string;
  content: string;
  activityType?: string;
  toolCalls?: { id: string; name: string; args: string }[];
  toolCallId?: string;
};

function textOf(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part === "object" && part !== null && "text" in part
            ? String((part as { text?: unknown }).text ?? "")
            : "",
      )
      .join("");
  }
  return "";
}

/**
 * One stored AG-UI message as the old platform row shape.
 *
 * The platform typed `role` as string and `content` as unknown with tool
 * calls nested as `{ id, name, args }`; readers (routine seeding, handoff
 * context, channel titles) were written against that, so the conversion
 * lives here once rather than at every reader.
 */
export function toHistoryRow(message: Message): HistoryRow {
  const record = message as unknown as Record<string, unknown>;
  const toolCalls = Array.isArray(record.toolCalls)
    ? (
        record.toolCalls as {
          id: string;
          function?: { name?: string; arguments?: string };
          name?: string;
          args?: string;
        }[]
      ).map((call) => ({
        id: String(call.id),
        name: String(call.function?.name ?? call.name ?? ""),
        args: String(call.function?.arguments ?? call.args ?? ""),
      }))
    : undefined;
  return {
    id: String(record.id ?? ""),
    role: String(record.role ?? ""),
    content: textOf(message),
    ...(typeof record.activityType === "string"
      ? { activityType: record.activityType }
      : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(typeof record.toolCallId === "string"
      ? { toolCallId: record.toolCallId }
      : {}),
  };
}

/**
 * A stored conversation row in Remi parts shape.
 *
 * The wire stays AG-UI — every reader (loop seeding, transcript, sanitize, routines,
 * handoff context) speaks it — but what Postgres holds is typed parts, the way Remi stores
 * `text` / `reasoning` / `dynamic-tool` parts instead of protocol blobs: one part per thing
 * the message carries, each saying its own kind. `toPartsRow` writes this shape,
 * `expandPartsRow` reads it back, and rows written before the shape existed (bare AG-UI
 * JSON) read back untouched, so no migration rewrites history.
 */
export type RemiPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; id: string; name: string; args: string }
  | { type: "tool-result"; id: string; result: string };

export type RemiRowContent = {
  remi: 1;
  role: string;
  parts: RemiPart[];
};

function isRemiRowContent(content: unknown): content is RemiRowContent {
  if (typeof content !== "object" || content === null) return false;
  const record = content as { remi?: unknown; parts?: unknown };
  return record.remi === 1 && Array.isArray(record.parts);
}

/** One live AG-UI message as a stored Remi parts row, or null to keep AG-UI as-is. */
export function toPartsRow(message: Message): RemiRowContent | null {
  const record = message as unknown as Record<string, unknown>;
  const role = String(record.role ?? "assistant");
  // Only the three conversation roles take the parts shape: anything else (activities and
  // whatever the future adds) stores byte-identical AG-UI rather than squeezing into parts
  // and losing fields no part names.
  if (role !== "user" && role !== "assistant" && role !== "tool") return null;
  const parts: RemiPart[] = [];
  const text = textOf(message);
  const calls = Array.isArray(record.toolCalls)
    ? (record.toolCalls as {
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
        name?: unknown;
        args?: unknown;
      }[])
    : [];
  if (role === "tool" && typeof record.toolCallId === "string") {
    parts.push({ type: "tool-result", id: record.toolCallId, result: text });
    return { remi: 1, role, parts };
  }
  if (text) parts.push({ type: "text", text });
  for (const call of calls) {
    if (typeof call !== "object" || call === null) continue;
    const id = call.id;
    if (typeof id !== "string" || !id) continue;
    parts.push({
      type: "tool-call",
      id,
      name: String(call.function?.name ?? call.name ?? ""),
      args: String(call.function?.arguments ?? call.args ?? "{}"),
    });
  }
  return { remi: 1, role, parts };
}

/** A stored Remi parts row back into the live AG-UI message readers speak. */
function expandPartsRow(messageId: string, content: RemiRowContent): Message {
  const texts: string[] = [];
  const calls: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[] = [];
  let toolCallId: string | null = null;
  let result = "";
  for (const part of content.parts) {
    if (part.type === "text") texts.push(part.text);
    else if (part.type === "tool-call") {
      calls.push({
        id: part.id,
        type: "function",
        function: { name: part.name, arguments: part.args },
      });
    } else if (part.type === "tool-result") {
      toolCallId = part.id;
      result = part.result;
    }
  }
  if (content.role === "tool" && toolCallId) {
    return {
      id: messageId,
      role: "tool",
      toolCallId,
      content: result,
    } as Message;
  }
  return {
    id: messageId,
    role: content.role,
    ...(texts.length > 0 ? { content: texts.join("\n") } : { content: "" }),
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
  } as Message;
}

function _textOfParts(content: RemiRowContent): string {
  const texts: string[] = [];
  for (const part of content.parts) {
    if (part.type === "text") texts.push(part.text);
    else if (part.type === "tool-result") texts.push(part.result);
  }
  return texts.join("\n");
}

/**
 * A stored row back into the live AG-UI message every reader speaks.
 *
 * Exported because the browser's history route (`GET
 * /api/copilotkit/threads/:id/messages` in app.ts) reads the table
 * directly: it must expand Remi parts rows exactly the way the store does,
 * or every parts-shaped turn arrives as `{remi, parts}` and the transcript
 * drops it as unreadable.
 */
export function expandStoredMessage(row: {
  messageId: string;
  role: string;
  content: unknown;
}): Message {
  return fromRow(row);
}

/**
 * What one history turn may weigh on the wire, in characters.
 *
 * A single tool result can hold a whole mailbox (observed: one 15MB Gmail
 * dump in a 91-message thread). The transcript renders text, so beyond this
 * nothing more is read — but everything more is still downloaded, parsed and
 * Zod-checked, which is how a heavy thread outruns the browser's 2.5s
 * history deadline on every open and reads as "chats never load". The stored
 * row is untouched: this trims only what history restoration serves.
 */
export const HISTORY_MESSAGE_CHARS = 32_768;

function truncatedNote(kept: number, total: number): string {
  return `\n\n[…history trimmed here: showing ${kept.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters…]`;
}

/** A string cut to the history budget, with its cut marked. */
function truncateText(value: string): string {
  if (value.length <= HISTORY_MESSAGE_CHARS) return value;
  return (
    value.slice(0, HISTORY_MESSAGE_CHARS) +
    truncatedNote(HISTORY_MESSAGE_CHARS, value.length)
  );
}

/**
 * One expanded history turn, trimmed for serving.
 *
 * String content and text parts are cut to {@link HISTORY_MESSAGE_CHARS};
 * tool-call arguments are left whole (the model wrote them, they are small,
 * and the transcript shows them collapsed). Structure, ids and order are
 * untouched, so what renders is the conversation, only shorter where a
 * single turn carried a mailbox.
 */
export function truncateHistoryMessage(message: Message): Message {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const cut = truncateText(content);
    return cut === content
      ? message
      : ({ ...message, content: cut } as Message);
  }
  if (Array.isArray(content)) {
    let changed = false;
    const parts = content.map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        const text = (part as { text: string }).text;
        const cut = truncateText(text);
        if (cut !== text) {
          changed = true;
          return { ...part, text: cut };
        }
      }
      return part;
    });
    return changed ? ({ ...message, content: parts } as Message) : message;
  }
  return message;
}

function fromRow(row: {
  messageId: string;
  role: string;
  content: unknown;
}): Message {
  if (isRemiRowContent(row.content)) {
    return expandPartsRow(row.messageId, row.content);
  }
  // Rows written before the parts shape: bare AG-UI JSON, read back untouched.
  const content = row.content as Record<string, unknown>;
  return {
    ...(typeof content === "object" && content !== null ? content : {}),
    id: row.messageId,
    role: row.role,
  } as Message;
}

/** The tool call ids an already-stored message carries, in either row shape. */
function toolCallIdsOf(content: unknown): string[] {
  if (isRemiRowContent(content)) {
    return content.parts
      .filter(
        (part): part is Extract<RemiPart, { type: "tool-call" }> =>
          part.type === "tool-call",
      )
      .map((part) => part.id);
  }
  if (typeof content !== "object" || content === null) return [];
  const calls = (content as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls
    .map((call) =>
      typeof call === "object" && call !== null
        ? (call as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string");
}

/** The tool answer a message carries, in either row shape. */
function toolResultOf(
  content: unknown,
): { id: string; content: string } | null {
  if (isRemiRowContent(content)) {
    const found = content.parts.find(
      (part): part is Extract<RemiPart, { type: "tool-result" }> =>
        part.type === "tool-result",
    );
    return found ? { id: found.id, content: found.result } : null;
  }
  if (typeof content !== "object" || content === null) return null;
  const record = content as { toolCallId?: unknown; content?: unknown };
  if (typeof record.toolCallId !== "string") return null;
  return { id: record.toolCallId, content: textOf(record as never) };
}

/** Whether a not-yet-stored message says nothing at all. */
function isSilentRecord(record: Record<string, unknown>): boolean {
  const content = record.content;
  if (content === undefined || content === null) return true;
  if (typeof content === "string") return content.length === 0;
  if (Array.isArray(content)) return content.length === 0;
  return false;
}

/** A message with its tool calls removed, for storing a text remainder whose calls echo rows. */
function withoutToolCalls(message: Message): Message {
  const { toolCalls: _dropped, ...rest } = message as Message & {
    toolCalls?: unknown;
  };
  return rest as Message;
}

export function createThreadStore(database: Database) {
  return {
    /**
     * Is this conversation one this person is allowed to run in?
     *
     * A run names the thread it happens in, and that name arrives from the caller. The transcript
     * READ is authorized — it joins `threads` and asks whether `userId` is the person asking — but
     * the WRITE was not: the runner appends to `thread_messages` for whatever id it is handed, and
     * `ensureThread` will even attach an owner to a thread that has none. So a caller who learned
     * somebody else's thread id could post a run into that conversation and have the Bot's reply
     * stored into it, and read that reply back.
     *
     * A thread with no owner yet is allowed, and claimed: that is how a conversation gets its first
     * row, and refusing it would break every new channel. A thread owned by somebody ELSE is not,
     * and that is the whole check.
     *
     * Returns the owning id so the caller can name the conflict, rather than a bare boolean that
     * leaves the decision of what to do with it to every call site.
     */
    async threadOwner(threadId: string): Promise<string | null> {
      const [row] = await database
        .select({ userId: threads.userId })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1);
      return row?.userId ?? null;
    },

    async ensureThread(input: {
      threadId: string;
      userId?: string | null;
      agentId?: string | null;
    }): Promise<void> {
      await database
        .insert(threads)
        .values({
          id: input.threadId,
          userId: input.userId ?? null,
          agentId: input.agentId ?? null,
        })
        /*
         * THE OWNER IS FILLED IN ON THE WAY PAST, which `onConflictDoNothing` made impossible.
         *
         * A thread's `user_id` is what the transcript route authorises against: it reads
         * `/api/copilotkit/threads/:id/messages` by joining `threads` and requiring
         * `threads.userId = <the person asking>`. A thread that exists with no owner is therefore a
         * conversation a member can see in their roster and cannot read a word of — and nothing could
         * ever fix it, because every writer of this row ignored a conflict. Both writers did:
         * `ensureThread` here, and `makeChannel` in `channels/routes.ts`.
         *
         * COALESCE, so a thread that already knows its owner keeps it. A later caller must not be
         * able to take a conversation away from the person it belongs to, and the common case is a
         * second `ensureThread` from an unrelated run that happens to name the same thread.
         */
        .onConflictDoUpdate({
          target: threads.id,
          set: {
            userId: sql`coalesce(${threads.userId}, excluded.user_id)`,
            agentId: sql`coalesce(${threads.agentId}, excluded.agent_id)`,
          },
        });
      await database
        .update(threads)
        .set({ updatedAt: new Date() })
        .where(eq(threads.id, input.threadId));
    },

    /**
     * Append messages nobody has stored yet, by AG-UI id.
     *
     * Idempotent on purpose: retries, restarts and double-settling all call
     * this with overlapping sets, and a message stored twice would replay
     * twice. The check-then-insert races under concurrency; the loser hits
     * the primary key and is ignored rather than failing the turn.
     *
     * Deduplicated by TOOL CALL as well as by message id, because the same call reaches this
     * store under two ids: the runner rebuilds the call from the run's events keyed by the
     * call id, while the browser holds the same call under its own message id and sends it
     * back as input on the next run. Storing both leaves one call id in history twice with
     * one result between them, and the model provider refuses every later turn of that thread
     * (`AI_MissingToolResultsError`). A call whose id is already stored is an echo: its calls
     * are stripped, a husk left with nothing said is dropped, and a tool result repeating an
     * identical answer is dropped too.
     */
    async appendMessages(
      threadId: string,
      messages: readonly Message[],
    ): Promise<void> {
      const existing = await database
        .select({
          messageId: threadMessages.messageId,
          content: threadMessages.content,
        })
        .from(threadMessages)
        .where(eq(threadMessages.threadId, threadId));
      const seen = new Set(existing.map((row) => row.messageId));
      const seenCalls = new Set<string>();
      const seenResults = new Map<string, Set<string>>();
      for (const row of existing) {
        for (const id of toolCallIdsOf(row.content)) seenCalls.add(id);
        const result = toolResultOf(row.content);
        if (result) {
          const contents = seenResults.get(result.id);
          if (contents) contents.add(result.content);
          else seenResults.set(result.id, new Set([result.content]));
        }
      }
      const pending: (typeof threadMessages.$inferInsert)[] = [];
      for (const message of messages) {
        const record = message as unknown as Record<string, unknown>;
        // Streamed messages can arrive without an id until the run
        // finalizes them; mint one rather than dropping the row, or every
        // assistant reply vanishes while its usage row claims a turn ran.
        const messageId =
          typeof record.id === "string" && record.id.length > 0
            ? record.id
            : randomUUID();
        if (seen.has(messageId)) continue;
        seen.add(messageId);

        let storing: Message = message;
        const calls = Array.isArray(record.toolCalls)
          ? (record.toolCalls as { id?: unknown }[])
          : undefined;
        if (calls !== undefined) {
          const fresh = calls.filter(
            (call) => typeof call.id === "string" && !seenCalls.has(call.id),
          );
          for (const call of fresh) seenCalls.add(call.id as string);
          if (fresh.length < calls.length) {
            if (fresh.length === 0 && isSilentRecord(record)) continue;
            storing = (
              fresh.length > 0
                ? { ...message, toolCalls: fresh }
                : withoutToolCalls(message)
            ) as Message;
          }
        }
        const result = toolResultOf(storing);
        if (result) {
          const contents = seenResults.get(result.id);
          if (contents?.has(result.content)) continue;
          if (contents) contents.add(result.content);
          else seenResults.set(result.id, new Set([result.content]));
        }
        pending.push({
          id: `${threadId}:${messageId}`,
          threadId,
          messageId,
          role: String(
            (storing as unknown as Record<string, unknown>).role ??
              record.role ??
              "assistant",
          ),
          // Stored as Remi parts, read back as AG-UI in fromRow: the wire keeps
          // speaking AG-UI while Postgres holds typed parts. Anything without a parts
          // shape (activities and future roles) stores byte-identical AG-UI instead.
          content: (toPartsRow(storing) ?? storing) as unknown as Record<
            string,
            unknown
          >,
        });
      }
      if (pending.length > 0) {
        /*
         * ONE INSERT FOR THE WHOLE BATCH, not a per-message loop.
         *
         * The old shape did an awaited INSERT per message: sixty turns in a tool-heavy
         * conversation was sixty network round trips to Neon, occupying a pooled
         * connection for tens of seconds and queueing every concurrent read (history
         * loads included) behind it — the "earlier messages can't load" stall. One
         * statement holds the connection for a single round trip.
         */
        await database.insert(threadMessages).values(pending).onConflictDoNothing();
      }
      await database
        .update(threads)
        .set({ updatedAt: new Date() })
        .where(eq(threads.id, threadId));
    },

    async getMessages(threadId: string, userId?: string): Promise<Message[]> {
      const rows = await database
        .select({
          messageId: threadMessages.messageId,
          role: threadMessages.role,
          content: threadMessages.content,
        })
        .from(threadMessages)
        .innerJoin(threads, eq(threadMessages.threadId, threads.id))
        .where(
          userId
            ? and(
                eq(threadMessages.threadId, threadId),
                eq(threads.userId, userId),
              )
            : eq(threadMessages.threadId, threadId),
        )
        .orderBy(asc(threadMessages.createdAt));
      return rows.map(fromRow);
    },

    async getHistory(threadId: string, userId?: string): Promise<HistoryRow[]> {
      return (await this.getMessages(threadId, userId)).map(toHistoryRow);
    },

    async exists(threadId: string): Promise<boolean> {
      const rows = await database
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1);
      return rows.length > 0;
    },
  };
}

export type ThreadStore = ReturnType<typeof createThreadStore>;

/**
 * A run at a time per conversation, enforced locally.
 *
 * Replaces the platform's thread lock with the same contract: acquiring a
 * held, unexpired lock throws a 409-coded denial (which the existing
 * contention paths already translate), renewing bumps the expiry, releasing
 * deletes. An expired row is stealable, so a crashed process stops holding
 * its threads after the TTL rather than forever.
 */
export class ThreadLockDenied extends Error {
  readonly status = 409;
  constructor(threadId: string) {
    super(`Thread lock denied for thread ${threadId}: another run holds it.`);
    this.name = "ThreadLockDenied";
  }
}

/**
 * A moment `seconds` from now, named in SQL so it is the DATABASE's clock.
 *
 * The lock is a distributed lease, and a lease whose ends are written by one replica's clock and
 * read by another's is not a lease: a replica 45 seconds behind writes an expiry that a replica 30
 * seconds ahead already considers past, and it settles a hop that is still streaming into the thread
 * and deletes the lock it is holding. The work queue reached this first and computes its leases this
 * way for exactly this reason; the thread lock has to as well, or the two disagree about when the
 * same run started.
 */
function lockExpiry(seconds: number) {
  return sql`now() + make_interval(secs => ${seconds})`;
}

export function createThreadLock(database: Database) {
  return {
    /**
     * Take the thread, or be told somebody else has it.
     *
     * ONE STATEMENT, because the previous shape was a read followed by a write and the gap between
     * them was the bug: two hops into the same conversation on two replicas both read "free", both
     * wrote, and the second silently overwrote the first's `run_id` — so both were told they held
     * the thread and both appended a turn to it. That defeats the only thing this lock is for, and
     * it is invisible from one replica because each of them succeeded.
     *
     * So the claim is an upsert that may only overwrite an expiry the database considers PAST, and
     * it returns the row it took. Zero rows back means somebody live holds it, which is the one
     * answer the caller needs, and it is the same answer whether the holder is on this replica or
     * another.
     */
    async acquire(input: {
      threadId: string;
      runId: string;
      userId?: string;
      agentId?: string;
      ttlSeconds?: number;
    }): Promise<{ runId: string }> {
      const ttl = input.ttlSeconds ?? 120;
      const taken = await database
        .insert(threadLocks)
        .values({
          threadId: input.threadId,
          runId: input.runId,
          expiresAt: lockExpiry(ttl),
        })
        .onConflictDoUpdate({
          target: threadLocks.threadId,
          set: { runId: input.runId, expiresAt: lockExpiry(ttl) },
          /*
           * The condition that makes this safe, and it has to be the ONLY way to overwrite. A live
           * holder is one whose expiry the database says is still in the future; anything else may
           * be taken over, because a holder that let its lease lapse is what "expired" means.
           */
          setWhere: sql`${threadLocks.expiresAt} <= now()`,
        })
        .returning({ threadId: threadLocks.threadId });
      if (taken.length === 0) throw new ThreadLockDenied(input.threadId);
      return { runId: input.runId };
    },

    /**
     * Push this run's own expiry out, and say whether it still owns the lock.
     *
     * `runId` WAS ACCEPTED AND IGNORED, which is the second half of the same failure. A holder that
     * lost its lease to another run kept heartbeating, and every beat pushed the NEW holder's expiry
     * forward while reporting success — so the run that had been locked out went on streaming into
     * the thread, and kept the thread locked after the run that actually held it had died.
     *
     * The predicate is therefore on both the thread and the run, and the return value is the
     * heartbeat's only honest signal: `false` means this run no longer holds the thread and must
     * stop writing to it.
     */
    async renew(input: {
      threadId: string;
      runId: string;
      ttlSeconds: number;
    }): Promise<boolean> {
      const held = await database
        .update(threadLocks)
        .set({ expiresAt: lockExpiry(input.ttlSeconds) })
        .where(
          and(
            eq(threadLocks.threadId, input.threadId),
            eq(threadLocks.runId, input.runId),
          ),
        )
        .returning({ threadId: threadLocks.threadId });
      return held.length > 0;
    },

    async release(input: { threadId: string; runId: string }): Promise<void> {
      // Any holder's row goes: a release that finds no row, or another run's
      // row after a steal, is already the state being asked for.
      await database
        .delete(threadLocks)
        .where(eq(threadLocks.threadId, input.threadId));
    },

    async sweepExpired(): Promise<number> {
      // `now()` rather than the caller's clock, for the reason `lockExpiry` gives.
      const rows = await database
        .delete(threadLocks)
        .where(sql`${threadLocks.expiresAt} <= now()`)
        .returning({ threadId: threadLocks.threadId });
      return rows.length;
    },
  };
}

export type ThreadLock = ReturnType<typeof createThreadLock>;

/**
 * The old platform client, answered locally.
 *
 * Headless turns, channel summaries and handoffs were written against a
 * narrow structural client (`IntelligenceLike` in routines/run-turn.ts):
 * get-or-create, message history, and lock acquire/renew/release. This
 * answers that exact shape off the store and lock above, so those call sites
 * move without edits and their fakes keep working in tests.
 */
export function createLocalIntelligence(store: ThreadStore, lock: ThreadLock) {
  return {
    getOrCreateThread: async (params: {
      threadId: string;
      userId: string;
      agentId: string;
    }): Promise<unknown> => {
      await store.ensureThread(params);
      return { thread: { id: params.threadId } };
    },
    getThreadMessages: async (params: {
      threadId: string;
      userId: string;
    }): Promise<{ messages: HistoryRow[] }> => {
      return {
        messages: await store.getHistory(params.threadId, params.userId),
      };
    },
    ɵacquireThreadLock: (params: {
      threadId: string;
      runId: string;
      userId: string;
      agentId: string;
      ttlSeconds?: number;
    }) => lock.acquire(params),
    ɵrenewThreadLock: (params: {
      threadId: string;
      runId: string;
      ttlSeconds: number;
    }) => lock.renew(params),
    ɵcleanupThreadLock: (params: {
      threadId: string;
      runId: string;
    }): Promise<void> => lock.release(params),
  };
}

/**
 * Rebuild transcript messages out of the event stream.
 *
 * The runner hands the agent to whatever drives the run, and that driver —
 * the runtime's handle-run, the routine runner, a hop delivery — does not
 * promise to leave the finished messages on `agent.messages`. What it does
 * promise is the events, so the durable transcript is rebuilt from them:
 * text messages from start/content/end triples, tool calls from
 * start/args/end, results as tool-role messages. Field reads are defensive
 * across the SDK's naming variants rather than exact, because an exact read
 * against one version is a dropped transcript on the next.
 */
type PendingText = { id: string; role: string; buffer: string };
type PendingTool = { id: string; name: string; args: string };

/** Rebuilt transcript, exported for tests: drivers promise events, not messages. */
export function eventMessages(events: BaseEvent[]): Message[] {
  const out: Message[] = [];
  let text: PendingText | null = null;
  const tools = new Map<string, PendingTool>();
  const flushText = () => {
    if (text && (text.buffer.length > 0 || text.id)) {
      out.push({
        id: text.id,
        role: text.role,
        content: text.buffer,
      } as Message);
    }
    text = null;
  };
  const read = (event: BaseEvent): Record<string, unknown> =>
    event as unknown as Record<string, unknown>;
  const str = (value: unknown): string =>
    typeof value === "string" ? value : "";
  for (const event of events) {
    const record = read(event);
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START: {
        flushText();
        text = {
          id:
            str(record.messageId ?? record.messageID ?? record.id) ||
            randomUUID(),
          role: str(record.role) || "assistant",
          buffer: "",
        };
        break;
      }
      case EventType.TEXT_MESSAGE_CONTENT: {
        const delta = str(record.delta ?? record.content ?? record.text);
        if (!text) {
          text = {
            id:
              str(record.messageId ?? record.messageID ?? record.id) ||
              randomUUID(),
            role: str(record.role) || "assistant",
            buffer: "",
          };
        }
        text.buffer += delta;
        break;
      }
      case EventType.TEXT_MESSAGE_CHUNK: {
        // What the built-in loop streams: deltas with no start/end envelope. Accumulated
        // per message id like CONTENT, so a turn persists from events alone even when the
        // agent's own messages never arrive — the failure this whole rebuild exists for.
        const delta = str(record.delta ?? record.content ?? record.text);
        const id =
          str(record.messageId ?? record.messageID ?? record.id) ||
          randomUUID();
        if (!text || text.id !== id) {
          flushText();
          text = { id, role: str(record.role) || "assistant", buffer: "" };
        }
        text.buffer += delta;
        break;
      }
      case EventType.TEXT_MESSAGE_END: {
        flushText();
        break;
      }
      case EventType.TOOL_CALL_START: {
        const toolCallId = str(record.toolCallId ?? record.id);
        if (toolCallId && !tools.has(toolCallId)) {
          tools.set(toolCallId, {
            id: toolCallId,
            name: str(record.toolCallName ?? record.toolName ?? record.name),
            args: "",
          });
        }
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        const toolCallId = str(record.toolCallId ?? record.id);
        const tool = tools.get(toolCallId);
        if (tool) tool.args += str(record.delta ?? record.args);
        break;
      }
      case EventType.TOOL_CALL_END: {
        const toolCallId = str(record.toolCallId ?? record.id);
        const tool = tools.get(toolCallId);
        if (tool) {
          out.push({
            id: tool.id,
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: tool.id,
                type: "function",
                function: { name: tool.name, arguments: tool.args },
              },
            ],
          } as unknown as Message);
          tools.delete(toolCallId);
        }
        break;
      }
      case EventType.TOOL_CALL_RESULT: {
        const toolCallId = str(record.toolCallId ?? record.id);
        const content = str(record.content ?? record.result ?? record.output);
        if (toolCallId || content) {
          out.push({
            id: str(record.messageId ?? record.id) || randomUUID(),
            role: "tool",
            toolCallId,
            content,
          } as unknown as Message);
        }
        tools.delete(toolCallId);
        break;
      }
      default:
        break;
    }
  }
  flushText();
  return out;
}

/**
 * The runner, executing locally and remembering durably.
 *
 * `InMemoryAgentRunner` keeps the execution semantics — driving
 * `agent.runAgent`, concurrency refusal, stop, connect — and its store keeps
 * this process's live runs. What it cannot do is survive a restart, so this
 * subclass mirrors every run's transcript into Postgres: input messages
 * before, the agent's messages after, both idempotent by message id. The
 * local thread endpoints read Postgres rather than the process store, which
 * is what makes history available to a fresh process and to every replica.
 */
export class PostgresAgentRunner extends InMemoryAgentRunner {
  private readonly threads: ThreadStore;

  constructor(threads: ThreadStore) {
    /*
     * SUPERSEDE, NOT THROW, and this is the whole reason a chat stops working when you come back to it.
     *
     * `InMemoryAgentRunner` refuses a second run on a live thread by default (`onConcurrentRun:
     * "throw"`), which is right for a runner that cannot tell a stale caller from a live one. Here it
     * is catastrophically wrong, because the caller this deployment has is a BROWSER that is allowed to
     * leave:
     *
     * Navigating from a conversation does not abort its run. Nothing in the app calls `abortRun` on
     * unmount, and that is deliberate — a person who closes a tab has not asked for their work to stop.
     * So the run goes on executing here, holding the thread, for up to the stall watchdog (60s) or the
     * 20-minute channel cap, whichever comes first.
     *
     * Come back, type, send. With `"throw"` the refusal is raised inside the observable factory, which
     * the SSE handler has already answered `200 text/event-stream` by then — so the browser receives a
     * successful response with an empty body. `copilotkit.runAgent` resolves with zero events, the
     * client sees a run that neither answered nor failed, the composer has already cleared the draft,
     * and no error is drawn anywhere. The message sits in the transcript with no reply, and every retry
     * does the same thing, until the orphan finally ends. That is the bug: not an error, a silence.
     *
     * `supersede` makes the new message win instead. It ends the prior run, aborts its agent, and starts
     * cleanly — which is what the person meant by typing into a conversation they had walked away from.
     *
     * WHAT THIS COSTS, stated rather than discovered. A second browser tab on one thread now kills the
     * first tab's run rather than being refused. For a per-person deployment where the thread belongs to
     * one person's conversation, that is the right trade: the alternative is a chat that cannot be typed
     * into at all. It is the wrong trade for a shared thread with several people genuinely typing at
     * once, and it would be wrong for a routine firing into a thread a person is also writing in.
     *
     * Safe against the OTHER reader of this flag, the thread lock: a chat run takes no `thread_locks`
     * row at all (it runs through the runtime, not the Intelligence runner — see
     * `activity/abandoned.ts`), so superseding cannot strand a lease or leave a lock behind. Handoff
     * hops, which DO take a lock, reach this runner through `agentFor` and would have been refused by the
     * lock first; they are additionally sequenced by that lock, which is what keeps a hop from being
     * superseded by a person's next message mid-delivery.
     */
    super({ onConcurrentRun: "supersede" });
    this.threads = threads;
  }

  override run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const threadId = request.threadId;

    /*
     * The run's events must name the run's thread, and this runner does not get that for free.
     *
     * A run has one thread — the one its messages are persisted to, `threadId` — and every event
     * that leaves it claims one. Those two can disagree, because the AG-UI agent mints a thread of
     * its own for the events it emits and that thread is a bare `randomUUID`: it is not registered
     * in `threads`, and no channel, lock, or history read can resolve it. So a run would stream a
     * transcript into the real channel thread while advertising a conversation that does not exist.
     *
     * Downstream that phantom is not cosmetic. A delegated handoff records the asking run's thread
     * as `from.threadId`, and the roster's per-channel activity reads it back to work out which
     * channel a run belonged to. Given a thread that resolves to nothing, that channel lookup comes
     * back empty, the activity row loses its channel, and the row then has to guess — which is how
     * a chat turn ends up with a `run_activity` row carrying a thread id that is not in the database
     * at all, and a channel whose activity indicator cannot be attributed.
     *
     * CopilotKit's Intelligence runner reconciles this itself (`event.threadId = request.threadId`
     * on the `RUN_STARTED` it builds). The plain in-memory runner — the one this class extends —
     * forwards the agent's events verbatim and only fills in a missing `input`, so nothing corrects
     * the id. Reconciled here instead, on the way out, where the authoritative thread is in hand.
     *
     * `threadId` is the authority, not the event: it is the thread the messages were just appended
     * to, and it is the thread the caller asked to run on.
     */
    const withRunThread = (event: BaseEvent): BaseEvent => {
      if (event.threadId === threadId) return event;
      return { ...event, threadId } as BaseEvent;
    };

    const agent: AbstractAgent = request.agent;
    const inputMessages = Array.isArray(request.input.messages)
      ? request.input.messages
      : [];
    /*
     * Seed a fresh agent with the run's own messages.
     *
     * `runAgent` builds its model input from `this.messages`, not from the
     * passed input: on the hosted backend that was correct, because the
     * platform ran with its stored transcript and the local object was only
     * a handle. Locally the object IS the run, so an agent that arrives
     * empty would answer with no knowledge of the question — the model saw
     * an empty conversation. Only an empty agent is seeded; anything already
     * holding messages (a routine's seeded history, a hop's context) is left
     * exactly as its builder arranged it.
     */
    if (agent.messages.length === 0 && inputMessages.length > 0) {
      agent.setMessages(inputMessages);
    }
    // Fire-and-forget is wrong here: a run whose inputs were never stored
    // replays as a turn that never happened after a restart mid-run.
    const prepared = (async () => {
      await this.threads.ensureThread({
        threadId,
        agentId: agent.agentId ?? null,
      });
      await this.threads.appendMessages(threadId, inputMessages);
    })();
    const events = super.run(request);
    return new Observable<BaseEvent>((observer) => {
      let settled = false;
      // The transcript rebuilt from what actually streamed. `agent.messages`
      // is merged too, but it is not relied on: drivers are not promised to
      // leave finished messages on the agent, while the events are the run.
      const streamed: BaseEvent[] = [];
      const settle = async (failed: boolean) => {
        if (settled) return;
        settled = true;
        try {
          await prepared;
          await this.threads.appendMessages(threadId, [
            ...eventMessages(streamed),
            ...agent.messages,
          ]);
        } catch {
          // Persistence must never fail the turn it records: the answer was
          // produced, and losing it over the ledger is charging twice — once
          // in spend, once in silence.
        }
        void failed;
      };
      const subscription = events.subscribe({
        next: (event) => {
          const stamped = withRunThread(event);
          streamed.push(stamped);
          observer.next(stamped);
        },
        error: (error: unknown) => {
          void settle(true).then(() => observer.error(error));
        },
        complete: () => {
          void settle(false).then(() => observer.complete());
        },
      });
      return () => {
        void settle(false);
        subscription.unsubscribe();
      };
    });
  }

  /*
   * Deliberately not overriding the base's synchronous thread endpoints.
   * They serve this process's live runs from memory; durable reads go
   * through ThreadStore directly (run-turn, handoffs, summaries, and our own
   * routes), and the one handler endpoint the browser reads
   * (`/api/copilotkit/threads/:id/messages`) is shadowed by our own
   * Postgres-backed route registered ahead of the runtime handler.
   */
}
