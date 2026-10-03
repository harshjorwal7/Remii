import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { userComputers } from "../src/db/schema/computer";
import { idleCandidates } from "../src/billing/computer-meter";
import { testDatabase } from "./support/database";

/**
 * The idle sweep must never reclaim a machine that has just been switched on.
 *
 * This exists because the sweep got that wrong, and the symptom it produced was not a bug report about
 * a sweep — it was "the desktop does not work". The sweep read `last_seen_at is null` as idle, that
 * column is never written when a machine is provisioned (only on the NEXT use), so every desktop was
 * reclaimed within a minute of coming up. Remii would start a machine, serve one turn, and find it
 * stopped; start it again; and a person watching that concluded the feature was broken.
 *
 * Every case here is a shape a row can actually be in, because the interesting one is the shape a row
 * is in the SECOND it starts.
 */

let database: Database;
let userId: string;

beforeEach(async () => {
  database = testDatabase();
  const [user] = await database
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      email: `idle-${crypto.randomUUID()}@test.local`,
    })
    .returning({ id: users.id });
  userId = user!.id;
});

afterEach(async () => {
  await database.delete(userComputers).where(eq(userComputers.userId, userId));
  await database.$client.end({ timeout: 5 });
});

const row = async (values: Partial<typeof userComputers.$inferInsert>) =>
  (
    await database
      .insert(userComputers)
      .values({
        id: crypto.randomUUID(),
        userId,
        provider: "e2b",
        sandboxId: `sbx-${crypto.randomUUID()}`,
        status: "RUNNING",
        desiredStatus: "RUNNING",
        ...values,
      })
      .returning()
  )[0]!;

describe("the idle sweep", () => {
  const now = new Date("2026-03-11T12:00:00.000Z");

  test("leaves a machine that was just started alone", async () => {
    /*
     * THE CASE. `last_seen_at` is null here because `touch()` has not run yet — it runs on the next
     * use, not at creation — and reading null as idle is what reclaimed every fresh desktop.
     */
    await row({
      lastStartedAt: new Date(now.getTime() - 5_000),
      lastSeenAt: null,
    });

    expect(await idleCandidates(database, 4, now)).toEqual([]);
  });

  test("leaves a machine that was just created alone", async () => {
    // Same row with nothing stamped at all, which is what a brand new deployment's first row looks
    // like before anything has run against it.
    await row({ lastSeenAt: null, lastStartedAt: null, createdAt: now });

    expect(await idleCandidates(database, 4, now)).toEqual([]);
  });

  test("reclaims a machine nobody has touched for longer than the window", async () => {
    // The behaviour that has to keep working, or nothing is ever reclaimed and the bill grows.
    await row({ lastSeenAt: new Date(now.getTime() - 10 * 60_000) });

    const candidates = await idleCandidates(database, 4, now);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.userId).toBe(userId);
    expect(candidates[0]?.idleSeconds).toBeGreaterThanOrEqual(600);
  });

  test("reclaims a machine that was started long ago and never touched again", async () => {
    // The case the fix must not have broken: `last_seen_at` null, but `last_started_at` old. Judging
    // it from the start time is the whole reason the query coalesces.
    await row({
      lastSeenAt: null,
      lastStartedAt: new Date(now.getTime() - 30 * 60_000),
    });

    expect(await idleCandidates(database, 4, now)).toHaveLength(1);
  });

  test("leaves a machine that is still inside the window alone", async () => {
    await row({ lastSeenAt: new Date(now.getTime() - 60_000) });

    expect(await idleCandidates(database, 4, now)).toEqual([]);
  });

  test("does not touch a machine that is already stopped", async () => {
    // A stopped machine has no reservation to reclaim, and stopping it again would churn the API and
    // rewrite a row that is already correct.
    await row({
      status: "STOPPED",
      lastSeenAt: new Date(now.getTime() - 60 * 60_000),
    });

    expect(await idleCandidates(database, 4, now)).toEqual([]);
  });

  test("does not touch a machine that has no sandbox", async () => {
    await row({
      sandboxId: null,
      lastSeenAt: new Date(now.getTime() - 60 * 60_000),
    });

    expect(await idleCandidates(database, 4, now)).toEqual([]);
  });

  test("reports how idle a machine is, so the caller can log something true", async () => {
    await row({ lastSeenAt: new Date(now.getTime() - 90_000) });

    const [candidate] = await idleCandidates(database, 1, now);
    expect(candidate?.idleSeconds).toBe(90);
  });

  test("ignores another person's machines entirely", async () => {
    // The sweeper runs deployment-wide, so a machine it must not touch has to be excluded by the
    // caller's own scoping rather than by luck. Asserted here because a leak would be a bill nobody
    // can explain.
    await row({ lastSeenAt: new Date(now.getTime() - 60 * 60_000) });
    const candidates = await idleCandidates(database, 4, now);

    expect(candidates.every((c) => c.userId === userId)).toBe(true);
  });
});
