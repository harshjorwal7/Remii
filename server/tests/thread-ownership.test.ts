import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { users } from "../src/db/schema";
import { threads } from "../src/db/schema/threads";
import { createThreadStore } from "../src/threads/local";
import { testDatabase } from "./support/database";

/**
 * A THREAD WITH NO OWNER IS A CONVERSATION NOBODY CAN READ.
 *
 * The transcript route answers `/api/copilotkit/threads/:id/messages` by joining `threads` and
 * requiring `threads.userId = <the person asking>`. That is the right check — it is what stops one
 * person reading another's conversation — and it makes `threads.userId` load-bearing for whether a
 * chat renders at all.
 *
 * EVERY WRITER OF THAT COLUMN USED `onConflictDoNothing`, so a thread that existed without an owner
 * could never be given one. Two live channels had exactly that: rows in the roster, 33 messages
 * between them, and an empty screen. A thread reaches that state whenever `ensureThread` sees it
 * first — which is what a run touching a thread does — because that path knows the run and not the
 * person.
 *
 * So both writers are fixed to fill a missing owner in and to leave a present one alone, and these
 * are the cases that failed.
 */

const database = testDatabase();
const store = createThreadStore(database);
const created: string[] = [];

const OWNER = "thread-owner-user";
const OTHER = "thread-other-user";

beforeEach(async () => {
  for (const id of [OWNER, OTHER]) {
    await database
      .insert(users)
      .values({ id, email: `${id}-${randomUUID()}@example.test` })
      .onConflictDoNothing();
  }
});

afterEach(async () => {
  for (const id of created.splice(0)) {
    await database.delete(threads).where(eq(threads.id, id));
  }
  await database
    .delete(users)
    .where(eq(users.id, OWNER))
    .catch(() => undefined);
  await database
    .delete(users)
    .where(eq(users.id, OTHER))
    .catch(() => undefined);
});

async function read(threadId: string, actorId: string) {
  const rows = await database
    .select({ userId: threads.userId })
    .from(threads)
    .where(eq(threads.id, threadId));
  // The route's own condition, in one line.
  return rows.filter((row) => row.userId === actorId).length > 0;
}

describe("a thread created before anybody claimed it", () => {
  test("is given its owner by the next caller who knows one", async () => {
    // A run touches the thread first. It knows the run and not the person, so the row lands with no
    // owner — which is exactly the state the two live channels were in.
    const threadId = `owned-later-${randomUUID()}`;
    created.push(threadId);
    await store.ensureThread({ threadId, agentId: "agent-x" });
    expect(await read(threadId, OWNER)).toBe(false);

    // Somebody who DOES know the owner names the same thread.
    await store.ensureThread({ threadId, userId: OWNER });
    expect(await read(threadId, OWNER)).toBe(true);
  });

  test("is given its agent by the next caller who knows one", async () => {
    const threadId = `agent-later-${randomUUID()}`;
    created.push(threadId);
    await store.ensureThread({ threadId, userId: OWNER });
    await store.ensureThread({ threadId, agentId: "agent-y" });

    const [row] = await database
      .select({ agentId: threads.agentId })
      .from(threads)
      .where(eq(threads.id, threadId));
    expect(row?.agentId).toBe("agent-y");
  });
});

describe("a thread that already has an owner", () => {
  test("keeps it, because a later caller must not be able to take the conversation", async () => {
    // The common case is an unrelated run naming the same thread. If the second `ensureThread` could
    // set the owner, any run anywhere could move a conversation to whoever happened to be asking.
    const threadId = `keeps-owner-${randomUUID()}`;
    created.push(threadId);
    await store.ensureThread({ threadId, userId: OWNER, agentId: "agent-x" });
    await store.ensureThread({ threadId, userId: OTHER, agentId: "agent-y" });

    expect(await read(threadId, OWNER)).toBe(true);
    expect(await read(threadId, OTHER)).toBe(false);
    const [row] = await database
      .select({ agentId: threads.agentId })
      .from(threads)
      .where(eq(threads.id, threadId));
    expect(row?.agentId).toBe("agent-x");
  });

  test("keeps it when the later caller knows no owner at all", async () => {
    // The common case, precisely: a hop's `ensureThread` names a thread and no person.
    const threadId = `keeps-owner-2-${randomUUID()}`;
    created.push(threadId);
    await store.ensureThread({ threadId, userId: OWNER });
    await store.ensureThread({ threadId, agentId: "agent-z" });

    expect(await read(threadId, OWNER)).toBe(true);
  });
});
