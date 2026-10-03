import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { clearActivity } from "./activity";
import { type ActionPolicy, computerKeys } from "./queries";

/** Stopping frees the container; resetting also deletes the browser profile. */
export type ComputerAction = "stop" | "reset";

function invalidateComputers(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: computerKeys.all });
}

export function setComputerStateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      botId: string;
      action: ComputerAction;
    }) => {
      /*
       * THE PERSON'S COMPUTER, NOT THE BOT'S.
       *
       * This posted to `/api/computers/<botId>/computers/<action>`, on the per-Bot router that is not
       * mounted any more — so the button in Settings answered 404 and reported "The computer could not
       * be reset", on a computer that was working perfectly. The address is now the one desktop the
       * signed-in person owns; `botId` stays in the signature so the callers are untouched.
       */
      await client(`/api/computers/desktop/computer/${variables.action}`, {
        method: "POST",
        fallback: `The computer could not be ${variables.action}.`,
      });
    },
    /** A reset deletes the profile those commands ran on; a stop keeps it, so only reset forgets. */
    onSuccess: (_result, variables) => {
      if (variables.action === "reset") clearActivity(variables.botId);
      return invalidateComputers(queryClient);
    },
  });
}

/**
 * Replace the whole policy.
 *
 * A PUT rather than a patch because the rules are ordered and evaluated as a set: sending a
 * difference would leave the server deciding where a new rule belongs, and where a deny sits
 * relative to an allow is most of what a policy means.
 */
export function saveActionPolicyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (next: ActionPolicy): Promise<ActionPolicy> =>
      client("/api/computers/policy", "policy", {
        method: "PUT",
        body: next,
        fallback: "The boundary could not be saved.",
      }),
    onSuccess: () => invalidateComputers(queryClient),
  });
}
