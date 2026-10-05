import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRemiStore } from "../src/remi/store";
import { testDatabase, } from "./support/database";
import { REMII_AGENT_ID } from "../../shared/remii";

/**
 * Remi's brain on Remii's database: memory round-trips, dedup, todos and schedules.
 * Embeddings run on the local-hash fallback here (no key), which is exactly what the
 * keyword fallback in search is for.
 */

const database = testDatabase();
const store = createRemiStore({ database });
const userId = `remi-test-${randomUUID()}`;

beforeAll(async () => {
  await database.execute(
    `INSERT INTO users (id, email) VALUES ('${userId}', '${userId}@example.test') ON CONFLICT DO NOTHING`,
  );
});

describe("memory", () => {
  test("saves and recalls a fact", async () => {
    const saved = await store.saveMemory({
      userId,
      botId: REMII_AGENT_ID,
      content: "The person takes oat milk in a flat white.",
    });
    expect(saved.saved).toBe(true);

    const found = await store.searchMemories({
      userId,
      botId: REMII_AGENT_ID,
      query: "flat white milk preference",
    });
    expect(found.found).toBe(true);
    expect(found.memories[0]?.content).toContain("oat milk");
  });

  test("does not save the same fact twice", async () => {
    const first = await store.saveMemory({
      userId,
      botId: REMII_AGENT_ID,
      content: "The office dog is called Biscuit.",
    });
    const second = await store.saveMemory({
      userId,
      botId: REMII_AGENT_ID,
      content: "The office dog is called Biscuit.",
    });
    expect(first.saved).toBe(true);
    expect(second.saved).toBe(false);
  });

  test("update, list and delete", async () => {
    const saved = await store.saveMemory({
      userId,
      botId: REMII_AGENT_ID,
      content: "Temporary fact for update.",
    });
    expect(saved.id).not.toBeNull();
    const updated = await store.updateMemory(saved.id as string, userId, {
      importance: 9,
    });
    expect(updated).toBe(true);
    const listed = await store.listMemories({ userId, limit: 50 });
    expect(listed.some((row) => row.id === saved.id)).toBe(true);
    expect(await store.deleteMemory(saved.id as string, userId)).toBe(true);
    const relisted = await store.listMemories({ userId, limit: 50 });
    expect(relisted.some((row) => row.id === saved.id)).toBe(false);
  });
});

describe("todos", () => {
  test("add, list, update, delete", async () => {
    const id = await store.todos.add({
      userId,
      title: "Water the plants",
      sourceRef: `test-${randomUUID()}`,
      importance: "HIGH",
    });
    expect(id).not.toBeNull();
    const open = await store.todos.list({ userId });
    expect(open.some((row) => row.id === id)).toBe(true);
    expect(
      await store.todos.update(userId, id as string, {
        status: "DONE",
        resultSummary: "Watered.",
      }),
    ).toBe(true);
    expect(await store.todos.remove(userId, id as string)).toBe(true);
  });
});

describe("schedule", () => {
  test("create, list, delete with cron validation", async () => {
    const { Cron } = await import("croner");
    const next = new Cron("0 9 * * 1-5", { timezone: "UTC" }).nextRun();
    const id = await store.cron.create({
      userId,
      botId: REMII_AGENT_ID,
      name: "Morning brief",
      expression: "0 9 * * 1-5",
      timezone: "UTC",
      nextRunAt: next as Date,
    });
    expect(id).not.toBeNull();
    const listed = await store.cron.list(userId);
    expect(listed.some((row) => row.id === id)).toBe(true);
    expect(await store.cron.remove(userId, id as string)).toBe(true);
  });
});
