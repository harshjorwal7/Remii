import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { standingRoleMessage } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const managedEndpoint = new URL("https://managed.example.test/ag-ui");
const mastraManagedEndpoint = new URL("https://managed.example.test/mastra");
const profileStore = createAgentProfileStore(database, managedEndpoint);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const managedAgentToken = "managed-agent-token";
const loadAgents = createRuntimeAgentLoader(database, {
  endpoint: managedEndpoint,
  token: managedAgentToken,
  alsoRun: mastraManagedEndpoint,
});

const testPrefix = `runtime-agents-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser(role: AgentActor["role"] = "user") {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Runtime Agents Test User",
  });
  createdUserIds.push(id);
  return { id, role } satisfies AgentActor;
}

async function createCoworker(
  owner: AgentActor,
  overrides: { name?: string; visibility?: "public" | "private" } = {},
) {
  const profile = await profileStore.create(owner, {
    name: overrides.name ?? "Expense Manager",
    title: "Finance Operations",
    roleDescription:
      "Review receipts, categorize expenses, and prepare reimbursement reports.",
    visibility: overrides.visibility ?? "private",
  });
  createdAgentIds.push(profile.id);
  return profile;
}

async function setAgentRun(
  id: string,
  run: {
    type: "remote_ag_ui" | "remote_mastra";
    configuration: Record<string, unknown>;
  },
) {
  await database.update(agents).set(run).where(eq(agents.id, id));
}

function idsOf(loaded: Awaited<ReturnType<typeof loadAgents>>) {
  return loaded.map((agent) => agent.id);
}

/**
 * Which coworkers exist is a per-person question, answered on every request. These assertions are
 * against the database rather than a fake, because the whole point of resolving here is that the
 * filtering happens in the query and not in JavaScript after every row has already been read.
 */
describe("runtime agent loading", () => {
  test("carries the owner's coworker with its standing role and managed endpoint", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);

    const loaded = await loadAgents(owner);

    expect(loaded).toContainEqual({
      id: profile.id,
      name: "Expense Manager",
      type: "remote_ag_ui",
      endpoint: managedEndpoint.toString(),
      headers: { "x-remii-agent-token": managedAgentToken },
      standingMessage: standingRoleMessage({
        id: profile.id,
        name: "Expense Manager",
        title: "Finance Operations",
        roleDescription:
          "Review receipts, categorize expenses, and prepare reimbursement reports.",
      }),
    });
  });

  test("carries the managed deployment token to a Mastra endpoint this deployment runs", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);
    await setAgentRun(profile.id, {
      type: "remote_mastra",
      configuration: {
        endpoint: mastraManagedEndpoint.toString(),
        remoteAgentId: "remii",
      },
    });

    const loaded = await loadAgents(owner);

    expect(loaded).toContainEqual({
      id: profile.id,
      name: "Expense Manager",
      type: "remote_mastra",
      endpoint: mastraManagedEndpoint.toString(),
      remoteAgentId: "remii",
      headers: { "x-remii-agent-token": managedAgentToken },
      standingMessage: standingRoleMessage({
        id: profile.id,
        name: "Expense Manager",
        title: "Finance Operations",
        roleDescription:
          "Review receipts, categorize expenses, and prepare reimbursement reports.",
      }),
    });
  });

  /*
   * WAS "resolves vault auth headers for a Mastra endpoint that names a credential", and it went with
   * the feature rather than with a rename.
   *
   * A Bot could be pointed at an address a person supplied and sit behind a bearer key of theirs,
   * read from the vault on every load so a revocation took effect on the next run rather than the
   * next restart. Neither half exists now: nobody can supply an address or a key, so the only
   * credential on a run is the deployment's own token, and only for an endpoint this deployment runs.
   *
   * The row below is written straight into `agents.configuration`, which is the only way an address
   * that is not ours can still exist — a package-supplied row is registered the same way. So this
   * asserts the floor that is left: an address we do not run gets no credential of ours, ever.
   */
  test("carries no credential for an endpoint this deployment does not run", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner, { name: "Research Mastra" });
    await setAgentRun(profile.id, {
      type: "remote_mastra",
      configuration: {
        endpoint: "https://elsewhere.example.test",
        remoteAgentId: "research",
      },
    });

    const loaded = await loadAgents(owner);

    const row = loaded.find((agent) => agent.id === profile.id) as
      | { type?: string; endpoint?: string; headers?: Record<string, string> }
      | undefined;
    expect(row?.type).toBe("remote_mastra");
    expect(row?.endpoint).toBe("https://elsewhere.example.test");
    // The whole point: the deployment token is for endpoints this deployment runs, and this is not
    // one of them, so the call carries no credential of ours at all.
    expect(row?.headers).toBeUndefined();
  });

  /*
   * WAS "hides a private coworker from everybody but its owner and administrators" — the last actor
   * was an administrator, who could see it — and "shares a public coworker with everybody".
   *
   * Neither holds now. Public sharing was removed, so the loader's filter admits a row on `systemOwned`
   * or `ownerUserId`, and `visibility` is not part of the decision: a public row is the owner's and
   * nobody else's. And there is no administrator override, so an actor carrying `role: "admin"` is
   * refused exactly as any other non-owner is.
   *
   * The admin is still created in the first case, because "the role confers nothing" is the property
   * that replaced the override and a test that simply dropped the actor would not notice it returning.
   */
  test("hides a private coworker from everybody but its owner", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const administrator = await createUser("admin");
    const profile = await createCoworker(owner);

    expect(idsOf(await loadAgents(owner))).toContain(profile.id);
    for (const actor of [otherUser, administrator]) {
      expect(idsOf(await loadAgents(actor))).not.toContain(profile.id);
    }
  });

  test("a public coworker is still only its owner's", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const profile = await createCoworker(owner, {
      name: "Company Helper",
      visibility: "public",
    });

    expect(idsOf(await loadAgents(owner))).toContain(profile.id);
    expect(idsOf(await loadAgents(otherUser))).not.toContain(profile.id);
  });

  test("drops a deleted coworker that has no history to restore", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);

    await profileStore.softDelete(owner, profile.id);

    expect(idsOf(await loadAgents(owner))).not.toContain(profile.id);
  });

  test("keeps a deleted coworker as a tombstone for a channel member", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const profile = await createCoworker(owner);
    const channel = await channelStore.create(owner, [profile.id]);
    createdChannelIds.push(channel.id);

    await profileStore.softDelete(owner, profile.id);

    expect(await loadAgents(owner)).toContainEqual({
      id: profile.id,
      name: "Expense Manager",
      type: "unavailable",
      reason:
        "Expense Manager has been deleted and can no longer run. Its conversations remain readable.",
    });
    // Somebody with no channel of their own gets no tombstone: history is what authorizes it.
    expect(idsOf(await loadAgents(otherUser))).not.toContain(profile.id);
  });

  test("authorizes deleted coworker tombstones only through live channels", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const deletedOnlyProfile = await createCoworker(owner, {
      name: "Deleted Only Helper",
    });
    const preservedProfile = await createCoworker(owner, {
      name: "Preserved Helper",
    });
    const deletedOnlyChannel = await channelStore.create(owner, [
      deletedOnlyProfile.id,
    ]);
    const deletedPreservedChannel = await channelStore.create(owner, [
      preservedProfile.id,
    ]);
    const livePreservedChannel = await channelStore.create(owner, [
      preservedProfile.id,
    ]);
    createdChannelIds.push(
      deletedOnlyChannel.id,
      deletedPreservedChannel.id,
      livePreservedChannel.id,
    );

    await profileStore.softDelete(owner, deletedOnlyProfile.id);
    await profileStore.softDelete(owner, preservedProfile.id);
    await channelStore.softDelete(owner, deletedOnlyChannel.id);
    await channelStore.softDelete(owner, deletedPreservedChannel.id);

    const retainedDeletedOnlyRows = await database
      .select({
        channelDeletedAt: channels.deletedAt,
        memberUserId: channelMemberships.userId,
        agentId: channelAgents.agentId,
        profileDeletedAt: agentProfiles.deletedAt,
      })
      .from(channels)
      .innerJoin(
        channelMemberships,
        eq(channelMemberships.channelId, channels.id),
      )
      .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
      .innerJoin(
        agentProfiles,
        eq(agentProfiles.agentId, channelAgents.agentId),
      )
      .where(eq(channels.id, deletedOnlyChannel.id));
    expect(retainedDeletedOnlyRows).toHaveLength(1);
    expect(retainedDeletedOnlyRows[0]).toMatchObject({
      memberUserId: owner.id,
      agentId: deletedOnlyProfile.id,
    });
    expect(retainedDeletedOnlyRows[0]?.channelDeletedAt).toBeInstanceOf(Date);
    expect(retainedDeletedOnlyRows[0]?.profileDeletedAt).toBeInstanceOf(Date);

    const retainedLivePreservedRows = await database
      .select({
        channelDeletedAt: channels.deletedAt,
        memberUserId: channelMemberships.userId,
        agentId: channelAgents.agentId,
        profileDeletedAt: agentProfiles.deletedAt,
      })
      .from(channels)
      .innerJoin(
        channelMemberships,
        eq(channelMemberships.channelId, channels.id),
      )
      .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
      .innerJoin(
        agentProfiles,
        eq(agentProfiles.agentId, channelAgents.agentId),
      )
      .where(eq(channels.id, livePreservedChannel.id));
    expect(retainedLivePreservedRows).toHaveLength(1);
    expect(retainedLivePreservedRows[0]).toMatchObject({
      channelDeletedAt: null,
      memberUserId: owner.id,
      agentId: preservedProfile.id,
    });
    expect(retainedLivePreservedRows[0]?.profileDeletedAt).toBeInstanceOf(Date);

    const ownerRoster = await loadAgents(owner);
    expect(ownerRoster).not.toContainEqual(
      expect.objectContaining({ id: deletedOnlyProfile.id }),
    );
    expect(ownerRoster).toContainEqual({
      id: preservedProfile.id,
      name: "Preserved Helper",
      type: "unavailable",
      reason:
        "Preserved Helper has been deleted and can no longer run. Its conversations remain readable.",
    });
    expect(idsOf(await loadAgents(otherUser))).not.toEqual(
      expect.arrayContaining([deletedOnlyProfile.id, preservedProfile.id]),
    );
  });

  test("applies an edited role to the next load without a restart", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);

    await profileStore.update(owner, profile.id, {
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Reconcile corporate card statements.",
      visibility: "private",
    });

    const reloaded = (await loadAgents(owner)).find(
      (agent) => agent.id === profile.id,
    );
    expect(
      reloaded?.type === "remote_ag_ui" && reloaded.standingMessage.content,
    ).toContain("Reconcile corporate card statements.");
  });
});
