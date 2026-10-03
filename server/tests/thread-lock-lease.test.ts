import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { runActivity, users } from "../src/db/schema";
import { threadLocks } from "../src/db/schema/threads";
import { workItems } from "../src/db/schema/work";
import { createThreadLock, ThreadLockDenied } from "../src/threads/local";
import { createWorkQueue } from "../src/work/queue";
import { sweepAbandonedRuns } from "../src/activity/abandoned";
import { TEST_POOL, testDatabase, testDatabaseUrl } from "./support/database";

/**
 * A LOCK IS A LEASE, AND A LEASE HAS TWO ENDS.
 *
 * The thread lock exists so that two turns never write to one conversation at once, and it was
 * wrong at both ends of that promise:
 *
 *   - `acquire` read the row and then wrote it, in two statements with nothing between them. Two
 *     replicas taking the same conversation in the same instant both read "free", both wrote, and
 *     the second silently replaced the first's `run_id` — so both were told they held the thread and
 *     both appended a turn to it. Neither replica can see the other's success, which is what makes
 *     this the worst shape a lock can have: it fails while looking healthy on both sides.
 *   - `renew` accepted a `runId` and never used it. A holder that had lost its lease to another run
 *     kept heartbeating, pushed the NEW holder's expiry forward, and was told it had succeeded — so
 *     the run that had been locked out went on streaming into the thread, and kept the thread locked
 *     after the run that actually held it had finished.
 *
 * The abandoned sweep had the matching gap: it drew its candidates only from `thread_locks`, and a
 * chat run typed by a person never takes a lock row at all. A chat whose process died therefore left
 * a `thinking` row with no `ended_at` that nothing would ever move — a permanent ghost that kept
 * scoring the channel's activity indicator, so a live run in that conversation could never win the
 * dot, and retention (which only deletes settled rows) never removed it either.
 */

/*
 * ONE POOL PER FILE IS A NEW LIMIT ON THE WHOLE SUITE.
 *
 * `TEST_POOL` is two connections per database, and Postgres allows 100 for this deployment. The
 * suite opens one of these per test file, so the two files added here were enough to push a full
 * run over the limit: the failures that followed were `too many clients already` in files that
 * have nothing to do with locks, which is the worst possible way for a test to fail — it looks like
 * a product bug and is an accounting one.
 *
 * So the connections are handed back when the file is done, which is what `close()` is for and what
 * no other file needed to do before this one existed.
 */
const database = testDatabase();
afterAll(async () => {
  await database.$client.close();
});
const lock = createThreadLock(database);
const queue = createWorkQueue(database);

const threadIds: string[] = [];
const threadId = () => {
  const id = `lock-${randomUUID()}`;
  threadIds.push(id);
  return id;
};

/**
 * `run_activity.actor_user_id` is a foreign key, so the rows these tests need have to belong to a
 * person who exists. Two are enough and they are the only actors involved.
 */
const ACTORS = ["actor-chat", "actor-hop"];

beforeEach(async () => {
  await database.delete(threadLocks);
  await database.delete(runActivity);
  // A work item's key is its identity, so a row left by an earlier run would collide with this
  // offer and leave nothing to claim.
  await database.delete(workItems);
  for (const id of ACTORS) {
    await database
      .insert(users)
      .values({ id, email: `${id}-${randomUUID()}@example.test` })
      .onConflictDoNothing();
  }
});

afterEach(async () => {
  for (const id of threadIds) {
    await database.delete(threadLocks).where(eq(threadLocks.threadId, id));
  }
  await database.delete(threadLocks);
});

