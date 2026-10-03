import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { REFUSAL_MARKER } from "../src/plugins/tools";
import type { VaultStore } from "../src/vault/store";
import { VaultNotFoundError, VaultRefusedError } from "../src/vault/store";
import { hostAllowed, scopeRefusal, vaultToolsFor } from "../src/vault/tools";

/**
 * The vault, as a model sees it.
 *
 * THREE PROPERTIES, and the third is the one this feature exists for.
 *
 *  1. Discovery returns no secret. `vault_list` must be able to tell a model what exists without
 *     holding any of it, or every turn pays for the whole vault.
 *  2. A use is narrow. One id, one item, audited — not "here is everything".
 *  3. A refusal is a sentence. A model handed an exception stops; a model handed "there is no login by
 *     that name" asks the person.
 *
 * The isolation these run against is `actorId`: a fake store is enough, because the real owner filter
 * lives in the database and is proven in `vault-store.integration.test.ts`. What is checked here is
 * that the tool layer passes `actorId` to every read and never anything else.
 */

function fakeStore(
  overrides: Partial<VaultStore> = {},
): VaultStore & { readIds: Array<{ userId: string; id?: string }> } {
  const readIds: Array<{ userId: string; id?: string }> = [];
  const base: VaultStore = {
    async listLogins() {
      return [
        {
          id: "vault_login-1",
          label: "Google",
          username: "user@example.com",
          websiteUrl: "https://mail.google.com",
          notes: null,
          hasPassword: true,
          lastUsedAt: null,
          usageCount: 0,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ];
    },
    async createLogin() {
      throw new Error("not used by these tests");
    },
    async updateLogin() {
      throw new Error("not used by these tests");
    },
    async removeLogin() {
      throw new Error("not used by these tests");
    },
    async readLoginSecret(input) {
      readIds.push({ userId: input.userId, id: input.id });
      if (!input.id)
        throw new VaultNotFoundError("No login by that name in your vault.");
      return {
        id: input.id,
        label: "Google",
        username: "user@example.com",
        password: "hunter2",
        websiteUrl: "https://mail.google.com",
      };
    },
    async listCards() {
      return [
        {
          id: "vault_card-1",
          label: "Personal Visa",
          cardholderName: "John Doe",
          maskedNumber: "•••• •••• •••• 4242",
          expiry: "04/29",
          hasCvv: true,
          billingAddress: null,
          notes: null,
          lastUsedAt: null,
          usageCount: 0,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ];
    },
    async createCard() {
      throw new Error("not used by these tests");
    },
    async updateCard() {
      throw new Error("not used by these tests");
    },
    async removeCard() {
      throw new Error("not used by these tests");
    },
    async readCardSecret(input) {
      readIds.push({ userId: input.userId, id: input.id });
      return {
        id: input.id ?? "vault_card-1",
        label: "Personal Visa",
        cardholderName: "John Doe",
        cardNumber: "4242424242424242",
        expiry: "04/29",
        cvv: "123",
        billingAddress: null,
      };
    },
    async readPersonalInfo() {
      return null;
    },
    async writePersonalInfo() {
      throw new Error("not used by these tests");
    },
    async listAgentItems() {
      return [
        {
          id: "vault_item-1",
          label: "Stripe API key",
          kind: "api_key",
          description: null,
          scope: "agent",
          scopeRef: null,
          allowedApps: [],
          hasValue: true,
          lastUsedAt: null,
          usedByAgentId: null,
          usageCount: 0,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ];
    },
    async createAgentItem() {
      throw new Error("not used by these tests");
    },
    async updateAgentItem() {
      throw new Error("not used by these tests");
    },
    async removeAgentItem() {
      throw new Error("not used by these tests");
    },
    async readAgentItemSecret(input) {
      readIds.push({ userId: input.userId, id: input.id });
      return {
        id: input.id ?? "vault_item-1",
        label: "Stripe API key",
        kind: "api_key",
        value: "sk_live_abc123",
        description: null,
        scope: "agent",
        scopeRef: null,
        allowedApps: [],
      };
    },
    async personalInfoFields() {
      return { full_name: "John Doe" };
    },
  };

  return Object.assign(base, overrides, { readIds });
}

function recordingAuditStore() {
  const events: AuditEventInput[] = [];
  const store: AuditStore = {
    async insert(event) {
      events.push(event);
    },
  };
  return { store, events };
}

function toolsFor(
  store: VaultStore,
  auditStore?: AuditStore,
  threadId?: string,
) {
  return new Map(
    vaultToolsFor({
      store,
      actorId: "user-1",
      botId: "general-assistant",
      auditStore,
      ...(threadId ? { threadId } : {}),
    }).map((tool) => [tool.name, tool]),
  );
}

describe("what a model is offered", () => {
  test("the set is small, and every name says what it does", () => {
    const tools = vaultToolsFor({
      store: fakeStore(),
      actorId: "user-1",
      botId: "general-assistant",
    });
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "vault_list",
      "vault_person",
      "vault_use_card",
      "vault_use_item",
      "vault_use_login",
    ]);
    // A tool that returns a whole table is what this feature was built not to have. Asserted on the
    // names so that adding a "vault_dump" fails here rather than shipping.
    for (const tool of tools) {
      expect(tool.ref).toStartWith("vault/");
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  test("nothing is offered a user id, so nothing can be asked about somebody else's vault", () => {
    for (const tool of vaultToolsFor({
      store: fakeStore(),
      actorId: "user-1",
      botId: "general-assistant",
    })) {
      const shape = JSON.stringify(
        (tool.parameters as unknown as { shape?: unknown }).shape ?? {},
      );
      expect(shape).not.toContain("userId");
      expect(shape).not.toContain("ownerUserId");
    }
  });
});

describe("discovery holds no secret", () => {
  test("vault_list names every kind and none of their values", async () => {
    const store = fakeStore();
    const answer = await toolsFor(store).get("vault_list")!.execute({});

    expect(answer).toContain("Google");
    expect(answer).toContain("user@example.com");
    expect(answer).toContain("Personal Visa");
    expect(answer).toContain("•••• •••• •••• 4242");
    expect(answer).toContain("Stripe API key");
    // Every value in the store, absent from the answer that described where they were.
    expect(answer).not.toContain("hunter2");
    expect(answer).not.toContain("4242424242424242");
    expect(answer).not.toContain("123");
    expect(answer).not.toContain("sk_live_abc123");
  });

  test("vault_list says the vault is empty rather than returning nothing", async () => {
    const store = fakeStore({
      async listLogins() {
        return [];
      },
      async listCards() {
        return [];
      },
      async listAgentItems() {
        return [];
      },
    });
    const answer = await toolsFor(store).get("vault_list")!.execute({});
    expect(answer).toContain("empty");
  });

  test("vault_list carries the id the use tools need", async () => {
    const answer = await toolsFor(fakeStore()).get("vault_list")!.execute({});
    // Discovery and use are two tools on purpose: the model cannot ask for one thing without having
    // named it, and it cannot learn what exists without a call that returns nothing spendable.
    expect(answer).toContain("vault_login-1");
    expect(answer).toContain("vault_card-1");
    expect(answer).toContain("vault_item-1");
  });
});

describe("using one item", () => {
  test("a login comes back with its password, and says not to write it down", async () => {
    const answer = await toolsFor(fakeStore())
      .get("vault_use_login")!
      .execute({ id: "vault_login-1" });

    expect(answer).toContain("hunter2");
    expect(answer).toContain("user@example.com");
    // The instruction to stop the value travelling any further is part of the answer, because the
    // model's next move is the thing that actually decides where a password ends up.
    expect(answer).toContain("Do not repeat the password");
  });

  test("every use is scoped to the person whose session is running the turn", async () => {
    const store = fakeStore();
    await toolsFor(store)
      .get("vault_use_login")!
      .execute({ id: "vault_login-1" });
    await toolsFor(store)
      .get("vault_use_card")!
      .execute({ id: "vault_card-1" });
    await toolsFor(store)
      .get("vault_use_item")!
      .execute({ id: "vault_item-1" });

    expect(store.readIds.length).toBe(3);
    for (const read of store.readIds) {
      expect(read.userId).toBe("user-1");
    }
  });

  test("a card comes back with the number and the CVV, and the same warning", async () => {
    const answer = await toolsFor(fakeStore())
      .get("vault_use_card")!
      .execute({ id: "vault_card-1" });
    expect(answer).toContain("4242424242424242");
    expect(answer).toContain("CVV: 123");
    expect(answer).toContain("Do not repeat them back to the person");
  });

  test("an agent item comes back with its value and its description", async () => {
    const answer = await toolsFor(fakeStore())
      .get("vault_use_item")!
      .execute({ id: "vault_item-1", destination: "api.stripe.com" });
    expect(answer).toContain("API key: Stripe API key");
    expect(answer).toContain("sk_live_abc123");
  });
});

describe("refusals are sentences", () => {
  test("an unknown id comes back as prose a model can act on", async () => {
    const store = fakeStore({
      async readLoginSecret() {
        throw new VaultNotFoundError();
      },
    });
    const answer = await toolsFor(store)
      .get("vault_use_login")!
      .execute({ id: "nothing" });

    expect(answer).toStartWith(REFUSAL_MARKER);
    expect(answer).toContain("That vault item does not exist.");
  });

  test("the tool passes the id and the caller through, and the store owns name lookup", async () => {
    /*
     * THE ID, ALWAYS. The tool layer resolves a name to an id itself — it has to, because an item's
     * scope and allow-list are read before the secret is — so what reaches the store is always the
     * caller's id. The store still accepts a name for the paths that only have one, and scopes that
     * lookup to the same owner; both halves of that are asserted here and in the store's own suite.
     */
    const store = fakeStore();
    await toolsFor(store)
      .get("vault_use_item")!
      .execute({ id: "vault_item-1", destination: "api.stripe.com" });

    expect(store.readIds).toEqual([{ userId: "user-1", id: "vault_item-1" }]);
  });

  test("a refused save-shaped error is still prose, not a stack", async () => {
    const store = fakeStore({
      async readCardSecret() {
        throw new VaultRefusedError("That card has no CVV saved.");
      },
    });
    const answer = await toolsFor(store)
      .get("vault_use_card")!
      .execute({ id: "x" });
    expect(answer).toStartWith(REFUSAL_MARKER);
    expect(answer).toContain("That card has no CVV saved.");
  });

  test("personal info with nothing saved points at the settings page rather than returning empty", async () => {
    const store = fakeStore({
      async personalInfoFields() {
        return {};
      },
    });
    const answer = await toolsFor(store)
      .get("vault_person")!
      .execute({ fields: ["full_name"] });
    expect(answer).toContain("Vault settings page");
  });

  test("personal info returns only what was asked for", async () => {
    const store = fakeStore({
      async personalInfoFields(_userId, fields) {
        return Object.fromEntries(fields.map((name) => [name, "John Doe"]));
      },
    });
    const answer = await toolsFor(store)
      .get("vault_person")!
      .execute({ fields: ["full_name", "city"] });
    expect(answer).toContain("full_name: John Doe");
    expect(answer).toContain("city: John Doe");
    // No invented field appears, so a model cannot learn a field exists by asking for it and reading the
    // shape of the refusal.
    expect(answer.split("\n")).toHaveLength(2);
  });
});

describe("scope and allowed apps", () => {
  test("a task-scoped item refuses a run with no task, and one whose task is different", () => {
    expect(scopeRefusal("task", "thread-1", null, undefined)).toContain(
      "no task",
    );
    expect(scopeRefusal("task", "thread-1", null, "thread-2")).toContain(
      "different task",
    );
    expect(scopeRefusal("task", "thread-1", null, "thread-1")).toBeNull();
    expect(scopeRefusal("task", null, null, "thread-1")).toBeNull();
  });

  test("an integration-scoped item refuses a different destination", () => {
    expect(
      scopeRefusal("integration", "api.stripe.com", "evil.example.com", "t"),
    ).toContain("not for");
    expect(
      scopeRefusal("integration", "api.stripe.com", "api.stripe.com", "t"),
    ).toBeNull();
    // A subdomain of the named one is the same integration, which is the case a prefix check would
    // get wrong and a suffix check does not.
    expect(
      scopeRefusal("integration", "stripe.com", "api.stripe.com", "t"),
    ).toBeNull();
  });

  test("an agent-scoped item is never refused on scope", () => {
    expect(scopeRefusal("agent", null, null, undefined)).toBeNull();
    expect(
      scopeRefusal("agent", null, "anywhere.example.com", undefined),
    ).toBeNull();
  });

  test("a host is allowed on a dot boundary, not on a shared suffix", () => {
    // The whole reason the allow-list matches on a boundary rather than `endsWith`:
    expect(hostAllowed(["stripe.com"], "api.stripe.com")).toBe(true);
    expect(hostAllowed(["api.stripe.com"], "api.stripe.com")).toBe(true);
    expect(hostAllowed(["stripe.com"], "notstripe.com")).toBe(false);
    expect(hostAllowed(["stripe.com"], "stripe.com.evil.example")).toBe(false);
    expect(hostAllowed(["https://api.stripe.com/v1"], "api.stripe.com")).toBe(
      true,
    );
  });

  test("an item with no allow-list is usable anywhere, and one with a list needs a destination", () => {
    expect(hostAllowed([], null)).toBe(true);
    expect(hostAllowed([], "anything.example")).toBe(true);
    // "No restriction stated" is weaker than "allowed everywhere by decision", and an item with a list
    // plus no stated destination is the case that cannot be checked at all.
    expect(hostAllowed(["api.stripe.com"], null)).toBe(false);
  });

  test("an item limited to one app is refused before its value is read", async () => {
    const store = fakeStore({
      async listAgentItems() {
        return [
          {
            id: "vault_item-1",
            label: "Stripe API key",
            kind: "api_key",
            description: null,
            scope: "agent",
            scopeRef: null,
            allowedApps: ["api.stripe.com"],
            hasValue: true,
            lastUsedAt: null,
            usedByAgentId: null,
            usageCount: 0,
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        ];
      },
    });

    const refused = await toolsFor(store)
      .get("vault_use_item")!
      .execute({ id: "vault_item-1", destination: "evil.example.com" });
    expect(refused).toStartWith(REFUSAL_MARKER);
    expect(refused).toContain("api.stripe.com");
    // The read never happened, so the secret was never decrypted on the way to being refused.
    expect(store.readIds).toEqual([]);

    const allowed = await toolsFor(store)
      .get("vault_use_item")!
      .execute({ id: "vault_item-1", destination: "api.stripe.com" });
    expect(allowed).toContain("sk_live_abc123");
  });
});

describe("the trail", () => {
  test("a use is recorded with the coworker that asked, and no value", async () => {
    const { store: audit, events } = recordingAuditStore();
    await toolsFor(fakeStore(), audit)
      .get("vault_use_login")!
      .execute({ id: "vault_login-1" });

    expect(events.length).toBe(1);
    expect(events[0]?.eventType).toBe("vault.value_used");
    expect(events[0]?.targetType).toBe("vault_login");
    expect(events[0]?.actorUserId).toBe("user-1");
    expect(events[0]?.payload).toMatchObject({
      agentId: "general-assistant",
      item: "Google",
      outcome: "succeeded",
    });
    // The one assertion in this file that matters most: the trail records that a secret was spent and
    // by whom, and carries nothing spendable itself.
    expect(JSON.stringify(events[0]?.payload)).not.toContain("hunter2");
    expect(JSON.stringify(events[0]?.payload)).not.toContain(
      "user@example.com",
    );
  });

  test("a refusal is recorded too, because the refusals are the interesting half", async () => {
    const { store: audit, events } = recordingAuditStore();
    const vault = fakeStore({
      async readLoginSecret() {
        throw new VaultNotFoundError();
      },
    });
    const answer = await toolsFor(vault, audit)
      .get("vault_use_login")!
      .execute({ id: "nothing" });

    expect(answer).toStartWith(REFUSAL_MARKER);
    expect(events[0]?.payload).toMatchObject({ outcome: "refused" });
    expect(events[0]?.eventType).toBe("vault.value_read");
  });

  test("a trail that cannot be written does not fail the use", async () => {
    const broken: AuditStore = {
      async insert() {
        throw new Error("the audit table is unreachable");
      },
    };
    const answer = await toolsFor(fakeStore(), broken)
      .get("vault_use_login")!
      .execute({ id: "vault_login-1" });
    // A vault whose record-keeping is down is degraded, not locked: refusing to sign in to a site
    // because an append-only table is unavailable would be the wrong trade.
    expect(answer).toContain("hunter2");
  });

  test("no trail at all is a choice rather than a crash", async () => {
    const answer = await toolsFor(fakeStore())
      .get("vault_use_login")!
      .execute({ id: "vault_login-1" });
    expect(answer).toContain("hunter2");
  });
});
