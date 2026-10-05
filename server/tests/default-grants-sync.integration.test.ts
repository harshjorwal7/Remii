import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq, or } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The person these Bots belong to.
 *
 * WAS the literal `"dev-local-user"` throughout. `agents.owner_user_id` is a foreign key to `users`,
 * so the id has to be a row that exists, and the development actor is only created by a deployment
 * running with single-user sign-in — not by this suite. Creating it here makes the constraint
 * satisfiable rather than assumed.
 */
const OWNER_ID = `dev-grants-${Date.now()}`;
import {
  agents,
  composioAccountGrants,
  composioConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
  pluginRevocations,
  users,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import type { ActionPolicy } from "../src/computer/policy";
import { createAgentProfileStore } from "../src/agents/profile-store";

import { createAuditStore } from "../src/audit";

/**
 * The default grants sync, against the DEDICATED test database.
 *
 * WAS `process.env.DATABASE_URL ?? "postgres://remii:remii@localhost:5432/remii"`.
 *
 * That is not the database the rest of the suite runs against, and it is not even this file's own:
 * every other integration test opens `testDatabaseUrl()`, which requires `TEST_DATABASE_URL` to be
 * set and refuses to fall back to `DATABASE_URL` for exactly this reason. This one opened a developer's
 * local `remii` database instead, which is whatever schema that happened to have — and on this
 * machine it was months behind, so every insert failed with `column "owner_user_id" of relation
 * "agents" does not exist`.
 *
 * The failure mode is the reason it is worth changing rather than skipping: it is not that the test
 * cannot answer its question, it is that it was asking a different database than the one under test
 * and reporting the answer as a schema fault.
 */
describe("default grants and explicit revocations sync", () => {
  const db = createDatabase(testDatabaseUrl(), TEST_POOL);

  beforeAll(async () => {
    // See OWNER_ID: the foreign key from `agents.owner_user_id` has to point at a row.
    await db
      .insert(users)
      .values({
        id: OWNER_ID,
        email: `${OWNER_ID}@example.test`,
        name: "Default Grants Owner",
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, OWNER_ID));
  });

  const auditStore = createAuditStore(db);

  const fakeCredentials = {
    revoke: async () => {},
    held: async () => null,
  } as unknown as Parameters<typeof createPluginStore>[0]["credentials"];

  const store = createPluginStore({
    database: db,
    auditStore,
    credentials: fakeCredentials,
    encryptionKey: "test-encryption-key-that-is-long-enough-32-chars!",
    // An empty policy, which permits nothing: these assertions are about grants, not about what the
    // gateway would allow.
    policy: () => ({ mode: "enforce", deny: [], allow: [] }) as ActionPolicy,
  });

  it("syncDefaultGrants only synchronises built-in Bot handoffs", async () => {
    // 1. Setup a test agent
    const testAgentA = `test-agent-a-${Date.now()}`;
    const testAgentB = `test-agent-b-${Date.now()}`;
    const testServerId = `test-srv-${Date.now()}`;
    const testConnId = `conn-${Date.now()}`;

    try {
      await db.insert(agents).values([
        {
          id: testAgentA,
          ownerUserId: OWNER_ID,
          isSystemTemplate: false,
          name: "Test Agent A",
          type: "built_in",
          configuration: { systemPrompt: "Test A" },
        },
        {
          id: testAgentB,
          ownerUserId: OWNER_ID,
          isSystemTemplate: false,
          name: "Test Agent B",
          type: "built_in",
          configuration: { systemPrompt: "Test B" },
        },
      ]);

      // 2. Setup a test custom server with tools
      await db.insert(mcpServers).values({
        id: testServerId,
        title: "Test Server",
        vendor: "TestVendor",
        url: `https://test-server-${Date.now()}.local/mcp`,
        provenance: "custom",
      });

      await db.insert(mcpTools).values([
        {
          serverId: testServerId,
          name: "TOOL_ONE",
          description: "Tool One",
          inputSchema: {},
          effect: "read",
          destructive: false,
        },
      ]);

      // 3. Setup a test composio connection
      await db.insert(composioConnections).values({
        id: testConnId,
        toolkit: "testtool",
        userId: OWNER_ID,
        accountId: "ca_test_123",
        verified: true,
      });

      // 4. Run syncDefaultGrants
      await store.syncDefaultGrants({ agentId: testAgentA });

      const grantsA = await db
        .select()
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, testAgentA),
            eq(pluginGrants.kind, "mcp"),
            eq(pluginGrants.ref, `${testServerId}/TOOL_ONE`),
          ),
        );
      expect(grantsA.length).toBe(0);

      const acctGrantsA = await db
        .select()
        .from(composioAccountGrants)
        .where(
          and(
            eq(composioAccountGrants.agentId, testAgentA),
            eq(composioAccountGrants.connectionId, testConnId),
          ),
        );
      expect(acctGrantsA.length).toBe(0);

      // Verify bot handoff granted
      const botGrantsA = await db
        .select()
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, testAgentA),
            eq(pluginGrants.kind, "bot"),
            eq(pluginGrants.ref, testAgentB),
          ),
        );
      expect(botGrantsA.length).toBe(1);

      // 5. Test explicit revokeServer
      await store.revokeServer(testServerId, testAgentA, OWNER_ID);

      // Verify tool grant deleted
      const grantsAfterRevoke = await db
        .select()
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, testAgentA),
            eq(pluginGrants.kind, "mcp"),
            eq(pluginGrants.ref, `${testServerId}/TOOL_ONE`),
          ),
        );
      expect(grantsAfterRevoke.length).toBe(0);

      // Verify revocation recorded
      const revs = await db
        .select()
        .from(pluginRevocations)
        .where(
          and(
            eq(pluginRevocations.agentId, testAgentA),
            eq(pluginRevocations.kind, "mcp_server"),
            eq(pluginRevocations.ref, testServerId),
          ),
        );
      expect(revs.length).toBe(1);

      // 6. Re-run syncDefaultGrants: must NOT restore revoked server
      await store.syncDefaultGrants({ agentId: testAgentA });
      const grantsAfterResync = await db
        .select()
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, testAgentA),
            eq(pluginGrants.kind, "mcp"),
            eq(pluginGrants.ref, `${testServerId}/TOOL_ONE`),
          ),
        );
      expect(grantsAfterResync.length).toBe(0);

      // 7. Explicit grantServer: removes revocation and restores grant
      await store.grantServer(testServerId, testAgentA, OWNER_ID);
      const revsAfterGrant = await db
        .select()
        .from(pluginRevocations)
        .where(
          and(
            eq(pluginRevocations.agentId, testAgentA),
            eq(pluginRevocations.kind, "mcp_server"),
            eq(pluginRevocations.ref, testServerId),
          ),
        );
      expect(revsAfterGrant.length).toBe(0);

      const grantsRestored = await db
        .select()
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, testAgentA),
            eq(pluginGrants.kind, "mcp"),
            eq(pluginGrants.ref, `${testServerId}/TOOL_ONE`),
          ),
        );
      expect(grantsRestored.length).toBe(1);

      // 8. Test revokeAccountFromAgent
      await store.revokeAccountFromAgent({
        connectionId: testConnId,
        agentId: testAgentA,
        userId: OWNER_ID,
      });

      const acctGrantsAfterRevoke = await db
        .select()
        .from(composioAccountGrants)
        .where(
          and(
            eq(composioAccountGrants.agentId, testAgentA),
            eq(composioAccountGrants.connectionId, testConnId),
          ),
        );
      expect(acctGrantsAfterRevoke.length).toBe(0);

      // Re-run sync: must NOT restore revoked account
      await store.syncDefaultGrants({ agentId: testAgentA });
      const acctGrantsAfterResync = await db
        .select()
        .from(composioAccountGrants)
        .where(
          and(
            eq(composioAccountGrants.agentId, testAgentA),
            eq(composioAccountGrants.connectionId, testConnId),
          ),
        );
      expect(acctGrantsAfterResync.length).toBe(0);

      // 9. Test revoke bot handoff
      await store.revoke("bot", testAgentB, testAgentA, OWNER_ID);
      const botGrantsAfterRevoke = await db
        .select()
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, testAgentA),
            eq(pluginGrants.kind, "bot"),
            eq(pluginGrants.ref, testAgentB),
          ),
        );
      expect(botGrantsAfterRevoke.length).toBe(0);

      // Re-run sync: must NOT restore revoked bot handoff
      await store.syncDefaultGrants({ agentId: testAgentA });
      const botGrantsAfterResync = await db
        .select()
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, testAgentA),
            eq(pluginGrants.kind, "bot"),
            eq(pluginGrants.ref, testAgentB),
          ),
        );
      expect(botGrantsAfterResync.length).toBe(0);
    } finally {
      // Clean up test rows
      await db
        .delete(mcpTools)
        .where(eq(mcpTools.serverId, testServerId))
        .catch(() => {});
      await db
        .delete(mcpServers)
        .where(eq(mcpServers.id, testServerId))
        .catch(() => {});
      await db
        .delete(composioAccountGrants)
        .where(eq(composioAccountGrants.connectionId, testConnId))
        .catch(() => {});
      await db
        .delete(composioConnections)
        .where(eq(composioConnections.id, testConnId))
        .catch(() => {});
      await db
        .delete(pluginGrants)
        .where(
          or(
            eq(pluginGrants.agentId, testAgentA),
            eq(pluginGrants.agentId, testAgentB),
            eq(pluginGrants.ref, testAgentA),
            eq(pluginGrants.ref, testAgentB),
          ),
        )
        .catch(() => {});
      await db
        .delete(agents)
        .where(eq(agents.id, testAgentA))
        .catch(() => {});
      await db
        .delete(agents)
        .where(eq(agents.id, testAgentB))
        .catch(() => {});
    }
  }, 30000);

  it("profile store creation triggers onAgentCreated and populates default grants", async () => {
    let triggeredAgentId: string | null = null;
    const profileStore = createAgentProfileStore(db, undefined);
    profileStore.setOnAgentCreated?.(async (agentId) => {
      triggeredAgentId = agentId;
      await store.syncDefaultGrants({ agentId });
    });

    const created = await profileStore.create(
      // `role: "user"`, and the only role there is. The actor shape carries a role and nothing
      // else; there is no admin override on it or on anything else in this codebase.
      { id: OWNER_ID, role: "user" },
      {
        name: "Hook Test Bot",
        title: "Hook Test Bot",
        roleDescription: "Test bot for hook",
        systemPrompt: "You are a test bot",
        visibility: "private",
      },
    );

    try {
      expect(triggeredAgentId).toBe(created.id);
      // Verify bot handoffs were created for the new agent
      const botGrants = await db
        .select()
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, created.id),
            eq(pluginGrants.kind, "bot"),
          ),
        );
      expect(botGrants.length).toBeGreaterThan(0);
    } finally {
      await db.delete(agents).where(eq(agents.id, created.id));
    }
  }, 30000);
});
