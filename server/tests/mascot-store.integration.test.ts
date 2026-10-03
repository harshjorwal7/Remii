import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  type AgentProfileStore,
  createAgentProfileStore,
} from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { DEPLOYMENT_ROUTES } from "../src/computer/deployment-routes";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The mascot's round trip through the store, which is the one part of this feature no unit test can
 * reach: three nullable columns in a row, read back through a projection and handed to a form.
 *
 * Written against a real database on purpose. A store test that mocks the executor cannot catch the
 * failure that matters most here — a column added to the schema but forgotten in the `update` set,
 * which typechecks perfectly and silently discards a person's choice every time they save.
 */
const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const store: AgentProfileStore = createAgentProfileStore(
  database,
  DEPLOYMENT_ROUTES,
);
const testPrefix = `mascot-store-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];

afterEach(async () => {
  for (const agentId of createdAgentIds.splice(0)) {
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

function id(kind: string) {
  return `${testPrefix}-${kind}-${randomUUID()}`;
}

async function createActor(): Promise<AgentActor> {
  const userId = id("user");
  await database.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    name: "Mascot Store Test User",
  });
  createdUserIds.push(userId);
  return { id: userId, role: "user" };
}

/**
 * The columns as they actually sit in the row, which is what the client resolves against.
 *
 * Two of them. `mascotExpression` was a third until migration 0070 and selecting it here would fail
 * every test in this file the moment it went, which is the failure mode worth having: a column that
 * the schema does not have cannot be quietly read as though it did.
 */
async function mascotRow(agentId: string) {
  const [row] = await database
    .select({
      mascotShape: agentProfiles.mascotShape,
      mascotColor: agentProfiles.mascotColor,
    })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId));
  return row;
}

const base = {
  title: "Chief of Staff",
  roleDescription: "Keeps the day in order.",
  visibility: "private" as const,
  endpoint: "https://ours.example.test/ag-ui",
};

describe("a coworker's mascot, through the store", () => {
  test("is null in the row when nobody chose one", async () => {
    const actor = await createActor();
    const created = await store.create(actor, {
      ...base,
      name: "Unchosen",
    });

    // The whole backwards-compatibility story in one assertion: the row says nothing, and the client
    // fills it from `avatarSeed`. No migration reads or writes an existing row.
    expect(await mascotRow(created.id)).toEqual({
      mascotShape: null,
      mascotColor: null,
    });
    expect(created.mascot).toBeNull();
    // The seed is what makes an unchosen coworker still distinct from its siblings, so it must be the
    // agent's own id rather than anything shared.
    expect(created.avatarSeed).toBe(created.id);
  });

  test("is stored on create and read back", async () => {
    const actor = await createActor();
    const created = await store.create(actor, {
      ...base,
      name: "Dressed",
      mascot: { shape: "pebble", color: "teal" },
    });

    expect(created.mascot).toEqual({ shape: "pebble", color: "teal" });
    expect(await mascotRow(created.id)).toEqual({
      mascotShape: "pebble",
      mascotColor: "teal",
    });
  });

  test("keeps a partial choice partial, so the unchosen axes stay seeded", async () => {
    const actor = await createActor();
    const created = await store.create(actor, {
      ...base,
      name: "Half Dressed",
      mascot: { color: "teal" },
    });

    expect(created.mascot).toEqual({ color: "teal" });
    // The shape is still null, so a person who has only picked a colour gets coworkers that differ in
    // shape rather than eight identical circles.
    expect(await mascotRow(created.id)).toEqual({
      mascotShape: null,
      mascotColor: "teal",
    });
  });

  test("survives a read through `get`, which is the path a profile screen uses", async () => {
    const actor = await createActor();
    const created = await store.create(actor, {
      ...base,
      name: "Re Read",
      mascot: { shape: "cloud", color: "amber" },
    });

    const fetched = await store.get(actor, created.id);
    expect(fetched?.mascot).toEqual({
      shape: "cloud",
      color: "amber",
    });
  });

  test("is not touched by an edit that never mentioned it", async () => {
    const actor = await createActor();
    const created = await store.create(actor, {
      ...base,
      name: "Original Name",
      mascot: { shape: "hexagon", color: "violet" },
    });

    /*
     * THE CASE THIS FEATURE IS MOST LIKELY TO BREAK.
     *
     * The update endpoint takes the whole profile and the edit form sends the whole form, so an
     * update that dropped the mascot would not be a crash — it would be somebody's coworker's shape
     * and colour quietly resetting the first time they fixed a typo in a name. `store.update`
     * therefore reads an omitted `mascot` as "not mentioned" rather than as "set it to nothing".
     */
    await store.update(actor, created.id, {
      name: "A Different Name Entirely",
      title: base.title,
      roleDescription: base.roleDescription,
      visibility: "private",
      endpoint: base.endpoint,
    });

    expect(await mascotRow(created.id)).toEqual({
      mascotShape: "hexagon",
      mascotColor: "violet",
    });
  });

  test("replaces the whole mascot when one is mentioned, clearing the axes left out", async () => {
    const actor = await createActor();
    const created = await store.create(actor, {
      ...base,
      name: "Replaced",
      mascot: { shape: "hexagon", color: "violet" },
    });

    await store.update(actor, created.id, {
      name: "Replaced",
      title: base.title,
      roleDescription: base.roleDescription,
      visibility: "private",
      endpoint: base.endpoint,
      mascot: { color: "teal" },
    });

    // The two axes the caller left out go back to the seed. Keeping them would mean clearing one
    // colour was impossible without a separate reset endpoint.
    expect(await mascotRow(created.id)).toEqual({
      mascotShape: null,
      mascotColor: "teal",
    });
  });

  test("goes back to being seeded on an empty mascot", async () => {
    const actor = await createActor();
    const created = await store.create(actor, {
      ...base,
      name: "Reset",
      mascot: { shape: "hexagon", color: "violet" },
    });

    await store.update(actor, created.id, {
      name: "Reset",
      title: base.title,
      roleDescription: base.roleDescription,
      visibility: "private",
      endpoint: base.endpoint,
      mascot: {},
    });

    expect(await mascotRow(created.id)).toEqual({
      mascotShape: null,
      mascotColor: null,
    });
  });

  test("is carried into a duplicate, so a copy looks like what it was copied from", async () => {
    const actor = await createActor();
    const created = await store.create(actor, {
      ...base,
      name: "Original",
      mascot: { shape: "triangle", color: "red" },
    });

    const copy = await store.duplicate(actor, created.id);
    // `avatarSeed` is copied too, so an unchosen source produces a copy that matches it exactly; a
    // chosen one has to be carried or the copy looks like a different coworker.
    expect(copy.mascot).toEqual({ shape: "triangle", color: "red" });
  });

  test("leaves a duplicate of an unchosen coworker unchosen", async () => {
    const actor = await createActor();
    const created = await store.create(actor, {
      ...base,
      name: "Plain",
    });

    const copy = await store.duplicate(actor, created.id);
    expect(copy.mascot).toBeNull();
    expect(await mascotRow(copy.id)).toEqual({
      mascotShape: null,
      mascotColor: null,
    });
  });
});
