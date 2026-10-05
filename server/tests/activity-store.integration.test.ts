import { afterEach, describe, expect, it, test } from "bun:test";
import { eq } from "drizzle-orm";
import { activityKey, createRunActivityStore } from "../src/activity/store";
import { runActivity, users } from "../src/db/schema";
import { testDatabase, } from "./support/database";

/**
 * One row per run, and what that forces.
 *
 * The obvious shape for this table is a log — a row per state change, which is what "activity" sounds
 * like. It is the wrong shape: a ten-tool audit becomes ten rows, the question the table exists to
 * answer ("what is working") becomes a fold over transitions rather than a scan, and the table grows
 * with the work rather than with the work's outcomes. So every test here is about the consequences
 * of it being one row per run instead.
 */
const database = testDatabase();
const store = createRunActivityStore(database);

const createdUserIds: string[] = [];
const createdRunIds: string[] = [];

async function seedUser(): Promise<string> {
  const [user] = await database
    .insert(users)
    .values({
      id: `activity-store-${Math.random().toString(36).slice(2)}`,
      email: `activity-store-${Math.random().toString(36).slice(2)}@example.test`,
      emailVerified: true,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("could not seed a user");
  createdUserIds.push(user.id);
  return user.id;
}

async function begin(
  actorUserId: string,
  overrides: Partial<Parameters<typeof store.begin>[0]> = {},
) {
  const runId = overrides.runId ?? `run-${Math.random().toString(36).slice(2)}`;
  createdRunIds.push(runId);
  return store.begin({
    runId,
    actorUserId,
    botId: "general-assistant",
    threadId: `${runId}-thread`,
    ...overrides,
  });
}

afterEach(async () => {
  for (const runId of createdRunIds.splice(0)) {
    await database.delete(runActivity).where(eq(runActivity.runId, runId));
  }
  for (const id of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});

describe("a run's record", () => {
  test("starts as thinking, with no end", async () => {
    const actorUserId = await seedUser();
    const row = await begin(actorUserId);

    expect(row.state).toBe("thinking");
    expect(row.endedAt).toBeNull();
    expect(row.transitions).toBe(0);
  });

  test("a scratch-thread run has no channel, and that is allowed", async () => {
    /*
     * Nullable on purpose. A hop runs in a thread with no conversation of its own, so a column that
     * demanded one would either refuse the row — losing the run a person is actually waiting on — or
     * lie about where the work is happening.
     */
    const actorUserId = await seedUser();
    const row = await begin(actorUserId, { channelId: null });

    expect(row.channelId).toBeNull();
    expect((await store.get(row.runId))?.channelId).toBeNull();
  });

  test("seeing a run twice keeps the moment it began", async () => {
    /*
     * A hop is delivered from a work queue, so the run that starts it was written by another
     * request, quite possibly on another server. The second sighting is this server learning about
     * the run, not the run restarting, and overwriting `startedAt` would make every elapsed time
     * this table is read for wrong.
     */
    const actorUserId = await seedUser();
    const first = await begin(actorUserId, { runId: "activity-store-twice" });
    createdRunIds.push("activity-store-twice");

    await new Promise((resolve) => setTimeout(resolve, 15));
    const again = await store.begin({
      runId: first.runId,
      actorUserId,
      botId: first.botId,
      threadId: first.threadId,
      channelId: "channel-1",
    });

    expect(again.startedAt.getTime()).toBe(first.startedAt.getTime());
    // And the later sighting may add what it learned, without losing what it did not know.
    expect(again.channelId).toBe("channel-1");
  });

  test("a second sighting never moves a run that has already ended", async () => {
    const actorUserId = await seedUser();
    const first = await begin(actorUserId, { runId: "activity-store-ended" });
    createdRunIds.push("activity-store-ended");
    await store.transition(first.runId, "done");

    const again = await store.begin({
      runId: first.runId,
      actorUserId,
      botId: first.botId,
      threadId: first.threadId,
    });

    expect(again.state).toBe("done");
    expect(again.endedAt).not.toBeNull();
  });
});

describe("moving a run between states", () => {
  test("counts the moves, so a loop is visible as one", async () => {
    const actorUserId = await seedUser();
    const row = await begin(actorUserId);
    await store.transition(row.runId, "thinking", { detail: "one" });
    await store.transition(row.runId, "thinking", { detail: "two" });
    const after = await store.transition(row.runId, "done");

    // Three rows in a log; one row here, and a count that says it moved.
    expect(after?.transitions).toBe(3);
    const all = await database.select().from(runActivity);
    expect(all.filter((r) => r.runId === row.runId)).toHaveLength(1);
  });

  test.each(["done", "stopped", "failed"] as const)(
    "%s ends the run",
    async (state) => {
      const actorUserId = await seedUser();
      const row = await begin(actorUserId);
      const after = await store.transition(row.runId, state);

      expect(after?.endedAt).not.toBeNull();
      expect((await store.open(actorUserId)).map((r) => r.runId)).not.toContain(
        row.runId,
      );
    },
  );

  test.each(["thinking", "delegated", "waiting_on_you"] as const)(
    "%s does not end the run",
    async (state) => {
      const actorUserId = await seedUser();
      const row = await begin(actorUserId);
      const after = await store.transition(row.runId, state);

      expect(after?.endedAt).toBeNull();
      expect((await store.open(actorUserId)).map((r) => r.runId)).toContain(
        row.runId,
      );
    },
  );

  test("clears the label of the state it left", async () => {
    /*
     * The pairs are mutually exclusive, so a stale one is a lie: a run that resolved out of
     * `waiting_on_you` must stop saying what it was waiting for, and a `failed` run must not keep a
     * previous `done` run's clean record.
     */
    const actorUserId = await seedUser();
    const row = await begin(actorUserId);
    await store.transition(row.runId, "waiting_on_you", {
      label: "Needs a secret",
    });
    const back = await store.transition(row.runId, "thinking", { label: null });

    expect(back?.label).toBeNull();
  });

  test("a run that was never recorded reports nothing rather than inventing one", async () => {
    expect(await store.transition("no-such-run", "done")).toBeNull();
    expect(await store.get("no-such-run")).toBeNull();
  });

  /*
   * The order that makes `finish` a separate method. A run fails where the failure is known, and the
   * thread lock releases on its way out afterwards — so an unguarded transition at release would
   * overwrite `failed` with `done` and lose the one state a person most needs to read.
   */
  test("finishing never overwrites a state that already ended the run", async () => {
    const actorUserId = await seedUser();
    const row = await begin(actorUserId);
    await store.transition(row.runId, "failed", {
      error: "the computer was refused",
    });

    const after = await store.finish(row.runId, "done");

    expect(after).toBeNull();
    expect((await store.get(row.runId))?.state).toBe("failed");
    expect((await store.get(row.runId))?.error).toBe(
      "the computer was refused",
    );
  });

  test("finishing an open run ends it as done", async () => {
    const actorUserId = await seedUser();
    const row = await begin(actorUserId);

    const after = await store.finish(row.runId);

    expect(after?.state).toBe("done");
    expect(after?.endedAt).not.toBeNull();
  });

  test("finishing a run nobody recorded invents nothing", async () => {
    expect(await store.finish("no-such-run")).toBeNull();
  });
});

describe("a delegation chain", () => {
  test("reads as one list, with each hop's target filled in", async () => {
    const actorUserId = await seedUser();
    // Remii hands to Research Desk, which hands to Coco.
    const remii = await begin(actorUserId, { runId: "chain-remii" });
    createdRunIds.push("chain-remii");
    const research = await begin(actorUserId, {
      runId: "chain-research",
      botId: "research-desk",
      parentRunId: remii.runId,
    });
    createdRunIds.push("chain-research");
    const coco = await begin(actorUserId, {
      runId: "chain-coco",
      botId: "coco",
      parentRunId: research.runId,
    });
    createdRunIds.push("chain-coco");

    // Oldest first, the way a chain is read.
    const rows = [remii, research, coco].map((r) => r.runId);
    for (const runId of [...rows].reverse()) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      void runId;
    }
    const chain = (await store.chain(actorUserId)).filter((r) =>
      rows.includes(r.runId),
    );

    // Newest first, and each hop names who it handed to without a second query.
    expect(chain.map((c) => c.botId)).toEqual([
      "coco",
      "research-desk",
      "general-assistant",
    ]);
    expect(chain[0]?.parentRunId).toBe(research.runId);
    expect(chain[0]?.delegatedToBotId).toBe("research-desk");
    expect(chain[1]?.delegatedToBotId).toBe("general-assistant");
    // The run a person started delegated to nobody.
    expect(chain[2]?.parentRunId).toBeNull();
    expect(chain[2]?.delegatedToBotId).toBeNull();
  });

  test("one person's activity is never another's", async () => {
    const mine = await seedUser();
    const theirs = await seedUser();
    const myRun = await begin(mine);
    await begin(theirs);

    /*
     * Asserted by which run came back, not by a field on it: `RunActivityBrief` carries no
     * `actorUserId` because every caller already knows whose roster it is filling, and a row that
     * repeated it would be a second copy of the same fact to get out of step. The scoping is the
     * query, and the query is what this checks.
     */
    const open = await store.open(mine);
    expect(open.map((r) => r.runId)).toEqual([myRun.runId]);
  });
});

/*
 * WHAT THE ROSTER SHOWS.
 *
 * A channel holds several Bots and one row, so somewhere a run has to be chosen between them. This
 * is that place, and the choice is the feature: choosing the wrong one is how a roster shows "idle"
 * while a Bot is blocked on a question.
 */
describe("worstForChannels", () => {
  it("picks the run that most wants a person's attention", async () => {
    const actorUserId = await seedUser();
    const thinking = `worst-thinking-${Math.random().toString(36).slice(2)}`;
    const waiting = `worst-waiting-${Math.random().toString(36).slice(2)}`;
    createdRunIds.push(thinking, waiting);
    await store.begin({
      runId: thinking,
      actorUserId,
      botId: "bot-a",
      channelId: "c1",
      threadId: "t",
    });
    await store.begin({
      runId: waiting,
      actorUserId,
      botId: "bot-a",
      channelId: "c1",
      threadId: "t",
    });
    // The waiting run is the OLDER of the two, so recency alone would pick the wrong one.
    await store.transition(waiting, "waiting_on_you", {
      label: "Needs your answer",
    });
    await store.transition(thinking, "thinking");

    const worst = await store.worstForChannels(actorUserId);
    const held = worst.get(activityKey("c1", "bot-a"));
    expect(held?.state).toBe("waiting_on_you");
    expect(held?.label).toBe("Needs your answer");
  });

  it("keeps a run that failed even though it has ended, and drops one that finished", async () => {
    const actorUserId = await seedUser();
    const failed = `worst-failed-${Math.random().toString(36).slice(2)}`;
    const done = `worst-done-${Math.random().toString(36).slice(2)}`;
    createdRunIds.push(failed, done);
    await store.begin({
      runId: failed,
      actorUserId,
      botId: "bot-b",
      channelId: "c1",
      threadId: "t",
    });
    await store.begin({
      runId: done,
      actorUserId,
      botId: "bot-c",
      channelId: "c1",
      threadId: "t",
    });
    await store.transition(failed, "failed", { detail: "the model refused" });
    await store.transition(done, "done");

    const worst = await store.worstForChannels(actorUserId);
    // A broken run is the thing somebody has to do something about, and it will never be open
    // again — so dropping it on `endedAt` would hide exactly the run worth seeing.
    expect(worst.get(activityKey("c1", "bot-b"))?.state).toBe("failed");
    // A finished run is the absence of activity, and a roster that kept showing it would be lying.
    expect(worst.has(activityKey("c1", "bot-c"))).toBe(false);
  });

  /*
   * ONE CHANNEL'S RUN DOES NOT LIGHT UP ANOTHER CHANNEL THE SAME BOT IS IN.
   *
   * Reduced by Bot alone, this put a "working" pulse on every channel that Bot belonged to the
   * moment it started working anywhere. Remii is in every channel in this app, so answering a
   * message in one conversation made the whole roster claim four colleagues were busy — and a person
   * looking at that had no way to tell a real delegation from one reply being written.
   */
  it("keeps a run in the channel it belongs to, and out of the Bot's other channels", async () => {
    const actorUserId = await seedUser();
    const runId = `scoped-${Math.random().toString(36).slice(2)}`;
    createdRunIds.push(runId);
    await store.begin({
      runId,
      actorUserId,
      botId: "general-assistant",
      channelId: "channel-where-the-work-is",
      threadId: "t",
    });
    await store.transition(runId, "thinking");

    const worst = await store.worstForChannels(actorUserId);

    // The channel the work is in, readable under its own key.
    expect(
      worst.get(activityKey("channel-where-the-work-is", "general-assistant"))
        ?.state,
    ).toBe("thinking");
    // And no other channel of the same Bot is lit by it.
    expect(
      worst.get(activityKey("channel-somewhere-else", "general-assistant")),
    ).toBeUndefined();
  });

  it("still offers a run with no channel as a fallback, for a direct conversation", async () => {
    // A run in no channel is not a roster row at all — it is somebody talking to a Bot directly —
    // so it is offered under the placeholder and read only where the channel has nothing of its own.
    const actorUserId = await seedUser();
    const runId = `unscoped-${Math.random().toString(36).slice(2)}`;
    createdRunIds.push(runId);
    await store.begin({
      runId,
      actorUserId,
      botId: "general-assistant",
      threadId: "t",
    });
    await store.transition(runId, "delegated", { label: "With Coco" });

    const worst = await store.worstForChannels(actorUserId);

    expect(worst.get(activityKey(null, "general-assistant"))?.label).toBe(
      "With Coco",
    );
  });

  it("says nothing about somebody else's runs", async () => {
    const mine = await seedUser();
    const theirs = await seedUser();
    const run = `worst-foreign-${Math.random().toString(36).slice(2)}`;
    createdRunIds.push(run);
    await store.begin({
      runId: run,
      actorUserId: theirs,
      botId: "bot-d",
      threadId: "t",
    });

    const worst = await store.worstForChannels(mine);
    expect(worst.size).toBe(0);
  });
});