describe("the thread lock is one holder at a time", () => {
  test("two acquisitions racing for one thread: exactly one wins", async () => {
    const id = threadId();
    const results = await Promise.allSettled([
      lock.acquire({ threadId: id, runId: "run-a", ttlSeconds: 120 }),
      lock.acquire({ threadId: id, runId: "run-b", ttlSeconds: 120 }),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");

    /*
     * The property, not the count of one path. A read-then-write lock loses this race about half the
     * time, so a single pass can pass by luck; the assertion is that the two outcomes are exclusive
     * and that the database agrees with whoever was told they won.
     */
    expect(won.length).toBe(1);
    expect(lost.length).toBe(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ThreadLockDenied,
    );

    const [row] = await database
      .select({ runId: threadLocks.runId })
      .from(threadLocks)
      .where(eq(threadLocks.threadId, id));
    expect(row?.runId).toBe(
      (won[0] as PromiseFulfilledResult<{ runId: string }>).value.runId,
    );
  });

  test("an expired lease may be taken over", async () => {
    const id = threadId();
    await lock.acquire({ threadId: id, runId: "run-a", ttlSeconds: 120 });
    // Force the lease into the past rather than waiting out a TTL.
    await database
      .update(threadLocks)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(threadLocks.threadId, id));

    await expect(
      lock.acquire({ threadId: id, runId: "run-b", ttlSeconds: 120 }),
    ).resolves.toEqual({
      runId: "run-b",
    });
  });

  test("a live lease may not be taken over", async () => {
    const id = threadId();
    await lock.acquire({ threadId: id, runId: "run-a", ttlSeconds: 120 });
    await expect(
      lock.acquire({ threadId: id, runId: "run-b", ttlSeconds: 120 }),
    ).rejects.toBeInstanceOf(ThreadLockDenied);
  });
});

describe("a renewal belongs to the run that holds the lock", () => {
  test("renewing under a run that does not hold the lock reports that it does not", async () => {
    const id = threadId();
    await lock.acquire({ threadId: id, runId: "run-a", ttlSeconds: 120 });

    /*
     * The whole defect in one call. Before, this returned `void` and pushed `run-b`'s — which is to
     * say `run-a`'s, the current holder's — expiry forward while reporting success, so the loser of
     * the race could not tell it had lost.
     */
    await expect(
      lock.renew({ threadId: id, runId: "run-b", ttlSeconds: 120 }),
    ).resolves.toBe(false);
  });

  test("the holder's own renewal succeeds and extends the lease", async () => {
    const id = threadId();
    await lock.acquire({ threadId: id, runId: "run-a", ttlSeconds: 60 });
    const [before] = await database
      .select({ expiresAt: threadLocks.expiresAt })
      .from(threadLocks)
      .where(eq(threadLocks.threadId, id));

    await expect(
      lock.renew({ threadId: id, runId: "run-a", ttlSeconds: 600 }),
    ).resolves.toBe(true);

    const [after] = await database
      .select({ expiresAt: threadLocks.expiresAt })
      .from(threadLocks)
      .where(eq(threadLocks.threadId, id));
    expect(after!.expiresAt.getTime()).toBeGreaterThan(
      before!.expiresAt.getTime(),
    );
  });
});

describe("a queue claim that has run out is nobody's to execute", () => {
  test("a lapsed lease is not renewed as live, even with no rival", async () => {
    const key = `audit-key-${randomUUID()}`;
    await queue.offer({ kind: "audit-kind", key });
    const claimed = await queue.claim({
      kind: "audit-kind",
      owner: "replica-1",
      limit: 1,
      leaseMs: 60_000,
    });
    expect(claimed).toHaveLength(1);

    // Nobody else claims it. The row still says `replica-1`, which is the trap.
    await database
      .update(workItems)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(workItems.key, key));

    /*
     * `live` is the flag the handoff runner now passes before spending a model call. Without it this
     * returns true for a claim that has expired, and the runner starts a second delivery of a hop
     * that a paused replica is about to wake up and deliver as well.
     */
    await expect(
      queue.renew({
        kind: "audit-kind",
        key,
        owner: "replica-1",
        leaseMs: 60_000,
        live: true,
      }),
    ).resolves.toBe(false);

    // The lenient form still answers the question `finish` and `release` need to ask.
    await expect(
      queue.renew({
        kind: "audit-kind",
        key,
        owner: "replica-1",
        leaseMs: 60_000,
      }),
    ).resolves.toBe(true);
  });
});

describe("a run with no lock row is not this sweeper's business", () => {
  /*
   * A CHAT RUN LEAVES A GHOST, AND THAT IS A KNOWN LIMITATION RATHER THAN A FIXED BUG.
   *
   * A chat run takes no `thread_locks` row, so a chat whose process was killed leaves an activity
   * row `thinking` with no `ended_at` that nothing moves: it keeps scoring the channel's activity
   * indicator, and retention only deletes SETTLED rows so it survives that too.
   *
   * The obvious fix — "an open row with no lock is a dead run" — is wrong, and this test is the
   * reason it was reverted. Absence of a heartbeat is not evidence that a run stopped; it is the
   * same absence that describes a run BETWEEN renewals. Reading it as death kills live turns, which
   * is a far worse failure than a stuck indicator, and `abandoned-runs.test.ts` already asserts the
   * guarantee in the other direction.
   *
   * So the sweeper stays on locks, and this says plainly what that costs. If chat runs are given a
   * heartbeat later, the candidate source here is where it goes — and this test is the one that
   * should change with it.
   */
  test("a chat run that died is NOT swept, and that is the documented gap", async () => {
    const runId = `chat-${randomUUID()}`;
    await database.insert(runActivity).values({
      runId,
      actorUserId: "actor-chat",
      botId: "general-assistant",
      threadId: threadId(),
      state: "thinking",
      startedAt: new Date(Date.now() - 10 * 60_000),
    });

    const swept = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    // Asserting the CURRENT behaviour, so the gap is visible in the suite rather than only here.
    expect(swept.ended.map((row) => row.runId)).not.toContain(runId);
    const [row] = await database
      .select({ state: runActivity.state })
      .from(runActivity)
      .where(eq(runActivity.runId, runId));
    expect(row?.state).toBe("thinking");
  });

  test("a hop somebody holds a live lock for is not stopped either", async () => {
    const runId = `hop-${randomUUID()}`;
    await database.insert(runActivity).values({
      runId,
      actorUserId: "actor-hop",
      botId: "general-assistant",
      threadId: threadId(),
      state: "thinking",
      startedAt: new Date(Date.now() - 10 * 60_000),
    });
    await database.insert(threadLocks).values({
      threadId: `lock-thread-${runId}`,
      runId,
      expiresAt: new Date(Date.now() + 120_000),
    });

    const swept = await sweepAbandonedRuns(database, { graceMs: 60_000 });

    expect(swept.ended.map((row) => row.runId)).not.toContain(runId);
    const [row] = await database
      .select({ state: runActivity.state })
      .from(runActivity)
      .where(eq(runActivity.runId, runId));
    expect(row?.state).toBe("thinking");
  });
});
