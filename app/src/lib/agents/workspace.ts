import type { UseMutateAsyncFunction } from "@tanstack/react-query";
import type { AgentProfile } from "./queries";

/**
 * A template is never spoken to directly: it joins the workspace as a copy first.
 *
 * Templates are shared and read-only in spirit — duplicating keeps the shared original clean
 * and gives the copy its own grants, channels and audit trail. Both composers (home and
 * `/channel/new`) resolve through here so picking a template anywhere means the same thing:
 * choosing is free, sending commits the copy.
 */
export async function workspaceAgentId(
  profile: AgentProfile | undefined,
  fallbackId: string,
  duplicate: UseMutateAsyncFunction<AgentProfile, Error, string, unknown>,
): Promise<string> {
  if (!profile?.isSystemTemplate || profile.id !== fallbackId) {
    return fallbackId;
  }
  return (await duplicate(fallbackId)).id;
}
