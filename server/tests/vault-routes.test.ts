import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createVaultRoutes } from "../src/vault/routes";
import type {
  VaultAgentItemSummary,
  VaultCardSummary,
  VaultLoginSummary,
  VaultPersonalInfoRecord,
  VaultStore,
} from "../src/vault/store";
import { VaultNotFoundError, VaultRefusedError } from "../src/vault/store";

/*
 * The vault's routes, against a fake store.
 *
 * WHAT THIS FILE IS FOR. The store's ownership is proven against a real database in
 * `vault-store.integration.test.ts`, because ownership is a `where` clause and a fake cannot have one.
 * What a fake CAN prove is the thing this file checks instead: that no route on this router takes an
 * owner from anywhere but the session.
 *
 * THE CONTAINMENT ARGUMENT. Every route here is driven with a body, a path and a query string that
 * each name a different user than the session does, and the recorded store calls are then checked for
 * that name appearing in any position. A router that accepted a `userId` — from a path, a query
 * parameter or a body field — would show it here, and the assertion is written so that it fails on
 * the mere presence of the string rather than on a wrong result. That is the stronger property: this
 * test does not care whether the route filtered correctly, only whether it ever looked.
 */

const actor = {
  id: "user-1",
  email: "member@remii.test",
  role: "user",
} as const;

/** The name that appears nowhere in the session. Any route reaching for it has taken an owner from a request. */
const IMPOSTOR = "user-2";

function login(overrides: Partial<VaultLoginSummary> = {}): VaultLoginSummary {
  return {
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
    ...overrides,
  };
}

function card(overrides: Partial<VaultCardSummary> = {}): VaultCardSummary {
  return {
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
    ...overrides,
  };
}

function item(
  overrides: Partial<VaultAgentItemSummary> = {},
): VaultAgentItemSummary {
  return {
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
    ...overrides,
  };
}

