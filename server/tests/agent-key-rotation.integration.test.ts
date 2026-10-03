import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createDatabase } from "../src/db/client";
import { testDatabaseUrl } from "./support/database";
import { agentProfiles, agents, credentials, users } from "../src/db/schema";

/**
 * Editing a coworker, against a real database, on a pool of exactly one connection.
 *
 * WAS about rotating a Bot's bearer key, and the pool size was the whole point: a second vault write
 * on its own connection is a second session competing with the transaction the edit is already
 * inside, and at `max: 1` it cannot even be handed a connection until that transaction ends — which
 * it never will, because the transaction is awaiting the call.
 *
 * That hazard is gone with the feature it was guarding. A coworker can no longer carry a key of its
 * own, so an edit writes one row and one profile row inside the transaction and reaches for nothing
 * outside it. The pool is still pinned to one connection, because the property worth keeping is the
 * general one: an edit must return on a deployment that has no spare connection to hand out, which is
 * what a laptop with everything else closed looks like.
 */

const database = createDatabase(testDatabaseUrl(), { max: 1 });

const profiles = createAgentProfileStore(database);

const suite = randomUUID().slice(0, 8);
const actor: AgentActor = { id: `user_${suite}`, role: "admin" };
const created: string[] = [];

/** An edit that hangs is the failure, so the wait is bounded and the bound is the assertion. */
const DEADLINE_MS = 5_000;

async function within<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} did not return within ${DEADLINE_MS}ms, which is what a vault write on a second connection looks like from inside the transaction that is holding the only one`,
          ),
        ),
      DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function liveCredentialsFor(agentId: string) {
  return database
    .select({ id: credentials.id })
    .from(credentials)
    .where(
      and(
        eq(credentials.kind, "agent"),
        eq(credentials.keyId, agentId),
        isNull(credentials.revokedAt),
      ),
    );
}

beforeAll(async () => {
  await database.insert(users).values({
    id: actor.id,
    email: `${actor.id}@remii.test`,
    name: "Edit tester",
    emailVerified: true,
  });

  const profile = await profiles.create(actor, {
    name: `edit ${suite}`,
    title: "Tester",
    roleDescription: "Holds an instruction that gets edited.",
    visibility: "private",
    systemPrompt: "First instruction.",
  });
  created.push(profile.id);
});

afterAll(async () => {
  if (created.length) {
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, created));
    await database.delete(agents).where(inArray(agents.id, created));
  }
  await database.delete(users).where(eq(users.id, actor.id));
  await database.$client.end();
});

describe("editing a coworker", () => {
  test("returns on a pool of one connection, and the edit is what landed", async () => {
    const [agentId] = created;

    const edited = await within(
      "the edit",
      profiles.update(actor, agentId, {
        name: `edit ${suite}`,
        title: "Tester",
        roleDescription: "Second instruction.",
        visibility: "private",
      }),
    );

    expect(edited.name).toBe(`edit ${suite}`);
    expect(edited.roleDescription).toBe("Second instruction.");
  });

  test("a coworker runs on instructions only, and holds no credential of its own", async () => {
    // The property that replaced key rotation: there is no key to rotate, so there is nothing for a
    // vault write inside the transaction to contend on.
    const [agentId] = created;
    expect(await liveCredentialsFor(agentId)).toHaveLength(0);
  });

  test("deleting the coworker returns on a pool of one connection too", async () => {
    const profile = await profiles.create(actor, {
      name: `deletion ${suite}`,
      title: "Tester",
      roleDescription: "Deleted before the deadline.",
      visibility: "private",
      systemPrompt: "An instruction.",
    });
    created.push(profile.id);

    await within("the deletion", profiles.softDelete(actor, profile.id));
    expect(await profiles.get(actor, profile.id)).toBeNull();
  });
});
