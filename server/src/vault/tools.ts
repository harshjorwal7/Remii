/**
 * The vault as an agent sees it: a small set of tools, each of which asks for one thing.
 *
 * WHAT THIS IS NOT. It is not the vault. A Bot holding the whole vault would hold every password,
 * card number and API key in its context on every turn, including the turns where it is writing a
 * summary — which is precisely the situation this feature exists to avoid. So there is no
 * `list_everything`, no `dump`, and no tool whose return value is a collection of secrets. What
 * exists is:
 *
 *   vault_list      names only — what is in the vault, with ids and kinds and no values
 *   vault_use_login one login, for one named site
 *   vault_use_card  one card, for one named purchase
 *   vault_use_item  one agent item, by name
 *   vault_person    personal information, field by field, only the ones asked for
 *
 * A model has to know a thing's name before it can ask for it, and it learns the names from
 * `vault_list` — a call that returns no secret at all. That is the design: discovery and use are two
 * different tools, so a model can enumerate what somebody has and still hold none of it.
 *
 * THE OTHER HALF OF THE ARGUMENT is at the execution boundary, not here. These tools return a secret
 * to the model, which is unavoidable — something has to type the password into the box. What this
 * module does is make that the only place a secret is ever in a transcript, and make each one a
 * deliberate, audited, counted act rather than something that happened because the model read a list.
 * Callers who want a stronger answer than "the model was careful" should reach for the computer
 * gateway's own credential injection, which types a value without it ever being a tool result.
 *
 * SCOPE IS ADVISED, NOT ENFORCED, EXCEPT FOR ONE CASE. `vault_use_item` refuses an item whose scope is
 * `task` when the run has no task, because storing a task-scoped secret where no task can reach it is
 * a mistake worth catching at the moment it is made. `integration` scope is likewise compared against
 * the destination the caller states, and refused when the item does not allow it. Everything else —
 * "this agent may use this", "ask the person first" — is stored, extensible, and has no screen yet;
 * see the note on `vaultAgentItemScope` in the schema.
 */