function personInfo(
  overrides: Partial<VaultPersonalInfoRecord> = {},
): VaultPersonalInfoRecord {
  return {
    fullName: "John Doe",
    preferredName: null,
    email: "john@example.com",
    phone: null,
    dateOfBirth: null,
    address: null,
    city: null,
    state: null,
    country: null,
    postalCode: null,
    company: null,
    jobTitle: null,
    notes: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

type StoreCall = [method: string, ...arguments_: unknown[]];

function fakeStore(
  overrides: Partial<VaultStore> = {},
): VaultStore & { calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const base: VaultStore = {
    async listLogins(userId) {
      calls.push(["listLogins", userId]);
      return [login()];
    },
    async createLogin(userId, input) {
      calls.push(["createLogin", userId, input]);
      return login({ label: input.label });
    },
    async updateLogin(userId, id, patch) {
      calls.push(["updateLogin", userId, id, patch]);
      return login();
    },
    async removeLogin(userId, id) {
      calls.push(["removeLogin", userId, id]);
    },
    async readLoginSecret({ userId, id }) {
      calls.push(["readLoginSecret", userId, id]);
      return {
        id: id ?? "vault_login-1",
        label: "Google",
        username: "user@example.com",
        password: "hunter2",
        websiteUrl: "https://mail.google.com",
      };
    },
    async listCards(userId) {
      calls.push(["listCards", userId]);
      return [card()];
    },
    async createCard(userId, input) {
      calls.push(["createCard", userId, input]);
      return card({ label: input.label });
    },
    async updateCard(userId, id, patch) {
      calls.push(["updateCard", userId, id, patch]);
      return card();
    },
    async removeCard(userId, id) {
      calls.push(["removeCard", userId, id]);
    },
    async readCardSecret({ userId, id }) {
      calls.push(["readCardSecret", userId, id]);
      return {
        id: id ?? "vault_card-1",
        label: "Personal Visa",
        cardholderName: "John Doe",
        cardNumber: "4242424242424242",
        expiry: "04/29",
        cvv: "123",
        billingAddress: null,
      };
    },
    async readPersonalInfo(userId) {
      calls.push(["readPersonalInfo", userId]);
      return personInfo();
    },
    async writePersonalInfo(userId, fields) {
      calls.push(["writePersonalInfo", userId, fields]);
      return personInfo(fields as Partial<VaultPersonalInfoRecord>);
    },
    async listAgentItems(userId) {
      calls.push(["listAgentItems", userId]);
      return [item()];
    },
    async createAgentItem(userId, input) {
      calls.push(["createAgentItem", userId, input]);
      return item({ label: input.label });
    },
    async updateAgentItem(userId, id, patch) {
      calls.push(["updateAgentItem", userId, id, patch]);
      return item();
    },
    async removeAgentItem(userId, id) {
      calls.push(["removeAgentItem", userId, id]);
    },
    async readAgentItemSecret({ userId, id }) {
      calls.push(["readAgentItemSecret", userId, id]);
      return {
        id: id ?? "vault_item-1",
        label: "Stripe API key",
        kind: "api_key",
        value: "sk_live_abc",
        description: null,
        scope: "agent",
        scopeRef: null,
        allowedApps: [],
      };
    },
    async personalInfoFields(userId, fields) {
      calls.push(["personalInfoFields", userId, fields]);
      return { full_name: "John Doe" };
    },
  };

  return Object.assign(base, overrides, { calls });
}

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
  Promise.resolve(context.json({ error: "denied" }, 401));

function appFor(
  store: VaultStore,
  middleware: MiddlewareHandler<{ Variables: AppVariables }> = requireUser,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/vault", createVaultRoutes(store, middleware));
  return app;
}

async function json(response: Response) {
  return response.json();
}

/**
 * The patch one recorded call was given.
 *
 * Not `calls.find(...)?.at(3)` as a cast: an assertion that quietly passes when the call was never made
 * is the one way this file could stop noticing that a route stopped sending a field at all, which is
 * exactly what the "absent keeps the stored secret" tests are here to catch.
 */
function patchOf(calls: StoreCall[], method: string): Record<string, unknown> {
  const call = calls.find((entry) => entry[0] === method);
  if (!call) {
    throw new Error(`expected the route to call ${method}, and it did not`);
  }
  const patch = call[3];
  if (!patch || typeof patch !== "object") {
    throw new Error(`${method} was not given a patch`);
  }
  return patch as Record<string, unknown>;
}

/** Fails on the mere presence of the impostor's id anywhere in what the store was asked. */
function expectNoImpostor(calls: StoreCall[]) {
  const seen = JSON.stringify(calls);
  expect(seen).not.toContain(IMPOSTOR);
}

/*
 * Every route, every verb, with the impostor's id planted in the path, the query and the body.
 *
 * Written as one table rather than one test per route so that adding a route to `routes.ts` without
 * adding it here is visible: the list below is what this file claims to cover, and a reviewer reads it
 * against the router.
 */
const OWNER_TRIES: Array<{
  what: string;
  request: (app: Hono<{ Variables: AppVariables }>) => Promise<Response>;
}> = [
  {
    what: "GET /",
    request: (app) =>
      app.request(`http://remii.test/api/vault?userId=${IMPOSTOR}`),
  },
  {
    what: "GET /logins",
    request: (app) =>
      app.request(`http://remii.test/api/vault/logins?userId=${IMPOSTOR}`),
  },
  {
    what: "POST /logins",
    request: (app) =>
      app.request("http://remii.test/api/vault/logins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: IMPOSTOR,
          label: "Google",
          username: "me",
          password: "x",
        }),
      }),
  },
  {
    what: "PUT /logins/:id",
    request: (app) =>
      app.request("http://remii.test/api/vault/logins/vault_login-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: IMPOSTOR, label: "Renamed" }),
      }),
  },
  {
    what: "DELETE /logins/:id",
    request: (app) =>
      app.request(
        `http://remii.test/api/vault/logins/vault_login-1?userId=${IMPOSTOR}`,
        { method: "DELETE" },
      ),
  },
  {
    what: "POST /logins/:id/reveal",
    request: (app) =>
      app.request("http://remii.test/api/vault/logins/vault_login-1/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: IMPOSTOR }),
      }),
  },
  {
    what: "GET /cards",
    request: (app) =>
      app.request(`http://remii.test/api/vault/cards?userId=${IMPOSTOR}`),
  },
  {
    what: "POST /cards",
    request: (app) =>
      app.request("http://remii.test/api/vault/cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: IMPOSTOR,
          label: "Visa",
          cardNumber: "4242424242424242",
        }),
      }),
  },
  {
    what: "PUT /cards/:id",
    request: (app) =>
      app.request("http://remii.test/api/vault/cards/vault_card-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: IMPOSTOR, label: "Renamed" }),
      }),
  },
  {
    what: "DELETE /cards/:id",
    request: (app) =>
      app.request(
        `http://remii.test/api/vault/cards/vault_card-1?userId=${IMPOSTOR}`,
        { method: "DELETE" },
      ),
  },
  {
    what: "POST /cards/:id/reveal",
    request: (app) =>
      app.request("http://remii.test/api/vault/cards/vault_card-1/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: IMPOSTOR, field: "cvv" }),
      }),
  },
  {
    what: "GET /personal-info",
    request: (app) =>
      app.request(
        `http://remii.test/api/vault/personal-info?userId=${IMPOSTOR}`,
      ),
  },
  {
    what: "PUT /personal-info",
    request: (app) =>
      app.request("http://remii.test/api/vault/personal-info", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: IMPOSTOR, fullName: "Somebody Else" }),
      }),
  },
  {
    what: "GET /agent-items",
    request: (app) =>
      app.request(
        `http://remii.test/api/vault/agent-items?userId=${IMPOSTOR}`,
      ),
  },
  {
    what: "POST /agent-items",
    request: (app) =>
      app.request("http://remii.test/api/vault/agent-items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: IMPOSTOR,
          label: "Stripe",
          kind: "api_key",
          value: "sk_live",
        }),
      }),
  },
  {
    what: "PUT /agent-items/:id",
    request: (app) =>
      app.request("http://remii.test/api/vault/agent-items/vault_item-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: IMPOSTOR, label: "Renamed" }),
      }),
  },
  {
    what: "DELETE /agent-items/:id",
    request: (app) =>
      app.request(
        `http://remii.test/api/vault/agent-items/vault_item-1?userId=${IMPOSTOR}`,
        { method: "DELETE" },
      ),
  },
  {
    what: "POST /agent-items/:id/reveal",
    request: (app) =>
      app.request(
        "http://remii.test/api/vault/agent-items/vault_item-1/reveal",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: IMPOSTOR }),
        },
      ),
  },
];

