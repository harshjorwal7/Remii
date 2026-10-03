import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { ManagedAgentConfig } from "../config";
import { type RegisteredAgent, registeredAgentFromRow } from "../copilot";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
} from "../db/schema";
import type { AgentActor } from "./profile-types";

/**
 * Read the agents one person may run, on every request.
 *
 * The filtering is in the query, not in JavaScript afterwards: a private coworker must never be
 * read into the process for an actor who cannot see it, and "we fetched it but did not show it" is
 * the shape most accidental disclosures take.
 */
export function createRuntimeAgentLoader(
  database: Database,
  /** Secret for the Bot this deployment runs. Sent only to endpoints it runs itself. */
  managedAgent?: ManagedAgentConfig,
) {
  return async (actor: AgentActor): Promise<RegisteredAgent[]> => {
    const [active, tombstones] = await Promise.all([
      selectActiveAgents(database, actor),
      selectTombstoneAgents(database, actor),
    ]);

    // A row whose configuration cannot be understood is skipped rather than mounted as a broken
    // agent. Tombstones are appended after, and never overwrite a live agent of the same id.
    const registered = new Map<string, RegisteredAgent>();
    for (const row of active) {
      const agent = registeredAgentFromRow(row);
      if (!agent) continue;
      /*
       * Every endpoint this deployment runs gets the token, not just the first one.
       *
       * Matching a single endpoint left the harness picked during setup without it: registered,
       * addressable, routed to, and answering `401 unauthorised` to everything. Its container is
       * this deployment's own, started on a port this deployment chose with this token in its
       * environment, so it is the same relationship the Bot in the box has.
       *
       * It is also the only credential any run carries. Nobody can register an endpoint or a key of
       * their own, so there is no other header on this call and no vault to read one from.
       */
      if (
        (agent.type === "remote_ag_ui" || agent.type === "remote_mastra") &&
        managedAgent
      ) {
        // Config parses URLs, while package rows retain their original spelling. Compare both
        // in canonical form so scheme/host case cannot silently drop the deployment token.
        const endpoint = managedEndpointIdentity(agent.endpoint);
        const ours =
          endpoint !== undefined &&
          [managedAgent.endpoint, managedAgent.alsoRun]
            .filter((url): url is URL => url !== undefined)
            .some((url) => endpoint === managedEndpointIdentity(url));
        if (ours) {
          agent.headers = {
            ...agent.headers,
            "x-remii-agent-token": managedAgent.token,
          };
        }
      }
      registered.set(agent.id, agent);
    }
    for (const row of tombstones) {
      if (registered.has(row.id)) continue;
      registered.set(row.id, {
        id: row.id,
        name: row.name,
        type: "unavailable",
        reason: `${row.name} has been deleted and can no longer run. Its conversations remain readable.`,
      });
    }

    return [...registered.values()];
  };
}

/** Keep the existing pathname slash tolerance without erasing query or fragment differences. */
function managedEndpointIdentity(value: string | URL): string | undefined {
  try {
    const endpoint = new URL(value);
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
    return endpoint.toString();
  } catch {
    // An invalid stored URL is not a managed endpoint; it must not abort another agent's load.
    return undefined;
  }
}

function selectActiveAgents(database: Database, actor: AgentActor) {
  return database
    .select({
      id: agents.id,
      name: agents.name,
      type: agents.type,
      configuration: agents.configuration,
      // Read so a supervisor's tool list and its prompt are decided from one
      // place. See `registeredAgentFromRow`.
      override: agents.override,
      title: agentProfiles.title,
      roleDescription: agentProfiles.roleDescription,
    })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .where(
      and(
        isNull(agentProfiles.deletedAt),
        // Strict per-user SaaS: no public sharing and no administrator
        // override. System templates (owner null) are definitions; user bots
        // are owner-only. Computers, workspaces and connections stay per-user.
        or(
          isNull(agentProfiles.ownerUserId),
          eq(agentProfiles.ownerUserId, actor.id),
        ),
      ),
    );
}

/**
 * Deleted coworkers the caller still has history with.
 *
 * Registered so Intelligence can restore the thread the person is reading. Membership of a channel
 * the agent worked in is what authorizes this, not the profile's visibility, which is why deleting
 * a coworker leaves its conversations readable instead of erasing them.
 */
function selectTombstoneAgents(database: Database, actor: AgentActor) {
  return database
    .selectDistinct({ id: agents.id, name: agents.name })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .innerJoin(channelAgents, eq(channelAgents.agentId, agents.id))
    .innerJoin(
      channels,
      and(eq(channels.id, channelAgents.channelId), isNull(channels.deletedAt)),
    )
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channelAgents.channelId),
        eq(channelMemberships.userId, actor.id),
      ),
    )
    .where(isNotNull(agentProfiles.deletedAt));
}
