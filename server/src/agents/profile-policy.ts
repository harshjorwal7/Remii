import type { AgentActor, AgentProfile } from "./profile-types";

export function canAccessAgent(
  actor: AgentActor,
  agent: AgentProfile,
): boolean {
  if (agent.deletedAt !== null) return false;

  // Strict per-user SaaS: no public sharing and no administrator override. A
  // coworker is reachable only by its owner. System templates shipped with the
  // deployment (systemOwned) are definitions, not shared computers: every user
  // still gets their own sandbox, workspace and connections when they use one.
  return agent.systemOwned || agent.ownerUserId === actor.id;
}

export function canManageAgent(
  actor: AgentActor,
  agent: AgentProfile,
): boolean {
  if (agent.systemOwned || agent.deletedAt !== null) return false;

  return agent.ownerUserId === actor.id;
}

export const canRunAgent = canAccessAgent;

/**
 * Whether this person may act as this Bot.
 *
 * Injected rather than imported, so a surface that acts as a Bot depends on the question and not on
 * the agents table. It also keeps the answer in one place: the store's read path already filters on
 * {@link canAccessAgent}, so asking it is the same rule the roster and the runtime already apply,
 * rather than a second copy that can drift from them.
 */
export type BotAccessCheck = (
  /** The whole actor, not just the id: an administrator reaches every Bot, and a role tells us. */
  actor: AgentActor,
  botId: string,
) => Promise<boolean>;