describe("no route on this router takes an owner from the request", () => {
  for (const attempt of OWNER_TRIES) {
    test(attempt.what, async () => {
      const store = fakeStore();
      const response = await attempt.request(appFor(store));
      expect(response.status).not.toBe(401);
      expectNoImpostor(store.calls);
      // And the owner the store actually saw is the session's, on every one of them.
      expect(store.calls.length).toBeGreaterThan(0);
      for (const call of store.calls) {
        expect(call[1]).toBe(actor.id);
      }
    });
  }

  test("every route refuses an unauthenticated caller before it touches the vault", async () => {
    for (const attempt of OWNER_TRIES) {
      const store = fakeStore();
      const response = await attempt.request(appFor(store, denied));
      expect(response.status).toBe(401);
      expect(store.calls).toEqual([]);
    }
  });
});

describe("reading the vault", () => {
  test("GET / answers with all four sections and no secrets in any of them", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://remii.test/api/vault",
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(Object.keys(JSON.parse(text))).toEqual([
      "logins",
      "cards",
      "personalInfo",
      "agentItems",
    ]);
    // The fake answers with masks; the assertion is that this router adds nothing to them.
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("sk_live_abc");
  });

  test("the four lists are read from the session's owner", async () => {
    const store = fakeStore();
    await appFor(store).request("http://remii.test/api/vault");
    expect(store.calls.map((call) => call[0])).toEqual([
      "listLogins",
      "listCards",
      "readPersonalInfo",
      "listAgentItems",
    ]);
  });

  test("a missing personal info answers null rather than a row of empty strings", async () => {
    const store = fakeStore({
      async readPersonalInfo() {
        return null;
      },
    });
    const response = await appFor(store).request(
      "http://remii.test/api/vault/personal-info",
    );
    expect(await json(response)).toEqual({ personalInfo: null });
  });

  test("a row that is not the caller's answers 404 with the store's own sentence", async () => {
    const store = fakeStore({
      async readLoginSecret() {
        throw new VaultNotFoundError();
      },
    });
    const response = await appFor(store).request(
      "http://remii.test/api/vault/logins/vault_login-1/reveal",
      { method: "POST" },
    );
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      error: "That vault item does not exist.",
    });
  });

  test("a refused save answers 400 with the sentence, not a status code", async () => {
    const store = fakeStore({
      async createAgentItem() {
        throw new VaultRefusedError("Choose what kind of item this is.");
      },
    });
    const response = await appFor(store).request(
      "http://remii.test/api/vault/agent-items",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Stripe",
          kind: "nonsense",
          value: "sk",
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error: "Choose what kind of item this is.",
    });
  });
});

