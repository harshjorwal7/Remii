import type { QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { billingKeys } from "./queries";
import type { SubscriptionTier } from "./types";

/**
 * Upgrades and top-ups pay through Dodo: the mutation opens the checkout
 * session Dodo returns rather than changing anything locally. The tier and
 * the credits land via webhook afterwards, which is what keeps the price
 * list enforced — a client-side tier switch would be a price list nobody
 * checks.
 */
function redirectToCheckout(queryClient: QueryClient) {
  return {
    onSuccess: (data: { checkoutUrl: string }) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.all });
      window.location.href = data.checkoutUrl;
    },
  };
}

export function checkoutMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: async (input: {
      tier: SubscriptionTier;
      credits?: number;
    }): Promise<{ checkoutUrl: string }> => {
      const response = await client("/api/billing/checkout", {
        method: "POST",
        body: input,
        fallback: "Could not start checkout.",
      });
      return (await response.json()) as { checkoutUrl: string };
    },
    ...redirectToCheckout(queryClient),
  };
}

export function portalMutationOptions() {
  return {
    mutationFn: async (): Promise<{ portalUrl: string }> => {
      const response = await client("/api/billing/portal", {
        method: "POST",
        body: {},
        fallback: "Could not open the customer portal.",
      });
      return (await response.json()) as { portalUrl: string };
    },
    onSuccess: (data: { portalUrl: string }) => {
      window.location.href = data.portalUrl;
    },
  };
}