import { z } from "zod";
import type { AuditInitiator, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import {
  type VaultAgentItemSummary,
  VaultNotFoundError,
  VaultRefusedError,
  type VaultStore,
} from "./store";

/**
 * The names a person can give their items, as one list.
 *
 * Shared with the form on the settings screen rather than repeated here, so the vocabulary a model is
 * offered and the one a person picks from cannot drift into two dialects.
 */
export const AGENT_ITEM_KINDS = [
  { value: "api_key", label: "API key" },
  { value: "access_token", label: "Access token" },
  { value: "secret", label: "Secret" },
  { value: "environment_variable", label: "Environment variable" },
  { value: "ssh_key", label: "SSH key" },
  { value: "recovery_code", label: "Recovery code" },
  { value: "custom", label: "Custom" },
] as const;

const KIND_LABELS: Record<string, string> = Object.fromEntries(
  AGENT_ITEM_KINDS.map((kind) => [kind.value, kind.label]),
);

/** What a model may say about where a secret is going, for the `integration` scope to be checked against. */
function hostOf(destination: string): string | null {
  try {
    return new URL(
      /^https?:\/\//i.test(destination)
        ? destination
        : `https://${destination}`,
    ).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether a host is one an item allows.
 *
 * Suffix matching on a dot boundary, so `stripe.com` allows `api.stripe.com` and does NOT allow
 * `notstripe.com`. A prefix check would let an item marked for one vendor be spent at an attacker's
 * domain that merely ends in the same letters, which is the whole reason the allow-list exists.
 */
export function hostAllowed(
  itemAllowedApps: string[],
  destination: string | null,
): boolean {
  // No restriction stated means no restriction applied. One representation of "anywhere", and it is
  // the absence of the list — see the column's own note.
  if (!itemAllowedApps.length) return true;
  if (!destination) return false;
  return itemAllowedApps.some((allowed) => {
    const host = hostOf(allowed);
    return host === destination || destination.endsWith(`.${host}`);
  });
}

export function vaultToolsFor(options: {
  store: VaultStore;
  /** The signed-in person. Every read is scoped to this id and nothing else. */
  actorId: string;
  /** The coworker holding the run. Recorded so "who used my key" has an answer. */
  botId: string;
  /** The task or thread this run belongs to, when it has one. Absent is a normal answer. */
  threadId?: string;
  /** Where a Bot's own use of somebody's secret is recorded. Absent means nowhere, and that is a choice. */
  auditStore?: AuditStore;
  /** Omitted means a person did this, rather than a Bot. */
  initiator?: AuditInitiator;
}): GrantedTool[] {
  const { store, actorId, botId, threadId, auditStore, initiator } = options;

  const tool = (
    name: string,
    description: string,
    parameters: z.ZodType,
    execute: (args: Record<string, unknown>) => Promise<string>,
    effect: "read" | "write" = "read",
  ): GrantedTool => ({
    name,
    description,
    parameters,
    ref: `vault/${name}`,
    effect,
    execute: async (args: unknown) =>
      execute((args ?? {}) as Record<string, unknown>),
  });

  /**
   * Run a read, turning the two refusals this store raises into a sentence instead of a throw.
   *
   * A model handed an exception stack stops; a model handed "there is no login by that name in your
   * vault" asks the person, or tries another name. That is the difference between a Bot that gives up
   * mid-task and one that keeps going.
   *
   * Anything else is rethrown, deliberately. A dropped database connection is a fault and belongs in
   * the fault path, where the run fails and an operator sees it — not in the answer, where the model
   * would be told a sentence about somebody's vault naming a problem that has nothing to do with it.
   *
   * Both classes render to the same marker, so the caller only has to check one field.
   */
  async function reading<T>(
    run: () => Promise<T>,
  ): Promise<{ value: T } | { refusal: string }> {
    try {
      return { value: await run() };
    } catch (error) {
      if (
        error instanceof VaultNotFoundError ||
        error instanceof VaultRefusedError
      ) {
        return { refusal: `${REFUSAL_MARKER} ${error.message}` };
      }
      throw error;
    }
  }

  /** One sentence for a refused read, for the calls that only need the refusal or nothing. */
  function refusalOf(error: unknown, fallback: string): string {
    return error instanceof VaultNotFoundError ||
      error instanceof VaultRefusedError
      ? error.message
      : fallback;
  }

  /**
   * Record that a secret left the vault, and that a coworker asked for it.
   *
   * Written for every `use_*` call whether it succeeded or was refused, because the refusals are the
   * interesting half: a Bot repeatedly reaching for an item it does not have is the signal that its
   * prompt is asking for something it was never given.
   *
   * NEVER A VALUE. The payload carries the kind, the item's name and the outcome. `redactAuditPayload`
   * is the second line of defence; this is the first.
   */
  async function record(input: {
    targetType: string;
    targetId?: string;
    label: string;
    outcome: "succeeded" | "refused";
    reason?: string;
  }): Promise<void> {
    if (!auditStore) return;
    try {
      await recordAuditEvent(auditStore, {
        eventType:
          input.outcome === "succeeded"
            ? "vault.value_used"
            : "vault.value_read",
        targetType: input.targetType,
        ...(input.targetId ? { targetId: input.targetId } : {}),
        actorUserId: actorId,
        ...(initiator ? { initiator } : {}),
        payload: {
          agentId: botId,
          kind: input.targetType,
          item: input.label,
          outcome: input.outcome,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
    } catch {
      // A trail that cannot be written must not fail the run. The usage counter on the row is the
      // other half of this record and is written independently, so neither depends on the other.
    }
  }

  return [
    tool(
      "vault_list",
      "List what the person has saved in their vault: logins, cards, and items meant for you. Returns names, ids and kinds ONLY — never a password, card number or key. Call this to find what exists, then call the matching vault_use_* tool for the one you need.",
      z.object({}),
      async () => {
        const listed = await reading(() =>
          Promise.all([
            store.listAgentItems(actorId),
            store.listCards(actorId),
            store.listLogins(actorId),
          ]),
        );
        if ("refusal" in listed) return listed.refusal;

        // Alphabetical within each kind, which is the order the settings screen shows them in: a model
        // reading this and a person reading that screen are looking at the same ordering.
        const [items, cards, logins] = listed.value;

        if (!logins.length && !cards.length && !items.length) {
          return "Their vault is empty. Tell them what to save on the Vault settings page and try again.";
        }

        const lines: string[] = [];
        if (logins.length) {
          lines.push(
            `Logins:\n${logins
              .map(
                (login) =>
                  `- ${login.label} (${login.username}) — id ${login.id}`,
              )
              .join("\n")}`,
          );
        }
        if (cards.length) {
          lines.push(
            `Cards:\n${cards
              .map(
                (card) =>
                  `- ${card.label} ${card.maskedNumber} — id ${card.id}`,
              )
              .join("\n")}`,
          );
        }
        if (items.length) {
          lines.push(
            `Items saved for you:\n${items
              .map(
                (item) =>
                  `- ${item.label} (${KIND_LABELS[item.kind] ?? item.kind}) — id ${item.id}`,
              )
              .join("\n")}`,
          );
        }
        return lines.join("\n\n");
      },
    ),

    tool(
      "vault_use_login",
      "Get the username and password for ONE saved login, to sign in to a site. Pass the id from vault_list. The password is returned once and must be typed into the site's form; never write it into a message, a note or a file.",
      z.object({
        id: z.string().describe("The login's id, from vault_list."),
      }),
      async (args) => {
        const id = String(args.id ?? "");
        try {
          const secret = await store.readLoginSecret({
            userId: actorId,
            id,
            agentId: botId,
          });
          await record({
            targetType: "vault_login",
            targetId: secret.id,
            label: secret.label,
            outcome: "succeeded",
          });
          return [
            `Site: ${secret.label}`,
            secret.websiteUrl ? `URL: ${secret.websiteUrl}` : null,
            `Username: ${secret.username}`,
            `Password: ${secret.password}`,
            "Type these into the page. Do not repeat the password back to the person or write it anywhere.",
          ]
            .filter(Boolean)
            .join("\n");
        } catch (error) {
          const sentence = refusalOf(error, "That login could not be read.");
          await record({
            targetType: "vault_login",
            targetId: id,
            label: id,
            outcome: "refused",
            reason: sentence,
          });
          return `${REFUSAL_MARKER} ${sentence}`;
        }
      },
    ),

    tool(
      "vault_use_card",
      "Get the details of ONE saved card to pay for something. Pass the id from vault_list. Use it only for the purchase the person asked for, and never write the number or the CVV into a message, a note or a file.",
      z.object({
        id: z.string().describe("The card's id, from vault_list."),
      }),
      async (args) => {
        const id = String(args.id ?? "");
        try {
          const secret = await store.readCardSecret({
            userId: actorId,
            id,
            agentId: botId,
          });
          await record({
            targetType: "vault_card",
            targetId: secret.id,
            label: secret.label,
            outcome: "succeeded",
          });
          return [
            `Card: ${secret.label}`,
            secret.cardholderName ? `Name: ${secret.cardholderName}` : null,
            `Number: ${secret.cardNumber}`,
            secret.expiry ? `Expiry: ${secret.expiry}` : null,
            secret.cvv ? `CVV: ${secret.cvv}` : null,
            secret.billingAddress
              ? `Billing address: ${secret.billingAddress}`
              : null,
            "Fill these into the payment form. Do not repeat them back to the person or write them anywhere.",
          ]
            .filter(Boolean)
            .join("\n");
        } catch (error) {
          const sentence = refusalOf(error, "That card could not be read.");
          await record({
            targetType: "vault_card",
            targetId: id,
            label: id,
            outcome: "refused",
            reason: sentence,
          });
          return `${REFUSAL_MARKER} ${sentence}`;
        }
      },
    ),

    tool(
      "vault_use_item",
      "Get the value of ONE item saved for you: an API key, a token, a secret, an SSH key or a recovery code. Pass the id from vault_list, and say where you are about to use it so an item limited to certain sites is not spent elsewhere.",
      z.object({
        id: z.string().describe("The item's id, from vault_list."),
        destination: z
          .string()
          .optional()
          .describe(
            "The site or app you will use this at, e.g. api.stripe.com. Needed when the item is limited to certain apps.",
          ),
      }),
      async (args) => {
        const id = String(args.id ?? "");
        const destination = args.destination ? String(args.destination) : null;

        /*
         * The item as a row rather than as a secret, read BEFORE anything is decrypted so the scope and
         * the allow-list can be checked without touching an envelope. `null` means there is no such item
         * for this person, which is the refusal.
         */
        let summary: VaultAgentItemSummary | null = null;
        try {
          // `?? null` rather than the `find` result directly: `find` answers `undefined` for a miss and
          // this branch reads one "no such item" test below, so the two have to be the same absence.
          summary =
            (await store.listAgentItems(actorId)).find(
              (item) => item.id === id,
            ) ?? null;
        } catch (error) {
          const sentence = refusalOf(error, "That item could not be read.");
          await record({
            targetType: "vault_agent_item",
            targetId: id,
            label: id,
            outcome: "refused",
            reason: sentence,
          });
          return `${REFUSAL_MARKER} ${sentence}`;
        }
        if (!summary) {
          const sentence = "That item does not exist.";
          await record({
            targetType: "vault_agent_item",
            targetId: id,
            label: id,
            outcome: "refused",
            reason: sentence,
          });
          return `${REFUSAL_MARKER} ${sentence}`;
        }

        /*
         * The rules that are actually enforced, checked BEFORE the value is read so a refusal never
         * touches an envelope.
         */
        const refusal =
          scopeRefusal(
            summary.scope,
            summary.scopeRef,
            destination,
            threadId,
          ) ??
          (hostAllowed(summary.allowedApps, destination)
            ? null
            : `That item is limited to ${summary.allowedApps.join(", ")}, and you said you were using ${destination}.`);
        if (refusal) {
          await record({
            targetType: "vault_agent_item",
            targetId: id,
            label: summary.label,
            outcome: "refused",
            reason: refusal,
          });
          return `${REFUSAL_MARKER} ${refusal}`;
        }

        try {
          const secret = await store.readAgentItemSecret({
            userId: actorId,
            id,
            agentId: botId,
          });
          await record({
            targetType: "vault_agent_item",
            targetId: secret.id,
            label: secret.label,
            outcome: "succeeded",
          });
          return [
            `${KIND_LABELS[secret.kind] ?? secret.kind}: ${secret.label}`,
            `Value: ${secret.value}`,
            secret.description ? `Notes: ${secret.description}` : null,
            "Use it now and do not repeat it back to the person or write it anywhere.",
          ]
            .filter(Boolean)
            .join("\n");
        } catch (error) {
          const sentence = refusalOf(error, "That item could not be read.");
          await record({
            targetType: "vault_agent_item",
            targetId: id,
            label: summary.label,
            outcome: "refused",
            reason: sentence,
          });
          return `${REFUSAL_MARKER} ${sentence}`;
        }
      },
    ),

    tool(
      "vault_person",
      "Get details about the person themselves: their name, email, phone, address, company or date of birth. Ask for the fields you need by name — postal_code, city, country — and only those come back. Call it to fill in a form about THEM, never to send them anything.",
      z.object({
        fields: z
          .array(z.string())
          .describe(
            'The field names you need, e.g. ["full_name", "postal_code", "city"]. Empty returns nothing on purpose.',
          ),
      }),
      async (args) => {
        const asked = Array.isArray(args.fields) ? args.fields.map(String) : [];
        const fetched = await reading(() =>
          store.personalInfoFields(actorId, asked),
        );
        if ("refusal" in fetched) return fetched.refusal;

        const entries = Object.entries(fetched.value);
        if (!entries.length) {
          /*
           * Two causes and one sentence, because they need the same next step: either they saved
           * nothing, or they saved something else. Both are answered by the same question.
           */
          return "Nothing is saved under those names. Ask which details they have on the Vault settings page.";
        }
        return entries.map(([field, value]) => `${field}: ${value}`).join("\n");
      },
    ),
  ];
}

/**
 * The scope rules, or null when the use is allowed.
 *
 * Returned as a sentence rather than raised so the caller can record the refusal with a reason before
 * deciding what to say. Kept here rather than in the store because a store has no idea what task or
 * destination a run has; those are properties of the call, not of the row.
 */
export function scopeRefusal(
  scope: string,
  scopeRef: string | null,
  destination: string | null,
  threadId: string | undefined,
): string | null {
  if (scope === "task") {
    if (!threadId) {
      return "That item is kept for one task, and this run has no task of its own to use it in.";
    }
    if (scopeRef && scopeRef !== threadId) {
      return "That item belongs to a different task.";
    }
  }
  if (scope === "integration") {
    if (scopeRef && destination) {
      const wanted = hostOf(scopeRef);
      const going = hostOf(destination);
      if (
        wanted &&
        going &&
        wanted !== going &&
        !going.endsWith(`.${wanted}`)
      ) {
        return `That item is kept for ${scopeRef}, not for ${destination}.`;
      }
    }
  }
  return null;
}