describe("revealing one secret", () => {
  test("answers with the value, and it is the only place one appears", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://remii.test/api/vault/logins/vault_login-1/reveal",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ value: "hunter2" });
  });

  test("is a POST, so a secret is never in a URL", async () => {
    const app = appFor(fakeStore());
    // A GET on the same path is not a route at all. Asserted because "the value is in the query
    // string" is the single worst version of this feature and is worth a test that says so.
    const response = await app.request(
      "http://remii.test/api/vault/logins/vault_login-1/reveal",
    );
    expect(response.status).toBe(404);
  });

  test("a card reveal asks which field, and refuses one it does not have", async () => {
    const store = fakeStore();
    const app = appFor(store);

    for (const field of ["number", "expiry", "cvv"]) {
      const response = await app.request(
        "http://remii.test/api/vault/cards/vault_card-1/reveal",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ field }),
        },
      );
      expect(response.status).toBe(200);
    }
    expect(store.calls.map((call) => call[1])).toEqual(Array(3).fill(actor.id));

    const refused = await app.request(
      "http://remii.test/api/vault/cards/vault_card-1/reveal",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "account" }),
      },
    );
    expect(refused.status).toBe(400);
  });

  test("says so when the stored card has no CVV, rather than answering empty", async () => {
    const store = fakeStore({
      async readCardSecret({ id }) {
        return {
          id: id ?? "vault_card-1",
          label: "Personal Visa",
          cardholderName: null,
          cardNumber: "4242424242424242",
          expiry: "04/29",
          cvv: null,
          billingAddress: null,
        };
      },
    });
    const response = await appFor(store).request(
      "http://remii.test/api/vault/cards/vault_card-1/reveal",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "cvv" }),
      },
    );
    // A 200 with an empty string would put a blank on the clipboard and look like a working copy.
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      error: "That card has no CVV saved.",
    });
  });
});

describe("editing without losing a secret", () => {
  test("a login edit that omits the password sends no password field at all", async () => {
    const store = fakeStore();
    await appFor(store).request(
      "http://remii.test/api/vault/logins/vault_login-1",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Renamed" }),
      },
    );

    const patch = patchOf(store.calls, "updateLogin");
    // "Absent keeps what is stored" and "empty clears it" are different things, and the wire has to be
    // able to say both. Sending "" here would delete a password somebody opened a dialog to rename.
    expect("password" in patch).toBe(false);
    expect(patch.label).toBe("Renamed");
  });

  test("a card edit that omits the CVV sends no CVV field", async () => {
    const store = fakeStore();
    await appFor(store).request(
      "http://remii.test/api/vault/cards/vault_card-1",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Renamed" }),
      },
    );

    const patch = patchOf(store.calls, "updateCard");
    expect("cvv" in patch).toBe(false);
    expect("cardNumber" in patch).toBe(false);
  });

  test("an emptied optional field is sent as null, which is how a note is cleared", async () => {
    const store = fakeStore();
    await appFor(store).request(
      "http://remii.test/api/vault/logins/vault_login-1",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes: "" }),
      },
    );

    expect(patchOf(store.calls, "updateLogin").notes).toBeNull();
  });
});

describe("deleting", () => {
  test("answers 204 and passes the owner through", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://remii.test/api/vault/agent-items/vault_item-1",
      { method: "DELETE" },
    );
    expect(response.status).toBe(204);
    expect(store.calls).toContainEqual([
      "removeAgentItem",
      actor.id,
      "vault_item-1",
    ]);
  });

  test("deleting somebody else's item answers 404 and deletes nothing", async () => {
    const store = fakeStore({
      async removeLogin() {
        throw new VaultNotFoundError();
      },
    });
    const response = await appFor(store).request(
      "http://remii.test/api/vault/logins/somebody-elses",
      { method: "DELETE" },
    );
    expect(response.status).toBe(404);
  });
});

describe("bodies", () => {
  test("a body that is not an object is a 400 rather than a save of nothing", async () => {
    const store = fakeStore();
    const app = appFor(store);

    for (const body of [
      JSON.stringify([]),
      JSON.stringify("nope"),
      "not json",
    ]) {
      const response = await app.request(
        "http://remii.test/api/vault/logins",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
      );
      expect(response.status).toBe(400);
      expect(store.calls).toEqual([]);
    }
  });

  test("personal info refuses a non-object body too, even though it has no path", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://remii.test/api/vault/personal-info",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(["nope"]),
      },
    );
    expect(response.status).toBe(400);
    expect(store.calls).toEqual([]);
  });
});
