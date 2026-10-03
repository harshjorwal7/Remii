import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * How much one person may say, in characters.
 *
 * The server owns this rule and refuses past it; this copy exists so the box can count down rather
 * than let somebody write four paragraphs and find out on save. A drift between the two therefore
 * shows up as a refusal with the server's own sentence on it, which is the safe direction for a
 * duplicated number to fail in.
 */
export const INSTRUCTIONS_LIMIT = 4000;

export const settingsKeys = {
  all: ["settings"] as const,
  instructions: () => [...settingsKeys.all, "instructions"] as const,
  executionMode: () => [...settingsKeys.all, "execution-mode"] as const,
};

/** "" means this person has written none. There is no separate absent state to draw. */
export function instructionsQueryOptions() {
  return queryOptions({
    queryKey: settingsKeys.instructions(),
    queryFn: async (): Promise<string> =>
      client("/api/settings/instructions", "instructions", {
        fallback: "Could not load your standing instructions",
      }),
  });
}

export type ExecutionModeSetting = {
  /** The person's own choice, or null to inherit the deployment default. */
  mode: "direct" | "ask-first" | null;
  /** The deployment default they inherit when mode is null. */
  defaultMode: "direct" | "ask-first";
};

/** Null mode means inheriting the deployment default, which travels beside it. */
export function executionModeQueryOptions() {
  return queryOptions({
    queryKey: settingsKeys.executionMode(),
    queryFn: async (): Promise<ExecutionModeSetting> => {
      const response = await client("/api/settings/execution-mode", {
        fallback: "Could not load your execution mode",
      });
      return (await response.json()) as ExecutionModeSetting;
    },
  });
}
