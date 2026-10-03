import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type {
  VaultAgentItem,
  VaultAgentItemKind,
  VaultCard,
  VaultLogin,
  VaultPersonalInfo,
} from "./queries";
import { vaultKeys } from "./queries";

/**
 * What a save sends, which is not what the form holds.
 *
 * A field that is `undefined` here means "leave whatever is stored alone", and that is how a secret
 * survives an edit: the edit form shows the password box EMPTY, never the stored password, so unless
 * somebody types into it `password` is never sent and the stored envelope is left alone. Sending an
 * empty string instead would be how a password gets silently deleted by somebody who opened the right
 * dialog.
 */

export type VaultLoginInput = {
  label: string;
  username: string;
  /** Omitted to keep the stored password. `null` clears it. */
  password?: string | null;
  websiteUrl?: string;
  notes?: string;
};

export type VaultCardInput = {
  label: string;
  cardholderName?: string;
  /** Omitted to keep the stored number. */
  cardNumber?: string;
  expiry?: string;
  /** Omitted to keep the stored CVV. `null` clears it. */
  cvv?: string | null;
  billingAddress?: string;
  notes?: string;
};

/**
 * Personal information's save shape.
 *
 * Every field optional and every one of them a full replacement of the row's value for that column —
 * the store upserts, and a form posting its whole state is the ordinary case. There is no "partial
 * update" here and none is wanted: thirteen fields on one row that nobody edits independently of the
 * other twelve is not a patch target.
 */
export type VaultPersonalInfoInput = Partial<{
  fullName: string;
  preferredName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  address: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  company: string;
  jobTitle: string;
  notes: string;
}>;

export type VaultAgentItemInput = {
  label: string;
  kind: VaultAgentItemKind;
  /** Omitted to keep the stored value. `null` clears it. */
  value?: string | null;
  description?: string;
  scope?: "agent" | "task" | "integration";
  scopeRef?: string;
  allowedApps?: string[];
};

/** One sentence for every write on this screen, since they all fail the same way to a reader. */
const FALLBACK = "That vault item could not be saved";

/**
 * Server-derived fields are invalidated rather than patched by hand.
 *
 * A patch would be a guess at what the server decided — whether a duplicate name was refused, whether
 * a cap was reached — and it would be wrong the first time the server adds a rule. Every write here
 * re-reads the one page query instead.
 */
function invalidateVault(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: vaultKeys.all });
}

export function createVaultLoginMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: VaultLoginInput): Promise<VaultLogin> =>
      client("/api/vault/logins", "login", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateVault(queryClient),
  });
}

export function updateVaultLoginMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      loginId: string;
      input: VaultLoginInput;
    }): Promise<VaultLogin> =>
      client(
        `/api/vault/logins/${encodeURIComponent(variables.loginId)}`,
        "login",
        {
          method: "PUT",
          body: variables.input,
          fallback: FALLBACK,
        },
      ),
    onSuccess: () => invalidateVault(queryClient),
  });
}

export function deleteVaultLoginMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (loginId: string) => {
      await client(`/api/vault/logins/${encodeURIComponent(loginId)}`, {
        method: "DELETE",
        fallback: "That login could not be removed",
      });
    },
    onSuccess: () => invalidateVault(queryClient),
  });
}

export function createVaultCardMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: VaultCardInput): Promise<VaultCard> =>
      client("/api/vault/cards", "card", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateVault(queryClient),
  });
}

export function updateVaultCardMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      cardId: string;
      input: VaultCardInput;
    }): Promise<VaultCard> =>
      client(
        `/api/vault/cards/${encodeURIComponent(variables.cardId)}`,
        "card",
        {
          method: "PUT",
          body: variables.input,
          fallback: FALLBACK,
        },
      ),
    onSuccess: () => invalidateVault(queryClient),
  });
}

export function deleteVaultCardMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (cardId: string) => {
      await client(`/api/vault/cards/${encodeURIComponent(cardId)}`, {
        method: "DELETE",
        fallback: "That card could not be removed",
      });
    },
    onSuccess: () => invalidateVault(queryClient),
  });
}

export function saveVaultPersonalInfoMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: VaultPersonalInfoInput): Promise<VaultPersonalInfo> =>
      client("/api/vault/personal-info", "personalInfo", {
        method: "PUT",
        body: input,
        fallback: "Your details could not be saved",
      }),
    onSuccess: () => invalidateVault(queryClient),
  });
}

export function createVaultAgentItemMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: VaultAgentItemInput): Promise<VaultAgentItem> =>
      client("/api/vault/agent-items", "agentItem", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateVault(queryClient),
  });
}

export function updateVaultAgentItemMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      itemId: string;
      input: VaultAgentItemInput;
    }): Promise<VaultAgentItem> =>
      client(
        `/api/vault/agent-items/${encodeURIComponent(variables.itemId)}`,
        "agentItem",
        { method: "PUT", body: variables.input, fallback: FALLBACK },
      ),
    onSuccess: () => invalidateVault(queryClient),
  });
}

export function deleteVaultAgentItemMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (itemId: string) => {
      await client(`/api/vault/agent-items/${encodeURIComponent(itemId)}`, {
        method: "DELETE",
        fallback: "That item could not be removed",
      });
    },
    onSuccess: () => invalidateVault(queryClient),
  });
}
