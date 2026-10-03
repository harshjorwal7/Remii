import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type {
  BillingDetails,
  CreditLedgerEntry,
  MeterReading,
  Meters,
  UsageRecord,
} from "./types";

export const billingKeys = {
  all: ["billing"] as const,
  details: () => [...billingKeys.all, "details"] as const,
  ledger: () => [...billingKeys.all, "ledger"] as const,
  usage: () => [...billingKeys.all, "usage"] as const,
  meters: () => [...billingKeys.all, "meters"] as const,
};

export function billingQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.details(),
    queryFn: async (): Promise<BillingDetails> => {
      const response = await client("/api/billing/subscription", {
        fallback: "Could not load subscription details.",
      });
      return (await response.json()) as BillingDetails;
    },
    staleTime: 30_000,
  });
}

export function creditLedgerQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.ledger(),
    queryFn: async (): Promise<{
      creditBalance: number;
      ledger: CreditLedgerEntry[];
    }> => {
      const response = await client("/api/billing/credits/ledger", {
        fallback: "Could not load credit ledger.",
      });
      return (await response.json()) as {
        creditBalance: number;
        ledger: CreditLedgerEntry[];
      };
    },
    staleTime: 15_000,
  });
}

/**
 * The two meters: what is left of the model allowance, and of the computer hours.
 *
 * Refetched more often than the subscription, because this is the one thing on the billing screen that
 * changes while somebody is looking at it. Thirty seconds is long enough not to hammer the server and
 * short enough that a person who has just finished a run sees the number move.
 */
export function metersQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.meters(),
    queryFn: async (): Promise<Meters> => {
      const response = await client("/api/billing/meters", {
        fallback: "Could not load your usage.",
      });
      return (await response.json()) as Meters;
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export type { MeterReading };

export function usageQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.usage(),
    queryFn: async (): Promise<{ usage: UsageRecord[] }> => {
      const response = await client("/api/billing/usage", {
        fallback: "Could not load usage records.",
      });
      return (await response.json()) as { usage: UsageRecord[] };
    },
    staleTime: 30_000,
  });
}
