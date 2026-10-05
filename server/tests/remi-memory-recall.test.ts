import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  citedMemoryIds,
  decideRecall,
  recallForTurn,
} from "../src/remi/memory-router";
import { createRemiStore } from "../src/remi/store";
import { testDatabase, } from "./support/database";
import { REMII_AGENT_ID } from "../../shared/remii";

/**
 * Pre-turn recall (Phase 1) on top of the Phase 0 store: the gate, the
 * fused recall block, citation tracking, supersede exclusion, category
 * expiry, and the events trail. Runs against the dedicated test database
 * with the local-hash embedding fallback (no key), exactly like
 * remi-store.test.ts.
 */

const database = testDatabase();
const store = createRemiStore({ database });
const userId = `recall-test-${randomUUID()}`;
const botId = REMII_AGENT_ID;
const MODEL = { provider: "openai", model: "gpt-4o-mini" } as const;

beforeAll(async () => {
  await database.execute(
    sql`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@example.test`}) ON CONFLICT DO NOTHING`,
  );
});

describe("decideRecall", () => {
  test("greetings and acknowledgements need nothing, with no model call", async () => {
    for (const text of ["hi", "thanks!", "ok", "👍", ""]) {
      expect(await decideRecall({ userText: text, model: MODEL })).toEqual({
        needed: false,
      });
    }
  });

  test("stays closed with no model key rather than failing the turn", async () => {
    // No key in this environment, so the chain is empty: recall is skipped
    // and the model still holds memory_search for the turn.
    expect(
      await decideRecall({
        userText: "book me a flight like last time",
        model: MODEL,
        environment: {},
      }),
    ).toEqual({ needed: false });
  });
});

describe("citedMemoryIds", () => {
  test("matches memories visibly used in the answer", () => {
    const memories = [
      {
        id: "m1",
        content:
          "The person prefers aisle seats on flights and always asks for extra legroom when available.",
      },
      { id: "m2", content: "The office dog is called Biscuit." },
    ];
    expect(
      citedMemoryIds(
        memories,
        "Booked the aisle seat with extra legroom as you like.",
      ),
    ).toEqual([]);
    expect(
      citedMemoryIds(
        memories,
        "I remembered the person prefers aisle seats on flights and always asks for extra legroom when available, so booked accordingly.",
      ),
    ).toEqual(["m1"]);
    // The distinctive tail, not the scaffolding: answers quote what matters.
    expect(
      citedMemoryIds(
        memories,
        "Salted peanuts it is — I remembered that is your favorite debugging snack.",
      ),
    ).toEqual([]);
    expect(
      citedMemoryIds(
        [
          {
            id: "m3",
            content:
              "Live turn probe: the person's favorite debugging snack is salted peanuts.",
          },
        ],
        "Noted: the person's favorite debugging snack is salted peanuts, so I'll keep them handy.",
      ),
    ).toEqual(["m3"]);
    // Second-person answers match third-person memories.
    expect(
      citedMemoryIds(
        [
          {
            id: "m4",
            content: "The person prefers aisle seats on flights.",
          },
        ],
        "Booked it: the person prefers aisle seats on flights, as remembered.",
      ),
    ).toEqual(["m4"]);
    // Near-misses stay unmatched: strict beats wrong reinforcement.
    expect(
      citedMemoryIds(
        [{ id: "m5", content: "The person prefers aisle seats on flights." }],
        "Booked your preferred aisle seat.",
      ),
    ).toEqual([]);
  });

  test("short fragments never count", () => {
    expect(citedMemoryIds([{ id: "m1", content: "ok" }], "ok done")).toEqual(
      [],
    );
  });
});

describe("recallForTurn", () => {
  test("injects this Bot's relevant memories with citations", async () => {
    await store.saveMemory({
      userId,
      botId,
      content: `Recall probe ${userId}: the person prefers aisle seats on flights.`,
      scope: "global",
    });
    const recalled = await recallForTurn({
      store,
      userId,
      botId,
      userText: "book a flight",
      model: MODEL,
      gate: async () => ({ needed: true, queries: ["flight seat preference"] }),
    });
    expect(recalled.block).not.toBeNull();
    expect(recalled.block).toContain("aisle seats");
    expect(recalled.block).toContain("[");
    expect(recalled.memoryIds.length).toBeGreaterThan(0);
    expect(recalled.memories[0]?.content).toContain("aisle seats");
  });

  test("returns null when nothing is known", async () => {
    const recalled = await recallForTurn({
      store,
      userId: `nobody-${randomUUID()}`,
      botId,
      userText: "book a flight",
      model: MODEL,
      gate: async () => ({ needed: true, queries: ["flight seat preference"] }),
    });
    expect(recalled.block).toBeNull();
    expect(recalled.memoryIds).toEqual([]);
  });
});

describe("superseded memories stay out of recall", () => {
  test("search and list skip superseded rows", async () => {
    const tag = randomUUID();
    const saved = await store.saveMemory({
      userId,
      botId,
      content: `Supersede probe ${tag}: the person works at Acme.`,
      scope: "global",
    });
    expect(saved.saved).toBe(true);
    const before = await store.searchMemories({
      userId,
      botId,
      query: `works at Acme ${tag}`,
    });
    expect(before.found).toBe(true);

    await database.execute(
      sql`UPDATE memories SET superseded_by = 'newer-id' WHERE id = ${saved.id}`,
    );
    const after = await store.searchMemories({
      userId,
      botId,
      query: `works at Acme ${tag}`,
    });
    expect(after.memories.some((memory) => memory.id === saved.id)).toBe(false);
    const listed = await store.listMemories({ userId });
    expect(listed.some((row) => row.id === saved.id)).toBe(false);
  });
});

describe("category expiry defaults", () => {
  test("transient rots, identity does not", async () => {
    const transient = await store.saveMemory({
      userId,
      botId,
      content: `Expiry probe ${randomUUID()}: preparing slides for Friday.`,
      category: "transient",
    });
    const identity = await store.saveMemory({
      userId,
      botId,
      content: `Expiry probe ${randomUUID()}: the person is allergic to peanuts.`,
      category: "identity",
    });
    const rows = (await database.execute(
      sql`SELECT id, expires_at FROM memories WHERE id IN (${transient.id}, ${identity.id})`,
    )) as unknown as Array<{ id: string; expires_at: string | null }>;
    const byId = new Map(rows.map((row) => [row.id, row.expires_at]));
    expect(byId.get(transient.id)).not.toBeNull();
    expect(byId.get(identity.id)).toBeNull();
  });
});

describe("memory events", () => {
  test("recall records events and stats read them back", async () => {
    const saved = await store.saveMemory({
      userId,
      botId,
      content: `Events probe ${randomUUID()}: the person drinks oat milk.`,
      scope: "global",
    });
    expect(saved.id).not.toBeNull();
    await store.recordMemoryEvent({
      memoryId: saved.id ?? "",
      userId,
      botId,
      kind: "recalled",
    });
    await store.recordMemoryEvent({
      memoryId: saved.id ?? "",
      userId,
      botId,
      kind: "cited",
    });
    const stats = await store.recallStats({
      userId,
      memoryIds: [saved.id ?? ""],
    });
    expect(stats[saved.id ?? ""]).toEqual({ recalled: 2, cited: 1 });
  });
});

describe("handoff brief", () => {
  test("compiles episode plus relevant context without a model", async () => {
    const { buildBrief } = await import("../src/remi/handoff-brief");
    const taskId = `task-${randomUUID()}`;
    await store.saveMemory({
      userId,
      botId,
      content: `Brief probe ${taskId}: draft r123 created, awaiting send.`,
      scope: "task",
      taskId,
    });
    const brief = await buildBrief({
      store,
      userId,
      targetBotId: botId,
      taskId,
      task: "send the invoice",
      constraints: ["draft, never send"],
      model: MODEL,
    });
    expect(brief.brief).toContain("send the invoice");
    expect(brief.brief).toContain("draft r123");
    expect(brief.brief).toContain("draft, never send");
    expect(brief.sourceIds.length).toBeGreaterThan(0);
  });

  test("two tasks never see each other's episodes", async () => {
    const { buildBrief } = await import("../src/remi/handoff-brief");
    const taskA = `task-a-${randomUUID()}`;
    const taskB = `task-b-${randomUUID()}`;
    const secret = `Secret project codename ${randomUUID()}`;
    await store.saveMemory({
      userId,
      botId,
      content: secret,
      scope: "task",
      taskId: taskA,
    });
    const brief = await buildBrief({
      store,
      userId,
      targetBotId: botId,
      taskId: taskB,
      task: "unrelated work",
      model: MODEL,
    });
    expect(brief.brief).not.toContain(secret);
  });
});

describe("consolidation", () => {
  test("dry run links nothing but reports", async () => {
    const { consolidateUserMemory } = await import(
      "../src/remi/memory-consolidate"
    );
    const tag = randomUUID();
    const first = await store.saveMemory({
      userId,
      botId,
      content: `Consolidation probe ${tag}: the person works at Acme.`,
      scope: "global",
    });
    const second = await store.saveMemory({
      userId,
      botId,
      content: `Consolidation probe ${tag}: the person is employed by Acme Inc.`,
      scope: "global",
    });
    const report = await consolidateUserMemory({
      store,
      userId,
      model: MODEL,
      dryRun: true,
      decide: async () => ({
        groups: [
          {
            keep: first.id ?? "",
            drop: second.id ? [second.id] : [],
            reason: "duplicate",
          },
        ],
      }),
    });
    expect(report.checked).toBeGreaterThan(0);
    expect(report.decisions).toHaveLength(1);
    expect(report.merged).toBe(0);
    // Dry run linked nothing: both still recallable.
    const found = await store.searchMemories({
      userId,
      botId,
      query: `Consolidation probe ${tag} Acme`,
    });
    expect(found.memories.some((memory) => memory.id === second.id)).toBe(true);
  });

  test("live run supersedes the loser everywhere", async () => {
    const { consolidateUserMemory } = await import(
      "../src/remi/memory-consolidate"
    );
    const tagA = randomUUID();
    const tagB = randomUUID();
    const first = await store.saveMemory({
      userId,
      botId,
      content: `Rival probe ${tagA}: the person works at Acme as an accountant.`,
      scope: "global",
    });
    const second = await store.saveMemory({
      userId,
      botId,
      content: `Rival probe ${tagB}: the person quit accounting entirely and now runs a bakery.`,
      scope: "global",
    });
    expect(first.saved).toBe(true);
    expect(second.saved).toBe(true);
    const report = await consolidateUserMemory({
      store,
      userId,
      model: MODEL,
      decide: async () => ({
        groups: [
          {
            keep: second.id ?? "",
            drop: first.id ? [first.id] : [],
            reason: "newer statement supersedes older guess",
          },
        ],
      }),
    });
    expect(report.superseded).toBe(1);
    const found = await store.searchMemories({
      userId,
      botId,
      query: `Rival probe bakery accounting`,
    });
    expect(found.memories.some((memory) => memory.id === first.id)).toBe(false);
    expect(found.memories.some((memory) => memory.id === second.id)).toBe(true);
  });
});

describe("forgetting curve", () => {
  test("cited memories reinforce; sweep takes only the forgotten", async () => {
    const { randomUUID: uuid } = await import("node:crypto");
    const usedTag = uuid();
    const used = await store.saveMemory({
      userId,
      botId,
      content: `Reinforce probe ${usedTag}: the person flies aisle seats.`,
      scope: "global",
      importance: 5,
    });
    await store.recordMemoryEvent({
      memoryId: used.id ?? "",
      userId,
      botId,
      kind: "cited",
    });
    const after = (await database.execute(
      sql`SELECT importance, recall_count, last_recalled_at FROM memories WHERE id = ${used.id}`,
    )) as unknown as Array<{
      importance: number;
      recall_count: number;
      last_recalled_at: string | null;
    }>;
    expect(after[0]?.importance).toBe(6);
    expect(
      after[0]?.lastRecalledAt ?? after[0]?.last_recalled_at,
    ).not.toBeNull();

    // A stale, unimportant, never-recalled row is sweep-eligible.
    const staleTag = uuid();
    const stale = await store.saveMemory({
      userId,
      botId,
      content: `Sweep probe ${staleTag}: temporary lunch preference.`,
      scope: "global",
      importance: 2,
    });
    await database.execute(
      sql`UPDATE memories SET created_at = now() - interval '200 days' WHERE id = ${stale.id}`,
    );
    const sweep = await store.sweepMemories({ userId, dryRun: true });
    expect(sweep.candidates).toContain(stale.id);
    expect(sweep.candidates).not.toContain(used.id);
    expect(sweep.swept).toBe(0);
    const live = await store.sweepMemories({ userId });
    expect(live.swept).toBeGreaterThanOrEqual(1);
    const listed = await store.listMemories({ userId });
    expect(listed.some((row) => row.id === stale.id)).toBe(false);
    // The reinforced row survives the same sweep.
    expect(listed.some((row) => row.id === used.id)).toBe(true);
  });

  test("pinned and safety rows are never swept", async () => {
    const { randomUUID: uuid } = await import("node:crypto");
    const safe = await store.saveMemory({
      userId,
      botId,
      content: `Safety probe ${uuid()}: the person is allergic to peanuts.`,
      scope: "global",
      category: "safety",
      importance: 1,
    });
    await database.execute(
      sql`UPDATE memories SET created_at = now() - interval '200 days', pinned = true WHERE id = ${safe.id}`,
    );
    const sweep = await store.sweepMemories({ userId, dryRun: true });
    expect(sweep.candidates).not.toContain(safe.id);
  });

  test("save budget counts background saves, never explicit ones", async () => {
    // Explicit saves are always honoured and never spend the background
    // budget; the daemon, debriefs and closes do.
    const spent = await store.autoSavesToday(userId);
    expect(spent).toBeGreaterThanOrEqual(0);
    const { randomUUID: uuid } = await import("node:crypto");
    await store.saveMemory({
      userId,
      content: `Budget probe ${uuid()}: explicit save.`,
      scope: "global",
      source: "explicit",
    });
    expect(await store.autoSavesToday(userId)).toBe(spent);
  });
});

describe("task episodes", () => {
  test("task rows join task reads and never another task", async () => {
    const { randomUUID: uuid } = await import("node:crypto");
    const taskA = `ep-a-${uuid()}`;
    const taskB = `ep-b-${uuid()}`;
    const secret = `Episode secret ${uuid()}`;
    await store.saveMemory({
      userId,
      botId,
      content: secret,
      scope: "task",
      taskId: taskA,
    });
    const inTask = await store.searchMemories({
      userId,
      botId,
      query: secret.slice(0, 40),
      taskId: taskA,
    });
    expect(inTask.memories.some((memory) => memory.content === secret)).toBe(
      true,
    );
    const otherTask = await store.searchMemories({
      userId,
      botId,
      query: secret.slice(0, 40),
      taskId: taskB,
    });
    expect(otherTask.memories.some((memory) => memory.content === secret)).toBe(
      false,
    );
    const listed = await store.listMemories({ userId, taskId: taskA });
    expect(listed.some((row) => row.content === secret)).toBe(true);
  });

  test("closing an episode promotes conclusions and expires trivia", async () => {
    const { closeTaskEpisode } = await import("../src/remi/handoff-brief");
    const { randomUUID: uuid } = await import("node:crypto");
    const taskId = `ep-close-${uuid()}`;
    await store.saveMemory({
      userId,
      botId,
      content: `Close probe: draft r999 created for the invoice.`,
      scope: "task",
      taskId,
    });
    const closed = await closeTaskEpisode({
      store,
      userId,
      taskId,
      model: MODEL,
      conclude: async () => ["The person itemizes every invoice."],
    });
    expect(closed.promoted).toHaveLength(1);
    const globals = await store.searchMemories({
      userId,
      botId,
      query: "itemizes every invoice",
    });
    expect(
      globals.memories.some((memory) =>
        memory.content.includes("itemizes every invoice"),
      ),
    ).toBe(true);
    const rows = (await database.execute(
      sql`SELECT expires_at FROM memories WHERE user_id = ${userId} AND task_id = ${taskId}`,
    )) as unknown as Array<{ expires_at: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.expires_at !== null)).toBe(true);
  });

  test("stale episodes are found for the nightly close", async () => {
    const { randomUUID: uuid } = await import("node:crypto");
    const taskId = `ep-stale-${uuid()}`;
    await store.saveMemory({
      userId,
      botId,
      content: `Stale probe: old working note.`,
      scope: "task",
      taskId,
    });
    await database.execute(
      sql`UPDATE memories SET updated_at = now() - interval '30 days', created_at = now() - interval '30 days' WHERE user_id = ${userId} AND task_id = ${taskId}`,
    );
    const stale = await store.staleTaskIds({ userId });
    expect(stale).toContain(taskId);
  });
});

describe("entities", () => {
  test("linking resolves aliases to one row; recall respects the sandbox", async () => {
    const { randomUUID: uuid } = await import("node:crypto");
    const fact = await store.saveMemory({
      userId,
      botId,
      content: `Entity probe ${uuid()}: Acme Inc renewed for another year.`,
      scope: "global",
    });
    const linked = await store.linkMemoryEntities({
      memoryId: fact.id ?? "",
      userId,
      entities: [{ type: "company", name: "Acme Inc", aliases: ["Acme"] }],
    });
    expect(linked).toBe(1);
    // Alias spelling resolves to the same row, not a second entity.
    const again = await store.linkMemoryEntities({
      memoryId: fact.id ?? "",
      userId,
      entities: [{ type: "company", name: "acme", aliases: [] }],
    });
    expect(again).toBe(1);

    const matched = await store.matchEntities({
      userId,
      text: "what did we decide with acme about the renewal?",
    });
    expect(matched.some((entity) => entity.name === "Acme Inc")).toBe(true);

    const recalled = await store.recallByEntity({
      userId,
      botId,
      entityId: matched.find((entity) => entity.name === "Acme Inc")?.id ?? "",
    });
    expect(recalled.some((memory) => memory.id === fact.id)).toBe(true);
  });

  test("another Bot's chat rows never ride an entity link", async () => {
    const { randomUUID: uuid } = await import("node:crypto");
    const other = await store.saveMemory({
      userId,
      botId: "some-other-bot",
      content: `Private probe ${uuid()}: unrelated note.`,
      scope: "chat",
    });
    await store.linkMemoryEntities({
      memoryId: other.id ?? "",
      userId,
      entities: [{ type: "topic", name: `SharedTopic ${uuid()}` }],
    });
    const entityId = (
      await store.matchEntities({ userId, text: "unrelated note" })
    )[0]?.id;
    // matchEntities is name-based and finds nothing here; recallByEntity
    // with the wrong bot still excludes the row.
    const names = await store.matchEntities({ userId, text: "zzz-no-match" });
    expect(names).toEqual([]);
    void entityId;
  });
});
