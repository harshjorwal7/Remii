import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createRunActivityStore } from "../src/activity/store";
import { runActivity, users } from "../src/db/schema";
import { threadLocks, threads } from "../src/db/schema/threads";
import { createThreadLock, createThreadStore } from "../src/threads/local";
import { testDatabase } from "./support/database";

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

/*
 * Every assertion below is ABOUT ONE RUN, never about the whole result.
 *
 * `sweepAbandonedRuns` is global by design — it has no actor to scope by, because a ghost is a ghost
 * whoever it belongs to — so `result.ended` is every abandoned run in the database, including rows
 * left behind by other files in this suite, which share one test database and do not all clean up.
 *
 * Asserting the array is empty therefore tested the state of the whole suite rather than the
 * behaviour of the function, and it passed only because nothing else in the database happened to be a
 * candidate. It stopped passing the moment the heartbeat signal was added, because leftover rows from
 * other files became legitimately reapable — which is the sweep working, not a regression.
 *
 * So each test asks the only question it means to ask: was THIS run ended?
 */
const endedIds = (result: { ended: { runId: string }[] }) =>
  result.ended.map((row) => row.runId);

describe("a run that is still being renewed", () => {
  test("is left alone, however long its lock has been gone", async () => {
    // The grace period is the whole reason this sweep is safe to run on a timer: a run between
    // heartbeats has a lock that expired a moment ago, and settling it would kill a live turn.
    const { runId } = await abandonedRun("briefly", 2_000);

    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(endedIds(result)).not.toContain(runId);
    const row = await store.get(runId);
    expect(row?.state).toBe("thinking");
  });

  test("and is untouched when its lock has not expired at all", async () => {
    const { runId } = await liveRun("fresh");

    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(endedIds(result)).not.toContain(runId);
    expect((await store.get(runId))?.state).toBe("thinking");
  });
});

describe("a run nobody is running", () => {
  test("is stopped, so the roster stops saying it is working", async () => {
    const { runId } = await abandonedRun("gone", 10 * 60_000);

    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(endedIds(result)).toContain(runId);
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

    await sweepAbandonedRuns(database, { graceMs: 60_000 });

    // Asserted on the row rather than on `locksReleased`, which is a count across the whole database
    // and so says nothing about this thread in particular.
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

    expect(endedIds(result)).not.toContain(runId);
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

    expect(endedIds(result)).toContain(child.runId);
    expect((await store.get(child.runId))?.state).toBe("stopped");
  });
});

/**
 * THE RUNS THE LOCK COULD NOT SEE.
 *
 * Every case above is a hop, and a hop proves it is alive by renewing a `thread_locks` row. A person's
 * own chat run takes no lock at all — it runs through the runtime — so for the runs somebody actually
 * watches there was no signal here to read, and a chat whose process was killed held its channel's
 * working pulse for the full retention window. Because `thinking` outranks every terminal state in
 * `ACTIVITY_SEVERITY`, that dead row went on winning the roster reduction: a channel pinned open by
 * work that ended days ago, which no amount of waiting could clear.
 *
 * These are the tests for the second signal. The rule is unchanged underneath — a run is ended only
 * once something has said it is going and then stopped saying so for longer than the grace period —
 * and the guarantee that a live run is never touched is the one worth defending hardest, because it
 * is what a wrong answer here costs.
 */
