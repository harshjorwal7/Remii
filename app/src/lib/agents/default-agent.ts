import { REMII_AGENT_ID } from "../../../../shared/remii";
import type { AgentProfile } from "./queries";

export const PICKED_HARNESS_AGENT_ID = "picked-harness";

/**
 * Remii, the chief of staff: the default coworker everywhere no explicit choice was made.
 *
 * RE-EXPORTED rather than declared. This file used to hold its own copy of the literal, and the server
 * held another — which is exactly the arrangement `shared/remii.ts` exists to prevent, recreated inside
 * the one module whose whole job is deciding who the default is. Two spellings of the id in one
 * repository is how a rename lands in one tree and silently not the other: everything keeps working,
 * because nothing fails when the default is simply not found, and Remii quietly stops being the default.
 */
export { REMII_AGENT_ID };

export function defaultAgentProfile(
  agents: readonly AgentProfile[] | undefined,
  fallback?: AgentProfile,
): AgentProfile | undefined {
  const nonTemplates = agents?.filter(
    (candidate) => !candidate.isSystemTemplate,
  );
  return (
    nonTemplates?.find(
      (candidate) => candidate.id === PICKED_HARNESS_AGENT_ID,
    ) ??
    nonTemplates?.find((candidate) => candidate.id === REMII_AGENT_ID) ??
    fallback ??
    nonTemplates?.[0]
  );
}

export function defaultAgentId(
  agents: readonly AgentProfile[] | undefined,
): string | undefined {
  return defaultAgentProfile(agents)?.id;
}
