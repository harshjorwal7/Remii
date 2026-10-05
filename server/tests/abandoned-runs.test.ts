import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { runActivity } from "../src/db/schema";
import { users } from "../src/db/schema";
import { threadLocks, threads } from "../src/db/schema/threads";
import { createRunActivityStore } from "../src/activity/store";
import { createThreadLock, createThreadStore } from "../src/threads/local";
import { testDatabase, } from "./support/database";

/**
 * A RUN NOBODY IS RUNNING MUST NOT KEEP SAYING IT IS.
 *
 * A run's activity row is ended by its own settlement, and a settlement only happens if the process
 * survives to make it. A browser closed mid-answer, a pod killed mid-run, a laptop lid shut on a
 * stream — in all of those the run is over and nothing says so. The row stays `thinking`, the
 * channel keeps its pulse, and the line above the composer says "Working" to whoever opens it, for
 * thirty days, because that is the retention default.
 *
 * This was not hypothetical. `ThreadLock.sweepExpired` computed exactly the set of runs to settle and
 * then threw it away with a `void rows` — and had no caller at all, so nothing swept a stale lock
 * either.
 *
 * The grace period is the other half of it: a run whose heartbeat is merely late must NOT be killed,
 * because its lock is still coming back. So the sweep acts only on a lock that has been gone longer
 * than the grace, and a run that renews inside it is left alone.
 */

const database = testDatabase();
const store = createRunActivityStore(database);
const threadStore = createThreadStore(database);
const lock = createThreadLock(database);

const ACTOR = "abandoned-sweep-actor";
const BOT = "general-assistant";
const created: string[] = [];

beforeEach(async () => {
  await database
    .insert(users)
    .values({ id: ACTOR, email: `${ACTOR}-${randomUUID()}@example.test` })
    .onConflictDoNothing();
});

afterEach(async () => {
  for (const id of created.splice(0)) {
    await database.delete(threadLocks).where(eq(threadLocks.runId, id));
    await database.delete(runActivity).where(eq(runActivity.runId, id));
    await database.delete(threads).where(eq(threads.id, id));
  }
  await database
    .delete(users)
    .where(eq(users.id, ACTOR))
    .catch(() => undefined);
});

/** A run that is alive: it holds its lock and the lock is fresh. */
async function liveRun(label: string) {
  const runId = `abandoned-${label}-${randomUUID()}`;
  const threadId = `abandoned-thread-${randomUUID()}`;
  created.push(runId, threadId);
  await threadStore.ensureThread({ threadId, userId: ACTOR, agentId: BOT });
  await store.begin({ runId, actorUserId: ACTOR, botId: BOT, threadId });
  await lock.acquire({ threadId, runId, userId: ACTOR, agentId: BOT });
  return { runId, threadId };
}

/** A run whose lock expired `ms` ago, and is not being renewed. */
async function abandonedRun(label: string, ms: number) {
  const made = await liveRun(label);
  await database
    .update(threadLocks)
    .set({ expiresAt: new Date(Date.now() - ms) })
    .where(eq(threadLocks.runId, made.runId));
  return made;
}

const { sweepAbandonedRuns } = await import("../src/activity/abandoned");

describe("a run that is still being renewed", () => {
  test("is left alone, however long its lock has been gone", async () => {
    // The grace period is the whole reason this sweep is safe to run on a timer: a run between
    // heartbeats has a lock that expired a moment ago, and settling it would kill a live turn.
    const { runId } = await abandonedRun("briefly", 2_000);

    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(result.ended).toEqual([]);
    const row = await store.get(runId);
    expect(row?.state).toBe("thinking");
  });

  test("and is untouched when its lock has not expired at all", async () => {
    const { runId } = await liveRun("fresh");

    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(result.ended).toEqual([]);
    expect((await store.get(runId))?.state).toBe("thinking");
  });
});

describe("a run nobody is running", () => {
  test("is stopped, so the roster stops saying it is working", async () => {
    const { runId } = await abandonedRun("gone", 10 * 60_000);

    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(result.ended).toHaveLength(1);
    expect(result.ended[0]?.runId).toBe(runId);
    const row = await store.get(runId);
    expect(row?.state).toBe("stopped");
    expect(row?.endedAt).not.toBeNull();
    // And it says WHY, because a channel that stopped working on its own deserves to be told it was
    // not a decision anybody made.
    expect(row?.detail).toContain("connection was closed");
  });

  test("releases the stale lock, so the next run on that thread is not told to wait", async () => {
    // THE OTHER HALF, and the reason this is a sweep rather than a repair: a lock nobody releases
    // blocks the thread it is on until something steals it, and nothing stole it because the sweep
    // that would have cleaned it had no caller.
    const { runId, threadId } = await abandonedRun("stale-lock", 10 * 60_000);

    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(result.locksReleased).toBe(1);
    const locks = await database
      .select()
      .from(threadLocks)
      .where(eq(threadLocks.threadId, threadId));
    expect(locks).toHaveLength(0);
    // And the thread is usable again.
    const held = await lock.acquire({
      threadId,
      runId: `next-${runId}`,
      userId: ACTOR,
      agentId: BOT,
    });
    expect(held).toBeTruthy();
  });

  test("does not overwrite a run that had already ended", async () => {
    // A run that finished normally keeps the record it earned. A periodic sweeper that could rewrite
    // it would be more dangerous than the bug: it runs on a timer, forever, beside a live server.
    const { runId } = await abandonedRun("already-done", 10 * 60_000);
    await store.transition(runId, "failed", { detail: "the model refused" });

    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(result.ended).toEqual([]);
    const row = await store.get(runId);
    expect(row?.state).toBe("failed");
    expect(row?.detail).toBe("the model refused");
  });

  test("leaves a delegation's child alone while its parent is still going", async () => {
    // A hop's lock is held on ITS OWN thread while the asking run waits, so both can be swept
    // independently — and only a run that is itself unrenewed is touched.
    const child = await abandonedRun("child", 10 * 60_000);
    await store.transition(child.runId, "delegated", { label: "With Coco" });

    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(result.ended.map((row) => row.runId)).toEqual([child.runId]);
    expect((await store.get(child.runId))?.state).toBe("stopped");
  });
});