describe("a chat run, which takes no lock at all", () => {
  /** A run recorded and beating, with no lock row anywhere — the shape a chat run has. */
  async function chatRun(label: string) {
    const runId = `abandoned-chat-${label}-${randomUUID()}`;
    const threadId = `abandoned-chat-thread-${randomUUID()}`;
    created.push(runId, threadId);
    await threadStore.ensureThread({ threadId, userId: ACTOR, agentId: BOT });
    await store.begin({ runId, actorUserId: ACTOR, botId: BOT, threadId });
    return { runId, threadId };
  }

  test("is given a beat with its row, so it is sweepable from the moment it exists", async () => {
    /*
     * WITHOUT THIS, EVERYTHING BELOW IS UNREACHABLE.
     *
     * A row whose beat is null is excluded from the sweep by `last_heartbeat_at is not null`, so a
     * run that begins and is never heard from again would be invisible to it forever. The first beat
     * travels with the row for exactly that reason, and this is the assertion that says so.
     */
    const { runId } = await chatRun("first-beat");

    const row = await store.get(runId);
    expect(row?.lastHeartbeatAt).not.toBeNull();
  });

  test("is stopped once its beat has lapsed, so the roster stops saying it is working", async () => {
    const { runId } = await chatRun("gone");
    // No lock row exists for this run, and none is needed: the beat is the signal.
    const locks = await database
      .select()
      .from(threadLocks)
      .where(eq(threadLocks.runId, runId));
    expect(locks).toHaveLength(0);

    // The run said it was going, and then stopped saying so ten minutes ago.
    await database
      .update(runActivity)
      .set({ lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(runActivity.runId, runId));

    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(endedIds(result)).toContain(runId);
    const row = await store.get(runId);
    expect(row?.state).toBe("stopped");
    expect(row?.endedAt).not.toBeNull();
    expect(row?.detail).toContain("connection was closed");
  });

  test("is left alone while its beat is still fresh", async () => {
    /*
     * THE ONE THAT MATTERS MOST.
     *
     * This is the guarantee the lock path has always had and the reason the grace period exists: a run
     * that is between beats has not died, and settling it would kill a live turn. Here the run is
     * not even a second into an interval — it has only just begun — and the sweep must walk past it.
     */
    const { runId } = await chatRun("beating");

    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(endedIds(result)).not.toContain(runId);
    expect((await store.get(runId))?.state).toBe("thinking");
  });

  test("is left alone while its beat is only a little late", async () => {
    // The grace period doing its actual job, on the signal that replaced the lock: a beat that is
    // merely behind is a run that will beat again, not one that has stopped.
    const { runId } = await chatRun("late");
    await database
      .update(runActivity)
      .set({ lastHeartbeatAt: new Date(Date.now() - 2_000) })
      .where(eq(runActivity.runId, runId));

    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(endedIds(result)).not.toContain(runId);
    expect((await store.get(runId))?.state).toBe("thinking");
  });

  test("a beat keeps a live run out of the way, however long the run has been going", async () => {
    /*
     * THE CASE THAT WOULD KILL A RUN IF THE INTERVALS WERE WRONG.
     *
     * A long turn — a slow tool call, a model that is taking its time — is still beating throughout.
     * What matters is not how old the RUN is but how old the last beat is, so this run is given a
     * start time well past any plausible turn and a beat from moments ago, and must survive. A sweep
     * that keyed on `started_at` would end it and report a channel as disconnected while it worked.
     */
    const { runId } = await chatRun("long-but-alive");
    await database
      .update(runActivity)
      .set({
        startedAt: new Date(Date.now() - 6 * 60 * 60_000),
        lastHeartbeatAt: new Date(),
      })
      .where(eq(runActivity.runId, runId));

    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(endedIds(result)).not.toContain(runId);
    expect((await store.get(runId))?.state).toBe("thinking");
  });

  test("cannot be revived by a beat that arrives after the sweep ended it", async () => {
    /*
     * A HEARTBEAT MUST NOT BE ABLE TO UN-END A RUN.
     *
     * The beat is guarded on `ended_at is null` and says so by returning false, which is what lets the
     * timer stop instead of writing for ever to a row nobody reads. Without the guard, a beat racing a
     * settled run would report a finished conversation as working again — the same class of lie as the
     * ghost, and worse because it would keep returning.
     */
    const { runId } = await chatRun("finished-then-beat");
    await database
      .update(runActivity)
      .set({ lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(runActivity.runId, runId));
    await sweepAbandonedRuns(database, { graceMs: 60_000 });
    expect((await store.get(runId))?.state).toBe("stopped");

    const stillOpen = await store.heartbeat(runId);

    expect(stillOpen).toBe(false);
    const row = await store.get(runId);
    expect(row?.state).toBe("stopped");
    expect(row?.endedAt).not.toBeNull();
  });

  test("a beat on a live run says so, so the timer can stop on its own", async () => {
    const { runId } = await chatRun("still-open");

    const beat = await store.heartbeat(runId);

    expect(beat).toBe(true);
    expect((await store.get(runId))?.lastHeartbeatAt).not.toBeNull();
  });

  test("a beat pushes the signal forward rather than only moving a timestamp", async () => {
    // Asserted as movement, because a beat that wrote the same value would pass a bare
    // `not.toBeNull()` forever while the sweeper went on reading a lapsed run.
    const { runId } = await chatRun("advances");
    await database
      .update(runActivity)
      .set({ lastHeartbeatAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(runActivity.runId, runId));
    const before = await store.get(runId);

    await store.heartbeat(runId);
    const after = await store.get(runId);

    expect(after!.lastHeartbeatAt!.getTime()).toBeGreaterThan(
      before!.lastHeartbeatAt!.getTime(),
    );
    // And the run survives a sweep on the strength of it.
    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });
    expect(endedIds(result)).not.toContain(runId);
  });

  test("a run that never beat is left to the finish, not guessed at by the sweep", async () => {
    /*
     * THE CONTRACT, ASSERTED DIRECTLY.
     *
     * Absence of a heartbeat is not evidence of death: it is the same absence that describes a run
     * between beats, and a sweep that reads it as death kills live turns. So a null beat is excluded
     * rather than treated as infinitely old — the sweeper ends runs it has evidence about, and the
     * finish path ends the ones whose cleanup was simply dropped.
     */
    const { runId } = await chatRun("never-beat");
    await database
      .update(runActivity)
      .set({ lastHeartbeatAt: null })
      .where(eq(runActivity.runId, runId));

    const result = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(endedIds(result)).not.toContain(runId);
    expect((await store.get(runId))?.state).toBe("thinking");
  });
});
