import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type ExecutionModeSetting, settingsKeys } from "./queries";

/**
 * Save, or clear by saving nothing.
 *
 * A PUT of the whole text rather than a patch, because there is one field and its new value is the
 * whole of what changed. What comes back is what was stored — the server trims — so the cache is
 * seeded from the reply rather than from what was sent, and a box that had trailing whitespace in it
 * settles to what the database actually holds.
 */
export function saveInstructionsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (instructions: string): Promise<string> =>
      client("/api/settings/instructions", "instructions", {
        method: "PUT",
        body: { instructions },
        fallback: "Your standing instructions could not be saved",
      }),
    onSuccess: (saved) =>
      queryClient.setQueryData(settingsKeys.instructions(), saved),
  });
}

/**
 * Save the execution switch, or clear it back to inheriting the deployment default.
 *
 * A PUT of the whole choice rather than a patch, because there is one field. What comes back
 * is what was stored — mode plus the default it inherits from — so the cache is seeded from
 * the reply rather than from what was sent.
 */
export function saveExecutionModeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      mode: "direct" | "ask-first" | null,
    ): Promise<ExecutionModeSetting> => {
      const response = await client("/api/settings/execution-mode", {
        method: "PUT",
        body: { mode },
        fallback: "Your execution mode could not be saved",
      });
      return (await response.json()) as ExecutionModeSetting;
    },
    onSuccess: (saved) =>
      queryClient.setQueryData(settingsKeys.executionMode(), saved),
  });
}
