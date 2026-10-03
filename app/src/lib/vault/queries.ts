import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** What a person is told when the vault itself could not be read. One sentence for the one read. */
const FALLBACK = "Could not load your vault";

/**
 * One person's vault, as the browser receives it.
 *
 * NOTHING IN THIS FILE IS A SECRET, and that is the whole of its contract. The list endpoints answer
 * with masks — four dots for a password, `•••• 4242` for a card — and no query in this file asks the
 * server for anything else. A value arrives only from `revealVaultSecret` below, and only because a
 * person clicked "Copy".
 *
 * The types below therefore carry `hasPassword` and `hasCvv` rather than the values themselves, which
 * is the rule `lib/credentials/` used before it was folded away: secrets are write-only in the
 * browser, and a secret that reaches a query cache survives refetches, navigations and devtools for
 * as long as the tab is open.
 */

/** One saved login. Never carries the password. */
export type VaultLogin = {
  id: string;
  label: string;
  username: string;
  websiteUrl: string | null;
  notes: string | null;
  /**
   * Whether a password is behind the mask.
   *
   * A boolean rather than a masked string, because the length of the mask would leak the length of
   * the password and `••••••••` on every row says the same thing whatever is behind it.
   */
  hasPassword: boolean;
  lastUsedAt: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

/** One saved card. Never carries the number or the CVV. */
export type VaultCard = {
  id: string;
  label: string;
  cardholderName: string | null;
  /** `•••• •••• •••• 4242`, built server-side from the four clear digits. */
  maskedNumber: string;
  expiry: string | null;
  hasCvv: boolean;
  billingAddress: string | null;
  notes: string | null;
  lastUsedAt: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * The person's own details.
 *
 * `null` from the server means they have written none, which is different from every field being
 * empty — the store keeps one row or none, so "no details saved" is a real state with a real
 * sentence on the screen.
 */
export type VaultPersonalInfo = {
  fullName: string | null;
  preferredName: string | null;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  company: string | null;
  jobTitle: string | null;
  notes: string | null;
  updatedAt: string;
};

export type VaultAgentItemKind =
  | "api_key"
  | "access_token"
  | "secret"
  | "environment_variable"
  | "ssh_key"
  | "recovery_code"
  | "custom";

/**
 * How wide an item's reach is.
 *
 * `task` and `integration` are stored and offered, and only partially enforced server-side — a task
 * scope refuses outside its task, an integration scope and the allowed-apps list refuse outside the
 * destination the caller named. "Ask me first" is not implemented; see the note in the schema.
 */
export type VaultAgentItemScope = "agent" | "task" | "integration";

/** One item saved for the person's coworkers. Never carries the value. */
export type VaultAgentItem = {
  id: string;
  label: string;
  kind: VaultAgentItemKind;
  description: string | null;
  scope: VaultAgentItemScope;
  /** Which integration or task it is narrowed to. */
  scopeRef: string | null;
  /** Hosts it may be spent on. Empty means no restriction was stated. */
  allowedApps: string[];
  hasValue: boolean;
  lastUsedAt: string | null;
  /** Which coworker last reached for it. */
  usedByAgentId: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

export const vaultKeys = {
  all: ["vault"] as const,
  logins: () => [...vaultKeys.all, "logins"] as const,
  cards: () => [...vaultKeys.all, "cards"] as const,
  personalInfo: () => [...vaultKeys.all, "personal-info"] as const,
  agentItems: () => [...vaultKeys.all, "agent-items"] as const,
};

/**
 * All four sections, in one round trip.
 *
 * The screen shows four sections that are always rendered together and refetched together — deleting
 * a login and adding a card both invalidate the same page — so four queries would be four caches to
 * keep in step for no gain. This is one read of the person's whole vault, and it is deliberately the
 * same shape as the four list endpoints so a section added later is one more key rather than a
 * second fetch strategy.
 */
/** What one read of the whole vault answers with. */
export type VaultSnapshot = {
  logins: VaultLogin[];
  cards: VaultCard[];
  personalInfo: VaultPersonalInfo | null;
  agentItems: VaultAgentItem[];
};

/**
 * The whole vault in one read.
 *
 * `fallback` names the screen rather than the section: this is the one query the page has, so a
 * failure here is "your vault could not be loaded" and there is no second chance at a per-section
 * message. The per-section endpoints exist server-side for anything that wants one; this screen
 * always wants all four.
 */
export function vaultQueryOptions() {
  return queryOptions({
    queryKey: vaultKeys.all,
    /*
     * No envelope key: this response's whole body IS the snapshot — `logins`, `cards`,
     * `personalInfo` and `agentItems` with nothing wrapped around them — which is the one case
     * `client` documents as "read it yourself". So the four section names stay visible in the type
     * rather than being unwrapped away here and re-typed at every consumer.
     */
    queryFn: async (): Promise<VaultSnapshot> =>
      (await client("/api/vault", { fallback: FALLBACK })).json(),
  });
}

/**
 * One secret, for one copy-to-clipboard.
 *
 * A plain function, not a mutation factory: there is nothing to cache afterwards, no key to
 * invalidate, and the value must NOT outlive the call. Putting it in a mutation would put it in the
 * cache, where a refetch or a navigation would keep it alive, and a password sitting in the query
 * cache is a password that survives somebody closing the tab in the wrong way.
 *
 * The value is returned to the caller and to nowhere else. Nothing logs it, nothing stores it.
 */
export async function revealVaultSecret(
  kind: "logins" | "cards" | "agent-items",
  id: string,
  field?: "number" | "expiry" | "cvv",
): Promise<string> {
  return client(
    `/api/vault/${kind}/${encodeURIComponent(id)}/reveal`,
    "value",
    {
      method: "POST",
      ...(field ? { body: { field } } : {}),
      fallback: "That could not be copied",
    },
  );
}
