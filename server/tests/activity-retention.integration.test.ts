import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sweepRunActivity } from "../src/activity-retention";
import { runActivity, users } from "../src/db/schema";
import { testDatabase, testDatabaseUrl } from "./support/database";

/**
 * `run_activity` has to be able to stop growing.
 *
 * Bounded by default where the audit trail beside it is not, because the two tables answer different
 * questions: an incident is looked up in the audit trail long after it happened, and a person asks
 * `run_activity` what is working while they are looking at the roster. The finished rows past that
 * horizon are the cost of the question nobody is asking.
 *
 * Against a real database because the whole thing is SQL: the advisory lock that decides which server
 * sweeps, the batching, and the interval arithmetic. The predicate is the interesting part, and a
 * mocked delete would have asserted the thing I wrote rather than the thing I meant.
 */

const databaseUrl = testDatabaseUrl();
const database = testDatabase();

const MARKER = "activity-retention-test";
const createdUserIds: string[] = [];
const createdRunIds: string[] = [];

async function seedUser(): Promise<string> {
  const [user] = await database
    .insert(users)
    .values({
      id: `activity-retention-${Math.random().toString(36).slice(2)}`,
      email: `${MARKER}-${Math.random().toString(36).slice(2)}@example.test`,
      emailVerified: true,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("could not seed a user");
  createdUserIds.push(user.id);
  return user.id;
}

async function seedRun(
  actorUserId: string,
  options: { daysAgo: number; ended: boolean },
): Promise<string> {
  const runId = `${MARKER}-${Math.random().toString(36).slice(2)}`;
  await database.insert(runActivity).values({
    runId,
    actorUserId,
    botId: "general-assistant",
    threadId: `${runId}-thread`,
    state: options.ended ? "done" : "thinking",
    startedAt: new Date(Date.now() - options.daysAgo * 86_400_000),
    endedAt: options.ended
      ? new Date(Date.now() - options.daysAgo * 86_400_000 + 1_000)
      : null,
  });
  createdRunIds.push(runId);
  return runId;
}

async function stillPresent(runId: string): Promise<boolean> {
  const [row] = await database
    .select({ runId: runActivity.runId })
    .from(runActivity)
    .where(eq(runActivity.runId, runId));
  return row !== undefined;
}

afterEach(async () => {
  for (const runId of createdRunIds.splice(0)) {
    await database.delete(runActivity).where(eq(runActivity.runId, runId));
  }
  for (const id of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});

describe("the run activity sweep", () => {
  test("removes finished runs past the window", async () => {
    const actorUserId = await seedUser();
    const old = await seedRun(actorUserId, { daysAgo: 90, ended: true });
    const recent = await seedRun(actorUserId, { daysAgo: 2, ended: true });

    const result = await sweepRunActivity(databaseUrl, 30);

    expect(result.deleted).toBeGreaterThan(0);
    expect(await stillPresent(old)).toBe(false);
    expect(await stillPresent(recent)).toBe(true);
  });

  /*
   * The one that would have been easiest to get wrong. A run with no `ended_at` IS the answer to
   * "what is working right now", so a sweep that ignored the predicate would make a working Bot look
   * idle — on a clock, with no way for a reader to tell quiet from swept.
   */
  test("never removes a run that has not ended, however old", async () => {
    const actorUserId = await seedUser();
    // Older than the window by a wide margin, which is the only interesting way to be unfinished.
    const running = await seedRun(actorUserId, { daysAgo: 400, ended: false });

    await sweepRunActivity(databaseUrl, 30);

    expect(await stillPresent(running)).toBe(true);
  });

  test("refuses rather than sweeping everything on a bad window", async () => {
    const actorUserId = await seedUser();
    const old = await seedRun(actorUserId, { daysAgo: 90, ended: true });

    // 0 is the config's "keep everything", and a negative is a mistake. Neither may be read as
    // "delete all rows older than now", which is what a zero interval would mean.
    for (const days of [0, -1, 1.5, Number.NaN]) {
      const result = await sweepRunActivity(databaseUrl, days);
      expect(result.deleted).toBeNull();
    }
    expect(await stillPresent(old)).toBe(true);
  });

  test("reports nothing when another replica holds the lock", async () => {
    const actorUserId = await seedUser();
    const old = await seedRun(actorUserId, { daysAgo: 90, ended: true });

    // A second connection taking the same advisory lock is what several replicas look like.
    const other = (await import("postgres")).default(databaseUrl, { max: 1 });
    try {
      await other`select pg_advisory_lock(827164051)`;
      const result = await sweepRunActivity(databaseUrl, 30);
      expect(result.deleted).toBeNull();
    } finally {
      await other.end({ timeout: 5 }).catch(() => undefined);
    }
    expect(await stillPresent(old)).toBe(true);
  });

  test("deletes in batches, so a large table stays writable", async () => {
    // The claim is about the shape of the delete rather than its count: a single unbounded
    // `delete ... where` takes a lock the roster's read waits behind, and this asserts the batching
    // is what runs by checking a table with more rows than one batch still clears.
    const actorUserId = await seedUser();
    const rows = Array.from({ length: 12 }, () =>
      seedRun(actorUserId, { daysAgo: 90, ended: true }),
    );
    await Promise.all(rows);

    const result = await sweepRunActivity(databaseUrl, 30);

    expect(result.deleted).toBeGreaterThanOrEqual(12);
    const [left] = await database
      .select({ count: runActivity.runId })
      .from(runActivity)
      .where(eq(runActivity.actorUserId, actorUserId));
    expect(left).toBeUndefined();
  });
});
