import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { MascotChoice } from "../../../../shared/mascot-ids";
import {
  type AgentProfile,
  type AgentVisibility,
  agentApiPath,
  agentKeys,
} from "./queries";

export type AgentInput = {
  name: string;
  title: string;
  roleDescription: string;
  visibility: AgentVisibility;
  /**
   * The mascot to save.
   *
   * Partial, and omitted to mean "leave this coworker as they are" — the server reads a missing
   * `mascot` as untouched and a present one as a replacement, so sending the resolved mascot on every
   * save would quietly turn every seeded coworker into a chosen one and break "reset" the first time
   * somebody edited a name. Sending `{}` is how the customizer resets one.
   */
  mascot?: Partial<MascotChoice>;
};

/** The sentence for every write here, since they all fail the same way to a reader. */
const FALLBACK = "Coworker operation failed";

/** Server-derived fields are invalidated instead of patched by hand. */
function invalidateAgents(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: agentKeys.all });
}

export function createAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: AgentInput): Promise<AgentProfile> =>
      client("/api/agents", "agent", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function updateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      input: AgentInput;
    }): Promise<AgentProfile> =>
      client(agentApiPath(variables.agentId), "agent", {
        method: "PATCH",
        body: variables.input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function duplicateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<AgentProfile> =>
      client(`${agentApiPath(agentId)}/duplicate`, "agent", {
        method: "POST",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function setAgentHiddenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; hidden: boolean }) => {
      await client(
        `${agentApiPath(variables.agentId)}/${variables.hidden ? "hide" : "unhide"}`,
        { method: "POST", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function deleteAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await client(agentApiPath(agentId), {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/**
 * Whether one Bot may hand work to another.
 *
 * The same `plugin_grants` write every other grant makes, with `kind: "bot"`, so the audit row and
 * the refusals are the ones already in place: an administrator only, never a Bot on itself, and
 * never onto a Bot that does not exist.
 *
 * DIRECTIONAL, and the two ids are easy to swap: `agentId` is the Bot doing the asking and `ref` is
 * the Bot it may reach. Granted the other way round it reads as working and hands over nothing.
 */
export function setHandoffGrantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      /** The Bot doing the asking. */
      agentId: string;
      /** The Bot it may reach. */
      ref: string;
      granted: boolean;
    }) => {
      if (variables.granted) {
        await client("/api/plugins/grants", {
          method: "POST",
          body: { kind: "bot", ref: variables.ref, agentId: variables.agentId },
          fallback: FALLBACK,
        });
        return;
      }
      await client(
        `/api/plugins/grants?kind=bot&ref=${encodeURIComponent(variables.ref)}&agentId=${encodeURIComponent(variables.agentId)}`,
        { method: "DELETE", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}
