import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import {
  AgentNotFoundError,
  type AgentProfileStore,
  createAgentProfileStore,
  ManagedAgentUnavailableError,
  ProtectedAgentError,
} from "../src/agents/profile-store";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "../src/agents/profile-types";
import { DEPLOYMENT_ROUTES } from "../src/computer/deployment-routes";
import { createDatabase } from "../src/db/client";
import {
  agentPreferences,
  agentProfiles,
  agents,
  channelAgents,
  channels,
  deploymentPackages,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const managedAgentAgUiUrl = new URL("https://managed.example.test/ag-ui");
const store: AgentProfileStore = createAgentProfileStore(
  database,
  managedAgentAgUiUrl,
);
const testPrefix = `agent-profile-store-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdPackageIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const packageId of createdPackageIds.splice(0)) {
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.id, packageId));
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

async function createUser(role: AgentActor["role"] = "user") {
  const userId = id("user");
  await database.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    name: "Profile Store Test User",
  });
  createdUserIds.push(userId);
  return { id: userId, role } satisfies AgentActor;
}

async function createPackage() {
  const [deploymentPackage] = await database
    .insert(deploymentPackages)
    .values({
      tenantId: id("tenant"),
      sourcePath: "test/profile-store",
      checksum: randomUUID(),
    })
    .returning();
  if (!deploymentPackage) throw new Error("Expected deployment package.");
  createdPackageIds.push(deploymentPackage.id);
  return deploymentPackage;
}

async function createProfileFixture(options: {
  owner: AgentActor | null;
  visibility?: "public" | "private";
  packageId?: string;
  name?: string;
  title?: string;
  roleDescription?: string;
  avatarSeed?: string;
  configuration?: Record<string, unknown>;
}) {
  const agentId = id("seed-agent");
  const name = options.name ?? `Seed ${randomUUID()}`;
  const title = options.title ?? "Seed Assistant";
  const roleDescription = options.roleDescription ?? "Helps test profiles.";
  const avatarSeed = options.avatarSeed ?? `avatar-${randomUUID()}`;
  await database.insert(agents).values({
    id: agentId,
    name,
    type: "remote_ag_ui",
    configuration: options.configuration ?? {
      endpoint: "https://seed.example.test/ag-ui",
    },
    packageId: options.packageId,
  });
  createdAgentIds.push(agentId);
  await database.insert(agentProfiles).values({
    agentId,
    ownerUserId: options.owner?.id ?? null,
    title,
    roleDescription,
    avatarSeed,
    visibility: options.visibility ?? "private",
  });
  return { agentId, name, title, roleDescription, avatarSeed };
}

async function profileById(actor: AgentActor, agentId: string) {
  const profile = await store.get(actor, agentId);
  if (!profile) throw new Error(`Expected visible profile ${agentId}.`);
  return profile;
}

function expectListed(
  profiles: AgentProfile[],
  agentId: string,
  expected: boolean,
) {
  expect(profiles.some((profile) => profile.id === agentId)).toBe(expected);
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitForMutationBlock(
  applicationName: string,
  mutationSettled: () => boolean,
) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const blockedSessions = await database.execute(sql`
      SELECT pid
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND cardinality(pg_blocking_pids(pid)) > 0
      LIMIT 1
    `);
    if (blockedSessions.length > 0) return true;
    if (mutationSettled()) return false;
  }
  throw new Error(`Timed out observing blocked session ${applicationName}.`);
}

async function racePackageAttachment(
  agentId: string,
  packageId: string,
  mutate: (namedStore: AgentProfileStore) => Promise<unknown>,
) {
  const applicationName = `profile_store_lock_${randomUUID()}`;
  const namedDatabaseUrl = new URL(databaseUrl);
  namedDatabaseUrl.searchParams.set("application_name", applicationName);
  const namedDatabase = createDatabase(namedDatabaseUrl.toString(), TEST_POOL);
  const namedStore = createAgentProfileStore(
    namedDatabase,
    managedAgentAgUiUrl,
  );
  const writeAcquired = deferred();
  const releaseAttachment = deferred();
  const attachment = database.transaction(async (transaction) => {
    await transaction
      .update(agents)
      .set({ packageId })
      .where(eq(agents.id, agentId));
    writeAcquired.resolve();
    await releaseAttachment.promise;
  });
  void attachment.catch(writeAcquired.reject);

  try {
    await writeAcquired.promise;
    let settled = false;
    const outcomePromise = mutate(namedStore).then(
      (value) => {
        settled = true;
        return { status: "fulfilled", value } as const;
      },
      (reason: unknown) => {
        settled = true;
        return { reason, status: "rejected" } as const;
      },
    );
    const blocked = await waitForMutationBlock(applicationName, () => settled);
    releaseAttachment.resolve();
    await attachment;
    return { blocked, outcome: await outcomePromise };
  } finally {
    releaseAttachment.resolve();
    await attachment.catch(() => undefined);
    await namedDatabase.$client.close();
  }
}

/**
 * The stored row behind a coworker, proven to exist before anything reads it.
 *
 * Asserted here rather than at each call site because a missing row and a missing field are
 * different failures that an optional chain would collapse into the same one — "systemPrompt is
 * undefined" reads as a prompt that was not written when it may be a coworker that is not there.
 */
async function agentRow(agentId: string): Promise<{
  type: string;
  configuration: { systemPrompt?: string; endpoint?: string };
}> {
  const [row] = await database
    .select({ type: agents.type, configuration: agents.configuration })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!row) throw new Error(`no agents row for ${agentId}`);
  return {
    type: row.type,
    configuration: (row.configuration ?? {}) as {
      systemPrompt?: string;
      endpoint?: string;
    },
  };
}

describe("agent profile store integration", () => {
  test("refuses to create a coworker with no endpoint when this deployment has no managed Bot", async () => {
    const owner = await createUser();
    const withoutManaged = createAgentProfileStore(database, undefined);

    await expect(
      withoutManaged.create(owner, {
        name: "No Endpoint",
        title: "Needs an address",
        roleDescription: "Should not land on a missing Bot.",
        visibility: "private",
      }),
    ).rejects.toBeInstanceOf(ManagedAgentUnavailableError);
  });

  /**
   * The coworker with nowhere to send it, and the instruction it actually runs on.
   *
   * `registeredAgentFromRow` gives a `built_in` agent its `configuration.systemPrompt` and NO
   * standing role message, so that column is the whole of what such a coworker is ever told —
   * `agentProfiles.roleDescription` never reaches it. These two tests exist because the pair can
   * drift silently: creating writes both, and an edit that wrote only the profile left every screen
   * showing new instructions while the Bot went on following the old ones, for good, with nothing
   * anywhere to say so.
   */
  test("creates a coworker that runs here when there is nowhere to send it", async () => {
    const owner = await createUser();
    const withoutManaged = createAgentProfileStore(database, undefined);

    const created = await withoutManaged.create(owner, {
      name: "Runs Here",
      title: "Everyday Work",
      roleDescription: "Answer from the ledger and quote the line you used.",
      visibility: "private",
      systemPrompt: "Answer from the ledger and quote the line you used.",
    });
    createdAgentIds.push(created.id);

    const row = await agentRow(created.id);
    expect(row.type).toBe("built_in");
    expect(row.configuration.systemPrompt).toBe(
      "Answer from the ledger and quote the line you used.",
    );
    // No address was given and none was invented; that is what makes it built_in rather than remote.
    expect(row.configuration.endpoint).toBeUndefined();
  });

  test("an edit moves the instruction such a coworker actually runs on", async () => {
    const owner = await createUser();
    const withoutManaged = createAgentProfileStore(database, undefined);
    const created = await withoutManaged.create(owner, {
      name: "Runs Here",
      title: "Everyday Work",
      roleDescription: "The first instruction.",
      visibility: "private",
      systemPrompt: "The first instruction.",
    });
    createdAgentIds.push(created.id);

    await withoutManaged.update(owner, created.id, {
      name: "Runs Here",
      title: "Everyday Work",
      roleDescription: "The second instruction, which must be the live one.",
      visibility: "private",
    });

    const row = await agentRow(created.id);
    expect(row.type).toBe("built_in");
    expect(row.configuration.systemPrompt).toBe(
      "The second instruction, which must be the live one.",
    );
    // And the profile every screen reads agrees with it, rather than only the profile moving.
    expect((await profileById(owner, created.id)).roleDescription).toBe(
      "The second instruction, which must be the live one.",
    );
  });

  /**
   * The other half of the same rule: a coworker reached over AG-UI must not acquire a prompt it never
   * had.
   *
   * Its instruction travels as the standing role message built from the profile, so a `systemPrompt`
   * appearing in its configuration would be a second source for the same thing — and the one the
   * runtime prefers for a `built_in` row, which is what this coworker would look like if its type
   * ever changed. The deployment's own Bot is reached this way too, which is why the branch keys on
   * the stored type rather than on whether the endpoint happens to be ours.
   */
  test("an edit never gives a coworker reached over AG-UI a system prompt", async () => {
    const owner = await createUser();
    const source = await createProfileFixture({
      owner,
      visibility: "private",
      configuration: { endpoint: "https://remote.example.test/ag-ui" },
    });

    await store.update(owner, source.agentId, {
      name: "Still Remote",
      title: "Elsewhere",
      roleDescription: "Edited, and it still runs at its own address.",
      visibility: "private",
    });

    const row = await agentRow(source.agentId);
    expect(row.type).toBe("remote_ag_ui");
    expect(row.configuration.systemPrompt).toBeUndefined();
  });

  test("a create on a deployment with no Bot of its own runs the coworker here, on its role", async () => {
    /*
     * The fallback that keeps the recommended one-container image usable. With nothing to bind to, the
     * create used to be refused outright, so a person could not make a coworker at all on the image
     * the README tells them to deploy. The role description is what such a coworker runs on — the
     * same shape a `built_in` Bot in the tenant package carries, for the same purpose.
     */
    const withoutEngine = createAgentProfileStore(database, undefined);
    const owner = await createUser();

    const created = await withoutEngine.create(owner, {
      name: `Created ${randomUUID()}`,
      title: "Created Title",
      roleDescription: "Runs on these instructions.",
      visibility: "private",
      systemPrompt: "Runs on these instructions.",
    });
    createdAgentIds.push(created.id);

    expect(created.endpoint).toBeNull();
    const row = await agentRow(created.id);
    expect(row.type).toBe("built_in");
    expect(row.configuration.systemPrompt).toBe("Runs on these instructions.");
  });

  test("refuses a create with neither an engine nor an instruction to run on", async () => {
    // Nothing to create: a `built_in` row with an empty prompt is a coworker
    // `registeredAgentFromRow` drops on the floor, and the Bot would exist on every screen while
    // answering nobody.
    const withoutEngine = createAgentProfileStore(database, undefined);
    const owner = await createUser();

    await expect(
      withoutEngine.create(owner, {
        name: `Created ${randomUUID()}`,
        title: "Created Title",
        roleDescription: "",
        visibility: "private",
      } as CreateAgentInput),
    ).rejects.toBeInstanceOf(ManagedAgentUnavailableError);
  });

  test("lets an owner get and list a private profile but hides it from another user", async () => {
    /*
     * WAS "lets an owner and admin ...", asserting the admin could read somebody else's private
     * profile. There is no administrator override in this deployment — `accessFilter` admits a row
     * when it is the caller's own or has no owner at all — so the admin was refused like anybody
     * else and the assertion failed.
     *
     * The admin is kept in the fixture rather than deleted, because the interesting part is now
     * exactly that the ROLE grants nothing: a caller whose actor says `admin` and a caller that does
     * not get the same answer, which is the property that replaced the override.
     */
    const owner = await createUser();
    const other = await createUser();
    const admin = await createUser("admin");
    const source = await createProfileFixture({ owner, visibility: "private" });

    expect((await profileById(owner, source.agentId)).id).toBe(source.agentId);
    // An actor carrying `role: "admin"` sees exactly what any other non-owner sees.
    expect(await store.get(admin, source.agentId)).toBeNull();
    expect(await store.get(other, source.agentId)).toBeNull();
    expectListed(await store.list(owner), source.agentId, true);
    expectListed(await store.list(admin), source.agentId, false);
    expectListed(await store.list(other), source.agentId, false);
  });

  test("stores hiding per user and moves the caller between default and hidden lists", async () => {
    const owner = await createUser();
    const _other = await createUser();
    /*
     * Private, and owned, rather than public.
     *
     * Public sharing was removed, so a row marked public is now nobody else's business — but that is
     * not what this case is about. It is about hiding being PER BOT and PER CALLER, and with sharing
     * gone the only caller who can see this row is its owner. So the caller hides one Bot and not the
     * other, which is the assertion that actually needs making: one preference row cannot move the
     * rest of the list.
     *
     * A caller who cannot see a Bot cannot hide it either — `setHidden` goes through the same
     * accessibility filter as a read and throws rather than writing a preference nothing will consult.
     * That is a separate case, and asserting it here would only obscure which half failed.
     */
    const source = await createProfileFixture({ owner, visibility: "private" });
    const second = await createProfileFixture({ owner, visibility: "private" });

    expectListed(await store.list(owner), source.agentId, true);
    expectListed(await store.list(owner, true), source.agentId, false);

    // Hiding one Bot leaves the other in the default list — the preference is keyed on the Bot, not
    // on the caller, so one row cannot hide the rest.
    await store.setHidden(owner, source.agentId, true);
    expectListed(await store.list(owner), source.agentId, false);
    expectListed(await store.list(owner, true), source.agentId, true);
    expectListed(await store.list(owner), second.agentId, true);
    expectListed(await store.list(owner, true), second.agentId, false);

    await store.setHidden(owner, source.agentId, false);
    expectListed(await store.list(owner), source.agentId, true);
    expectListed(await store.list(owner, true), source.agentId, false);
    const [preference] = await database
      .select()
      .from(agentPreferences)
      .where(
        and(
          eq(agentPreferences.userId, owner.id),
          eq(agentPreferences.agentId, source.agentId),
        ),
      );
    expect(preference?.hiddenAt).toBeNull();
  });

  test("ignores every field a caller must not set, the address among them", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({
      owner,
      visibility: "private",
      configuration: { endpoint: "https://preserved.example.test/ag-ui" },
    });
    const oldTimestamp = new Date("2000-01-01T00:00:00.000Z");
    await database
      .update(agents)
      .set({ updatedAt: oldTimestamp })
      .where(eq(agents.id, source.agentId));
    await database
      .update(agentProfiles)
      .set({ updatedAt: oldTimestamp })
      .where(eq(agentProfiles.agentId, source.agentId));

    const result = await store.update(owner, source.agentId, {
      name: "Renamed Assistant",
      title: "Updated Title",
      roleDescription: "Updated role description.",
      // `public` in a hostile payload, and it does not become one: public sharing was removed, so
      // every read above coerces the column to `private` rather than returning what is stored. The
      // field is left in this payload on purpose — it is one more thing a caller must not be able to
      // set, and the assertions below are that nothing else in this payload lands either.
      visibility: "public",
      id: "forged-id",
      // The address and the key are NOT editable, and are what this assertion is really about. A
      // coworker runs where this deployment runs it and authenticates with the deployment's own token,
      // so a saved form that could repoint one or attach a credential would let anybody move a Bot to
      // an address of their choosing. Both are left in this hostile payload on purpose: the route
      // refuses them before the store is reached, and the store ignores them if it ever is.
      endpoint: "https://moved.example.test/ag-ui",
      auth: { header: "Authorization", value: "Bearer sk-do-not-log" },
      ownerUserId: "forged-owner",
      avatarSeed: "forged-avatar",
      packageId: deploymentPackage.id,
      deletedAt: new Date(),
    } as unknown as CreateAgentInput);

    expect(result).toMatchObject({
      id: source.agentId,
      name: "Renamed Assistant",
      title: "Updated Title",
      roleDescription: "Updated role description.",
      visibility: "private",
      ownerUserId: owner.id,
      avatarSeed: source.avatarSeed,
      systemOwned: false,
      deletedAt: null,
    });
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, source.agentId));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, source.agentId));
    expect(canonical).toMatchObject({
      id: source.agentId,
      name: "Renamed Assistant",
      type: "remote_ag_ui",
      // Untouched: the coworker still runs where this deployment runs it, and no key of the caller's
      // was stored beside it.
      configuration: { endpoint: "https://preserved.example.test/ag-ui" },
      packageId: null,
    });
    expect(profile).toMatchObject({
      ownerUserId: owner.id,
      title: "Updated Title",
      roleDescription: "Updated role description.",
      avatarSeed: source.avatarSeed,
      /*
       * `public` IN THE COLUMN, which is the assertion to keep here — this is a raw read of
       * `agent_profiles`, and the store wrote what it was given.
       *
       * The coercion is on the way OUT, in `mapProfile`, which returns `visibility: "private"`
       * whatever the column says, so a public value can sit on old rows without ever leaving the
       * server as one. The returned profile above asserts that half; this one asserts the column is
       * not what was supposed to protect anybody, and that `deletedAt` did not move.
       */
      visibility: "public",
      deletedAt: null,
    });
    expect(canonical?.updatedAt.getTime()).toBeGreaterThan(
      oldTimestamp.getTime(),
    );
    expect(profile?.updatedAt.getTime()).toBeGreaterThan(
      oldTimestamp.getTime(),
    );
  });

  /*
   * WAS "rejects public non-owner mutation as unmanageable and inaccessible private mutation as
   * absent": two fixtures whose ONLY difference was `visibility`, giving a non-owner two different
   * refusals — "you could manage this but may not" against "this does not exist".
   *
   * That distinction was the oracle `accessFilter` exists to close, and public sharing is gone, so
   * the two columns now differ in nothing a caller can reach. There is one answer for a row that is
   * somebody else's: absent. The row marked `public` is still created here, because that a row can
   * CARRY the value while nothing reads it as one is the property that matters, and it is what makes
   * the single refusal below safe.
   */
  test("refuses a non-owner's mutation of any visibility as absent", async () => {
    const owner = await createUser();
    const other = await createUser();
    const publicSource = await createProfileFixture({
      owner,
      visibility: "public",
    });
    const privateSource = await createProfileFixture({
      owner,
      visibility: "private",
    });
    const input: CreateAgentInput = {
      name: "Other Name",
      title: "Other Title",
      roleDescription: "Other role.",
      visibility: "public",
    };

    for (const source of [publicSource, privateSource]) {
      await expect(
        store.update(other, source.agentId, input),
      ).rejects.toBeInstanceOf(AgentNotFoundError);
      await expect(
        store.setHidden(other, source.agentId, true),
      ).rejects.toBeInstanceOf(AgentNotFoundError);
      // And it is absent from the non-owner's lists too, however the row was written.
      expectListed(await store.list(other), source.agentId, false);
      expectListed(await store.list(other, true), source.agentId, false);
    }
  });

  test("rejects update and soft delete for a package-backed profile", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({
      owner,
      packageId: deploymentPackage.id,
    });
    const input: CreateAgentInput = {
      name: "Protected Rename",
      title: "Protected Title",
      roleDescription: "Protected role.",
      visibility: "public",
    };

    const profile = await profileById(owner, source.agentId);
    expect(profile.systemOwned).toBe(true);
    await expect(
      store.update(owner, source.agentId, input),
    ).rejects.toBeInstanceOf(ProtectedAgentError);
    await expect(
      store.softDelete(owner, source.agentId),
    ).rejects.toBeInstanceOf(ProtectedAgentError);
  });

  test("serializes update authorization against concurrent package attachment", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({
      owner,
      name: "Original Name",
      title: "Original Title",
      roleDescription: "Original role.",
    });

    const { blocked, outcome } = await racePackageAttachment(
      source.agentId,
      deploymentPackage.id,
      (namedStore) =>
        namedStore.update(owner, source.agentId, {
          name: "Racing Rename",
          title: "Racing Title",
          roleDescription: "Racing role.",
          visibility: "public",
        }),
    );

    expect(outcome.status).toBe("rejected");
    expect(blocked).toBe(true);
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(ProtectedAgentError);
    }
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, source.agentId));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, source.agentId));
    expect(canonical?.name).toBe(source.name);
    expect(canonical?.packageId).toBe(deploymentPackage.id);
    expect(profile).toMatchObject({
      deletedAt: null,
      roleDescription: source.roleDescription,
      title: source.title,
      visibility: "private",
    });
  });

  test("serializes soft-delete authorization against concurrent package attachment", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({ owner });

    const { blocked, outcome } = await racePackageAttachment(
      source.agentId,
      deploymentPackage.id,
      (namedStore) => namedStore.softDelete(owner, source.agentId),
    );

    expect(outcome.status).toBe("rejected");
    expect(blocked).toBe(true);
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(ProtectedAgentError);
    }
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, source.agentId));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, source.agentId));
    expect(canonical?.packageId).toBe(deploymentPackage.id);
    expect(profile?.deletedAt).toBeNull();
  });

  /*
   * WAS "allows an admin to update and soft delete a user-owned profile". There is no administrator
   * override in this deployment, so an actor carrying `role: "admin"` reaches a user-owned Bot
   * exactly as any other non-owner does — the call threw rather than returning the renamed profile.
   *
   * The admin is kept in the fixture rather than dropped, because the property that replaced the
   * override is precisely that the ROLE confers nothing: same caller shape, same refusal. A test that
   * simply removed the admin would not notice a future `role === "admin"` special case coming back.
   */
  test("refuses an admin an update and a soft delete of a user-owned profile", async () => {
    const owner = await createUser();
    const admin = await createUser("admin");
    const source = await createProfileFixture({ owner });

    await expect(
      store.update(admin, source.agentId, {
        name: "Admin Rename",
        title: "Admin Title",
        roleDescription: "Admin role update.",
        visibility: "private",
      }),
    ).rejects.toBeInstanceOf(AgentNotFoundError);

    await expect(
      store.softDelete(admin, source.agentId),
    ).rejects.toBeInstanceOf(AgentNotFoundError);

    // Still standing and still owned by the person who made it.
    expect((await profileById(owner, source.agentId)).ownerUserId).toBe(
      owner.id,
    );
  });

  test("duplicates a profile as a caller-owned private agent with copied presentation fields", async () => {
    const owner = await createUser();
    const source = await createProfileFixture({
      owner,
      visibility: "public",
      name: "Source Name",
      title: "Source Title",
      roleDescription: "Source role.",
      avatarSeed: "source-avatar",
    });
    await store.setHidden(owner, source.agentId, true);

    const duplicate = await store.duplicate(owner, source.agentId);

    expect(duplicate.id).toMatch(
      /^agent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(duplicate).toMatchObject({
      name: source.name,
      title: source.title,
      roleDescription: source.roleDescription,
      avatarSeed: source.avatarSeed,
      visibility: "private",
      ownerUserId: owner.id,
      systemOwned: false,
      hidden: false,
      deletedAt: null,
    });
    expect(duplicate.id).not.toBe(source.agentId);
    createdAgentIds.push(duplicate.id);
    const duplicatePreferences = await database
      .select()
      .from(agentPreferences)
      .where(eq(agentPreferences.agentId, duplicate.id));
    expect(duplicatePreferences).toHaveLength(0);
  });

  test("duplicates no channel membership or Intelligence mapping from the source", async () => {
    const owner = await createUser();
    // Private, not public: public sharing was removed, so a row marked public is visible to no one
    // but its owner and the assertion below would be reading an unreachable row.
    const source = await createProfileFixture({ owner, visibility: "private" });
    const channelId = id("channel");
    await database.insert(channels).values({
      id: channelId,
      name: "Source channel",
      description: "Links source agent to Intelligence.",
    });
    await database.insert(channelAgents).values({
      channelId,
      agentId: source.agentId,
    });
    await database.insert(intelligenceChannelMappings).values({
      userId: owner.id,
      channelId,
      threadId: id("thread"),
    });
    createdChannelIds.push(channelId);

    const duplicate = await store.duplicate(owner, source.agentId);
    createdAgentIds.push(duplicate.id);

    const sourceMappings = await database
      .select()
      .from(channelAgents)
      .innerJoin(
        intelligenceChannelMappings,
        eq(channelAgents.channelId, intelligenceChannelMappings.channelId),
      )
      .where(eq(channelAgents.agentId, source.agentId));
    const duplicateMappings = await database
      .select()
      .from(channelAgents)
      .innerJoin(
        intelligenceChannelMappings,
        eq(channelAgents.channelId, intelligenceChannelMappings.channelId),
      )
      .where(eq(channelAgents.agentId, duplicate.id));
    const duplicateChannelAgents = await database
      .select()
      .from(channelAgents)
      .where(eq(channelAgents.agentId, duplicate.id));
    expect(sourceMappings).not.toHaveLength(0);
    expect(duplicateChannelAgents).toHaveLength(0);
    expect(duplicateMappings).toHaveLength(0);
  });

  test("a copy carries the source's address and no key of its own", async () => {
    /*
     * The address half is load-bearing: a package row registered against the Bot this deployment ships
     * in the box, or a harness chosen at setup, is copied to run where its source ran rather than
     * being repointed at whatever this deployment happens to run now.
     *
     * The key half is the floor that is left. Two coworkers sharing one credential would mean rotating
     * either one's key silently changed the other's, and nobody can supply one any more, so this is
     * now only reachable by writing the configuration directly.
     */
    const owner = await createUser();
    const source = await createProfileFixture({
      owner,
      configuration: {
        endpoint: "https://hosted.example.test/ag-ui",
        auth: { header: "Authorization", credentialId: "credential-1" },
      },
    });

    const duplicate = await store.duplicate(owner, source.agentId);
    createdAgentIds.push(duplicate.id);

    expect(duplicate.endpoint).toBe("https://hosted.example.test/ag-ui");
    const row = await agentRow(duplicate.id);
    expect(row.configuration.auth).toBeUndefined();
  });

  test("copies the source's own address rather than repointing the copy at the deployment's Bot", async () => {
    // Package-supplied rows keep their addresses: the Bot this deployment ships in the box and a
    // harness chosen at setup are both registered that way, from configuration.
    const owner = await createUser();
    const source = await createProfileFixture({
      owner,
      configuration: { endpoint: "https://hosted.example.test/ag-ui" },
    });

    const duplicate = await store.duplicate(owner, source.agentId);
    createdAgentIds.push(duplicate.id);

    expect(duplicate.endpoint).toBe("https://hosted.example.test/ag-ui");
    expect(duplicate.endpoint).not.toBe(managedAgentAgUiUrl.toString());
  });

  test("a create writes the deployment's address, never one the caller supplied", async () => {
    const owner = await createUser();

    const created = await store.create(owner, {
      name: `Created ${randomUUID()}`,
      title: "Created Title",
      roleDescription: "Created role description.",
      visibility: "private",
      // A hostile payload that reaches the store directly, past the route that refuses it.
      endpoint: "https://attacker.example.test/ag-ui",
      auth: { header: "Authorization", value: "Bearer sk-do-not-log" },
    } as unknown as CreateAgentInput);
    createdAgentIds.push(created.id);

    expect(created.endpoint).toBe(managedAgentAgUiUrl.toString());
    // And no key of the caller's is stored beside it, however the payload was built.
    const row = await agentRow(created.id);
    expect(row.configuration.auth).toBeUndefined();
  });

  test("gives a copy of a prompt-running source the deployment's Bot when it has none of its own", async () => {
    const owner = await createUser();
    const created = await store.create(owner, {
      name: `Created ${randomUUID()}`,
      title: "Created Title",
      roleDescription: "Created role description.",
      visibility: "private",
    } as CreateAgentInput);
    createdAgentIds.push(created.id);

    const duplicate = await store.duplicate(owner, created.id);
    createdAgentIds.push(duplicate.id);

    expect(duplicate.endpoint).toBe(managedAgentAgUiUrl.toString());
  });

  /*
   * WAS "does not carry the source's stored key onto the copy", and it went with the feature rather
   * than with a rename: a coworker could be pointed at an address a person supplied and sit behind a
   * bearer key of theirs, and two coworkers sharing one credential would have meant rotating either
   * one's key silently changing the other's. Nobody can supply either now, so a copy has nothing to
   * carry and there is nothing here left to guard.
   */

  test("duplicates a coworker at its own address on a deployment with no Bot of its own", async () => {
    const withoutEngine = createAgentProfileStore(database, undefined);
    const owner = await createUser();
    const source = await createProfileFixture({
      owner,
      configuration: { endpoint: "https://hosted.example.test/ag-ui" },
    });

    const duplicate = await withoutEngine.duplicate(owner, source.agentId);
    createdAgentIds.push(duplicate.id);

    expect(duplicate.endpoint).toBe("https://hosted.example.test/ag-ui");
  });

  test("refuses to duplicate a coworker with neither an address nor a prompt to fall back to", async () => {
    const withoutEngine = createAgentProfileStore(database, undefined);
    const owner = await createUser();
    const source = await createProfileFixture({
      owner,
      configuration: {},
    });

    await expect(
      withoutEngine.duplicate(owner, source.agentId),
    ).rejects.toBeInstanceOf(ManagedAgentUnavailableError);
  });

  test("soft deletes a profile from reads and lists while retaining its raw rows", async () => {
    const owner = await createUser();
    // Private, not public: public sharing was removed, so a row marked public is visible to no one
    // but its owner and the assertion below would be reading an unreachable row.
    const source = await createProfileFixture({ owner, visibility: "private" });

    await store.softDelete(owner, source.agentId);

    expect(await store.get(owner, source.agentId)).toBeNull();
    expectListed(await store.list(owner), source.agentId, false);
    expectListed(await store.list(owner, true), source.agentId, false);
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, source.agentId));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, source.agentId));
    expect(canonical?.id).toBe(source.agentId);
    expect(profile?.agentId).toBe(source.agentId);
    expect(profile?.deletedAt).toBeInstanceOf(Date);
    await expect(
      store.setHidden(owner, source.agentId, true),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  test("rolls back canonical creation when the profile insert fails", async () => {
    const owner = await createUser();
    const name = `Rollback ${randomUUID()}`;

    await expect(
      store.create(owner, {
        name,
        title: null,
        roleDescription: "This profile insert must fail.",
        visibility: "public",
      } as unknown as CreateAgentInput),
    ).rejects.toThrow();
    const rows = await database
      .select()
      .from(agents)
      .where(eq(agents.name, name));
    expect(rows).toHaveLength(0);
  });

  /*
   * The id a caller gets is never one they chose.
   *
   * The reserved-id checks in `tenant-package.ts` rest on this: a package is the only place a Bot id
   * is written by a person, so refusing the reserved names there closes them everywhere. The day
   * this route lets a caller name their own Bot, that stops being true, and this is the test that
   * says so rather than the reader who happens to notice.
   */
  test("mints its own id rather than taking one, for a create and for a copy", async () => {
    const owner = await createUser();
    const created = await store.create(owner, {
      name: `Created ${randomUUID()}`,
      title: "Created Title",
      roleDescription: "Created role description.",
      visibility: "private",
    } as CreateAgentInput);
    createdAgentIds.push(created.id);
    const copy = await store.duplicate(owner, created.id);
    createdAgentIds.push(copy.id);

    for (const id of [created.id, copy.id]) {
      expect(id).toMatch(
        /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(DEPLOYMENT_ROUTES.has(id)).toBe(false);
    }
  });

  /*
   * Private whatever was asked for. Public sharing was removed, so `mapProfile` returns
   * `visibility: "private"` for every row — and this asks for `public` on purpose, because that the
   * requested value is IGNORED rather than merely that private is stored is the property: a caller
   * that asks to share a Bot broadly must not be able to.
   */
  test("creates a caller-owned remote AG-UI profile that is private whatever was requested", async () => {
    const owner = await createUser();
    const input: CreateAgentInput = {
      name: `Created ${randomUUID()}`,
      title: "Created Title",
      roleDescription: "Created role description.",
      visibility: "public",
    };

    const created = await store.create(owner, input);
    createdAgentIds.push(created.id);

    expect(created).toMatchObject({
      name: input.name,
      title: input.title,
      roleDescription: input.roleDescription,
      avatarSeed: created.id,
      visibility: "private",
      ownerUserId: owner.id,
      systemOwned: false,
      hidden: false,
      deletedAt: null,
    });
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, created.id));
    expect(canonical).toMatchObject({
      id: created.id,
      name: input.name,
      type: "remote_ag_ui",
      configuration: { endpoint: managedAgentAgUiUrl.toString() },
      packageId: null,
    });
  });
});
