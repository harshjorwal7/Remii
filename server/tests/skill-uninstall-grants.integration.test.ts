import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  pluginGrants,
  skills,
  users,
} from "../src/db/schema";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});

const suite = randomUUID().slice(0, 8);
const alice = `user_alice_${suite}`;
const bob = `user_bob_${suite}`;
const aliceBot = `agent_alice_${suite}`;
const sharedBot = `agent_shared_${suite}`;
const personalSlug = `standup-${suite}`;
const keptSlug = `kept-${suite}`;
const deploymentSlug = `triage-${suite}`;

beforeAll(async () => {
  for (const id of [alice, bob]) {
    await database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: id })
      .onConflictDoNothing();
  }
  for (const [id, owner] of [
    [aliceBot, alice],
    [sharedBot, null],
  ] as const) {
    await database
      .insert(agents)
      .values({ id, name: id, type: "remote_ag_ui", configuration: {} })
      .onConflictDoNothing();
    await database
      .insert(agentProfiles)
      .values({
        agentId: id,
        ownerUserId: owner,
        title: id,
        roleDescription: "For a test.",
        avatarSeed: id,
        visibility: "private",
      })
      .onConflictDoNothing();
  }
});

afterAll(async () => {
  await database
    .delete(skills)
    .where(inArray(skills.slug, [personalSlug, keptSlug, deploymentSlug]));
  await database
    .delete(agents)
    .where(inArray(agents.id, [aliceBot, sharedBot]));
  await database.delete(users).where(inArray(users.id, [alice, bob]));
});

function routesAs(actor: { id: string; email: string; role: "user" }) {
  return createPluginRoutes(
    store as never,
    async (context, next) => {
      context.set("actor", actor as never);
      await next();
    },
    async () => true,
  );
}

const asAlice = () =>
  routesAs({ id: alice, email: `${alice}@example.test`, role: "user" });
const asBob = () =>
  routesAs({ id: bob, email: `${bob}@example.test`, role: "user" });
/*
 * A second ordinary person, standing in for "somebody who is not the owner".
 *
 * This used to be an administrator fixture with `role: "admin"`. There is no administrator: the role
 * is the literal `"user"`, so an admin actor cannot be constructed at all, and the guarantee this
 * file exists to check is stronger for it — a deployment skill is refused to EVERYONE, owner and
 * stranger alike, because there is no actor that could ever be handed it.
 */
const asStranger = () =>
  routesAs({
    id: `user_stranger_${suite}`,
    email: "stranger@example.test",
    role: "user",
  });

type Routes = ReturnType<typeof routesAs>;

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const writeSkill = (
  routes: Routes,
  slug: string,
  instructions: string,
  global = false,
) =>
  routes.request(
    "/skills",
    post({ slug, title: slug, instructions, ...(global ? { global } : {}) }),
  );

const grant = (routes: Routes, ref: string, agentId: string) =>
  routes.request("/grants", post({ kind: "skill", ref, agentId }));

const uninstall = (routes: Routes, slug: string) =>
  routes.request(`/skills/${slug}`, { method: "DELETE" });

const offered = async (routes: Routes, agentId: string) => {
  const body = (await (await routes.request(`/for/${agentId}`)).json()) as {
    skills: { slug: string; instructions: string }[];
  };
  return body.skills.map(({ slug, instructions }) => ({ slug, instructions }));
};

describe("a skill name written again after the skill was uninstalled", () => {
  test("a person's Bot does not take on the next author's instructions", async () => {
    expect(
      (await writeSkill(asAlice(), personalSlug, "Alice's standup.")).status,
    ).toBe(200);
    expect(
      (await writeSkill(asAlice(), keptSlug, "Alice's other skill.")).status,
    ).toBe(200);
    expect((await grant(asAlice(), personalSlug, aliceBot)).status).toBe(200);
    expect((await grant(asAlice(), keptSlug, aliceBot)).status).toBe(200);

    expect((await uninstall(asAlice(), personalSlug)).status).toBe(200);
    expect(
      (await writeSkill(asBob(), personalSlug, "Bob's words.")).status,
    ).toBe(200);
    expect((await grant(asBob(), personalSlug, aliceBot)).status).toBe(403);

    expect(await offered(asAlice(), aliceBot)).toEqual([
      { slug: keptSlug, instructions: "Alice's other skill." },
    ]);
  });

  test("a Bot the deployment shares does not take on a person's instructions", async () => {
    /*
     * A deployment skill is read-only for everyone, so the slug cannot be reused at all.
     *
     * There is no administrator in individual-user SaaS — `skillActor` carries an id and nothing
     * else, so no caller is ever privileged, which is why the seed below goes through the store
     * rather than `POST /skills`. That decision is what makes this test's guarantee total: nobody can uninstall
     * the package skill, nobody can rewrite it under the slug, and so the shared Bot keeps the
     * instructions the tenant package shipped no matter how many people try.
     *
     * Both refusals are asserted rather than assumed, because each one used to be permitted for
     * somebody and is exactly the way a shared Bot ends up answering with the last writer's words.
     */
    await store.installSkill({
      slug: deploymentSlug,
      title: "Triage",
      summary: "For a test.",
      instructions: "Triage by severity.",
      ownerUserId: null,
      by: "admin@example.test",
    });

    // Nobody may grant it: a deployment skill is not the asker's to hand out, owner included.
    expect((await grant(asStranger(), deploymentSlug, sharedBot)).status).toBe(
      403,
    );
    // Nobody may uninstall it, so there is no window in which the slug becomes writable.
    expect((await uninstall(asStranger(), deploymentSlug)).status).toBe(403);
    // And nobody may take the name for a personal skill.
    expect(
      (await writeSkill(asAlice(), deploymentSlug, "Alice's words.")).status,
    ).toBe(403);

    expect(await offered(asStranger(), sharedBot)).toEqual([]);
    expect(await offered(asAlice(), sharedBot)).toEqual([]);
  });

  test("uninstalling removes that skill's grants and no other", async () => {
    const held = await database
      .select({ ref: pluginGrants.ref, agentId: pluginGrants.agentId })
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "skill"),
          inArray(pluginGrants.agentId, [aliceBot, sharedBot]),
        ),
      );

    expect(held).toEqual([{ ref: keptSlug, agentId: aliceBot }]);
  });
});
