import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
  ProtectedAgentError,
} from "../src/agents/profile-store";
import type {
  AgentProfile,
  CreateAgentInput,
} from "../src/agents/profile-types";
import { createAgentRoutes, parseAgentInput } from "../src/agents/routes";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createTestApp } from "./support/app";

const actor = {
  id: "user-1",
  email: "member@remii.test",
  role: "user",
} as const;

const validInput: CreateAgentInput = {
  name: "Expense Manager",
  title: "Finance Operations",
  roleDescription:
    "Review receipts, categorize expenses, and prepare reimbursement reports.",
  visibility: "private",
};

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent-1",
    name: validInput.name,
    title: validInput.title,
    roleDescription: validInput.roleDescription,
    avatarSeed: "expense-manager",
    visibility: validInput.visibility,
    ownerUserId: actor.id,
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    ...overrides,
  };
}

type StoreCall = [method: keyof AgentProfileStore, ...arguments_: unknown[]];

function fakeStore(
  overrides: Partial<AgentProfileStore> = {},
): AgentProfileStore & { calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const base: AgentProfileStore = {
    async list(receivedActor, hidden) {
      calls.push(["list", receivedActor, hidden]);
      return [profile()];
    },
    async get(receivedActor, id) {
      calls.push(["get", receivedActor, id]);
      return profile({ id });
    },
    async getWithin(_executor, receivedActor, id) {
      calls.push(["getWithin", receivedActor, id]);
      return profile({ id });
    },
    async create(receivedActor, input) {
      calls.push(["create", receivedActor, input]);
      return profile({ ...input });
    },
    async update(receivedActor, id, input) {
      calls.push(["update", receivedActor, id, input]);
      return profile({ id, ...input });
    },
    async duplicate(receivedActor, id) {
      calls.push(["duplicate", receivedActor, id]);
      return profile({ id: `${id}-copy`, visibility: "private" });
    },
    async setHidden(receivedActor, id, hidden) {
      calls.push(["setHidden", receivedActor, id, hidden]);
    },
    async softDelete(receivedActor, id) {
      calls.push(["softDelete", receivedActor, id]);
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

function appFor(
  store: AgentProfileStore,
  middleware: MiddlewareHandler<{ Variables: AppVariables }> = requireUser,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createAgentRoutes(store, middleware));
  return app;
}

async function json(response: Response) {
  return response.json();
}

describe("agent input parser", () => {
  test.each([[null], [[]], ["input"], [42], [true]])(
    "rejects a non-object root: %p",
    (input) => {
      expect(parseAgentInput(input)).toEqual({
        ok: false,
        error: "Agent input must be a JSON object.",
      });
    },
  );

  test.each([
    ["name", undefined, "Name must be text between 1 and 80 characters."],
    ["name", 12, "Name must be text between 1 and 80 characters."],
    ["name", "   ", "Name must be text between 1 and 80 characters."],
    ["name", "n".repeat(81), "Name must be text between 1 and 80 characters."],
    ["title", undefined, "Title must be text between 1 and 120 characters."],
    ["title", false, "Title must be text between 1 and 120 characters."],
    ["title", "\n\t", "Title must be text between 1 and 120 characters."],
    [
      "title",
      "t".repeat(121),
      "Title must be text between 1 and 120 characters.",
    ],
    [
      "roleDescription",
      undefined,
      "Role description must be text between 1 and 1000 characters.",
    ],
    [
      "roleDescription",
      {},
      "Role description must be text between 1 and 1000 characters.",
    ],
    [
      "roleDescription",
      "   ",
      "Role description must be text between 1 and 1000 characters.",
    ],
    [
      "roleDescription",
      "r".repeat(1001),
      "Role description must be text between 1 and 1000 characters.",
    ],
    /*
     * "Visibility must be private", and every one of these is refused — INCLUDING `"public"`, which
     * is what the first two rows used to expect to be accepted below.
     *
     * Individual-user SaaS has no public coworkers: `parseAgentInput` accepts the literal `"private"`
     * and nothing else, and the refusal says so. The old wording ("public or private") described a
     * product that had sharing, and a test asserting it would have kept a two-way door in the docs
     * that the code no longer has.
     */
    ["visibility", undefined, "Visibility must be private."],
    ["visibility", 1, "Visibility must be private."],
    ["visibility", "   ", "Visibility must be private."],
    ["visibility", "friends", "Visibility must be private."],
    ["visibility", "public", "Visibility must be private."],
  ])("rejects invalid %s values", (field, value, error) => {
    expect(parseAgentInput({ ...validInput, [field]: value })).toEqual({
      ok: false,
      error,
    });
  });

  test.each([
    ["name", "n", "n"],
    ["name", ` ${"n".repeat(80)} `, "n".repeat(80)],
    ["title", "t", "t"],
    ["title", ` ${"t".repeat(120)} `, "t".repeat(120)],
    ["roleDescription", "r", "r"],
    ["roleDescription", ` ${"r".repeat(1000)} `, "r".repeat(1000)],
    // Only `private`, and only once the surrounding whitespace is gone.
    ["visibility", " private ", "private"],
  ])("accepts and trims boundary %s values", (field, value, trimmed) => {
    const result = parseAgentInput({ ...validInput, [field]: value });

    expect(result).toEqual({
      ok: true,
      value: { ...validInput, [field]: trimmed },
    });
  });

  test("trims every accepted field and ignores forged fields", () => {
    expect(
      parseAgentInput({
        name: "  Expense Manager  ",
        title: "  Finance Operations  ",
        roleDescription: "  Reviews receipts.  ",
        visibility: " private ",
        id: "forged-agent",
        ownerUserId: "attacker",
        avatarSeed: "forged-avatar",
        deletedAt: "now",
        systemOwned: true,
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "Expense Manager",
        title: "Finance Operations",
        roleDescription: "Reviews receipts.",
        visibility: "private",
      },
    });
  });

  test("refuses an address or a key rather than dropping them", () => {
    // Silently ignoring either would let an old build believe it had pointed a Bot at an address of
    // its own, which is the belief this route exists to remove. Loudly refusing is the whole answer.
    expect(
      parseAgentInput({
        ...validInput,
        endpoint: "https://agents.example.com/ag-ui",
      }),
    ).toMatchObject({ ok: false });
    expect(parseAgentInput({ ...validInput, auth: { value: "Bearer x" } })).toMatchObject({
      ok: false,
    });
    // Absent is still fine: the deployment decides where a coworker runs.
    expect(parseAgentInput({ ...validInput, endpoint: undefined })).toMatchObject({
      ok: true,
    });
  });
});

describe("agent lifecycle routes", () => {
  test("attaches authentication middleware to every route before calling the store", async () => {
    const store = fakeStore();
    const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
      Promise.resolve(context.json({ error: "denied" }, 401));
    const app = appFor(store, denied);
    const requests: [string, RequestInit?][] = [
      ["/"],
      ["/agent-1"],
      ["/", { method: "POST", body: JSON.stringify(validInput) }],
      ["/agent-1", { method: "PATCH", body: JSON.stringify(validInput) }],
      ["/agent-1/duplicate", { method: "POST" }],
      ["/agent-1/hide", { method: "POST" }],
      ["/agent-1/unhide", { method: "POST" }],
      ["/agent-1", { method: "DELETE" }],
    ];

    for (const [path, init] of requests) {
      const response = await app.request(`http://remii.test${path}`, init);
      expect(response.status).toBe(401);
    }
    expect(store.calls).toEqual([]);
  });

  test("uses only the authenticated context actor and parses hidden as exact true", async () => {
    const store = fakeStore();
    const app = appFor(store);

    for (const query of [
      "",
      "?hidden=false",
      "?hidden=True",
      "?hidden=1",
      "?hidden=true",
    ]) {
      expect((await app.request(`http://remii.test/${query}`)).status).toBe(
        200,
      );
    }

    expect(store.calls).toEqual([
      ["list", actor, false],
      ["list", actor, false],
      ["list", actor, false],
      ["list", actor, false],
      ["list", actor, true],
    ]);
  });

  test("serves every lifecycle route with its contract status and store operation", async () => {
    const store = fakeStore();
    const app = appFor(store);

    const list = await app.request("http://remii.test/");
    const detail = await app.request("http://remii.test/agent-1");
    const created = await app.request("http://remii.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validInput),
    });
    const updated = await app.request("http://remii.test/agent-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validInput),
    });
    const duplicated = await app.request(
      "http://remii.test/agent-1/duplicate",
      {
        method: "POST",
      },
    );
    const hidden = await app.request("http://remii.test/agent-1/hide", {
      method: "POST",
    });
    const unhidden = await app.request("http://remii.test/agent-1/unhide", {
      method: "POST",
    });
    const deleted = await app.request("http://remii.test/agent-1", {
      method: "DELETE",
    });

    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(created.status).toBe(201);
    expect(updated.status).toBe(200);
    expect(duplicated.status).toBe(201);
    expect(hidden.status).toBe(204);
    expect(unhidden.status).toBe(204);
    expect(deleted.status).toBe(204);
    expect(store.calls).toEqual([
      ["list", actor, false],
      ["get", actor, "agent-1"],
      /*
       * `create` carries a system prompt and `update` does not, and that difference is the point.
       * There is no address to name any more, so the role description is the only instruction a
       * coworker can be given and the store is handed it on every create — on a deployment with its
       * own engine the store uses that to run the Bot here, and on one without, to refuse with a
       * sentence rather than create a Bot that answers nobody. `update` is deliberately untouched:
       * changing an existing Bot's type is a different act and must not happen through the edit path.
       */
      [
        "create",
        actor,
        { ...validInput, systemPrompt: validInput.roleDescription },
      ],
      ["update", actor, "agent-1", validInput],
      ["duplicate", actor, "agent-1"],
      ["setHidden", actor, "agent-1", true],
      ["setHidden", actor, "agent-1", false],
      ["softDelete", actor, "agent-1"],
    ]);
  });

  test("refuses a create or update that carries an address or a key", async () => {
    const store = fakeStore();
    const app = appFor(store);

    const created = await app.request("http://remii.test/", {
      method: "POST",
      body: JSON.stringify({
        ...validInput,
        endpoint: "https://agents.example.com/ag-ui",
      }),
    });
    const updated = await app.request("http://remii.test/agent-1", {
      method: "PATCH",
      body: JSON.stringify({
        ...validInput,
        auth: { header: "Authorization", value: "Bearer leaked" },
      }),
    });

    // Refused rather than ignored: an old build that sent either would believe it had pointed a
    // Bot at an address of its own, which is exactly the belief this route exists to remove.
    expect(created.status).toBe(400);
    expect(updated.status).toBe(400);
    expect(store.calls.filter(([op]) => op === "create" || op === "update")).toEqual(
      [],
    );
  });

  test("projects exact DTO fields and computes permissions for the authenticated actor", async () => {
    const store = fakeStore({
      async list() {
        return [
          profile(),
          profile({ id: "agent-2", ownerUserId: "user-2" }),
          profile({
            id: "system-agent",
            ownerUserId: null,
            systemOwned: true,
            visibility: "public",
          }),
        ];
      },
    });

    const response = await appFor(store).request("http://remii.test/");

    expect(await json(response)).toEqual({
      agents: [
        {
          id: "agent-1",
          name: validInput.name,
          title: validInput.title,
          roleDescription: validInput.roleDescription,
          avatarSeed: "expense-manager",
          visibility: "private",
          hidden: false,
          systemOwned: false,
          canManage: true,
          mine: true,
        },
        {
          id: "agent-2",
          name: validInput.name,
          title: validInput.title,
          roleDescription: validInput.roleDescription,
          avatarSeed: "expense-manager",
          visibility: "private",
          hidden: false,
          systemOwned: false,
          canManage: false,
          mine: false,
        },
        {
          id: "system-agent",
          name: validInput.name,
          title: validInput.title,
          roleDescription: validInput.roleDescription,
          avatarSeed: "expense-manager",
          visibility: "public",
          hidden: false,
          systemOwned: true,
          canManage: false,
          mine: false,
        },
      ],
    });
  });

  test("separates ownership from permission, and neither is another person's to claim", async () => {
    /*
     * WAS "separates ownership from permission for an administrator", and it asserted
     * `canManage: true` on somebody ELSE's coworker. There is no administrator override left:
     * `canManageAgent` is `agent.ownerUserId === actor.id` and nothing else, which is why
     * `RemiiRole` is the literal type `"user"` — an admin bypass is unrepresentable rather than
     * merely unused.
     *
     * The distinction this test exists for survives that change, and it is worth more now: a store
     * whose `list()` did not filter would hand back a row belonging to somebody else, and the ONLY
     * thing standing between that and the screen is the flag on the row. So both are asserted for
     * both rows — `mine` false and `canManage` false for the other person's, and both true for the
     * caller's own. A roster that conflated them would be right again the moment a store regressed.
     */
    const administrator: AuthenticatedActor = {
      id: "admin-1",
      email: "admin@remii.test",
      role: "user",
    };
    const asAdministrator: MiddlewareHandler<{
      Variables: AppVariables;
    }> = async (context, next) => {
      context.set("actor", administrator);
      await next();
    };
    const store = fakeStore({
      async list() {
        return [
          profile({ id: "theirs", ownerUserId: "user-1" }),
          profile({ id: "ours", ownerUserId: administrator.id }),
        ];
      },
    });

    const body = (await json(
      await appFor(store, asAdministrator).request("http://remii.test/"),
    )) as { agents: { id: string; canManage: boolean; mine: boolean }[] };

    expect(body.agents).toEqual([
      expect.objectContaining({ id: "theirs", canManage: false, mine: false }),
      expect.objectContaining({ id: "ours", canManage: true, mine: true }),
    ]);
  });

  test("a system template is reachable but not manageable, by anybody", async () => {
    /*
     * The one case where the two flags genuinely differ, and the reason they are separate fields.
     * A `systemOwned` row is a DEFINITION the deployment ships — there is no single owner to manage,
     * so `canManage` is false even to the person whose id happens to match — while `canAccess` is
     * true, so using one is what a template is for.
     */
    const owner: AuthenticatedActor = {
      id: "user-1",
      email: "user@remii.test",
      role: "user",
    };
    const asOwner: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", owner);
      await next();
    };
    const store = fakeStore({
      async list() {
        return [
          profile({ id: "template", ownerUserId: owner.id, systemOwned: true }),
          profile({ id: "personal", ownerUserId: owner.id }),
        ];
      },
    });

    const body = (await json(
      await appFor(store, asOwner).request("http://remii.test/"),
    )) as {
      agents: {
        id: string;
        canManage: boolean;
        mine: boolean;
        systemOwned: boolean;
      }[];
    };

    expect(body.agents).toEqual([
      expect.objectContaining({
        id: "template",
        systemOwned: true,
        canManage: false,
        mine: true,
      }),
      expect.objectContaining({
        id: "personal",
        systemOwned: false,
        canManage: true,
        mine: true,
      }),
    ]);
  });

  test("never forwards forged create or update fields", async () => {
    const store = fakeStore();
    const app = appFor(store);
    const body = {
      name: "  Expense Manager  ",
      title: "  Finance Operations  ",
      roleDescription: `  ${validInput.roleDescription}  `,
      visibility: " private ",
      id: "forged-agent",
      ownerUserId: "attacker",
      avatarSeed: "forged-avatar",
      deletedAt: "now",
      systemOwned: true,
    };

    for (const [path, method] of [
      ["/", "POST"],
      ["/agent-1", "PATCH"],
    ] as const) {
      const response = await app.request(`http://remii.test${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(method === "POST" ? 201 : 200);
    }

    expect(store.calls).toEqual([
      ["create", actor, { ...validInput, systemPrompt: validInput.roleDescription }],
      ["update", actor, "agent-1", validInput],
    ]);
  });

  test.each([
    ["POST", "/"],
    ["PATCH", "/agent-1"],
  ])("requires a valid full JSON object for %s %s", async (method, path) => {
    const store = fakeStore();
    const app = appFor(store);
    const malformed = await app.request(`http://remii.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const partial = await app.request(`http://remii.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Only a name" }),
    });

    expect(malformed.status).toBe(400);
    expect(await json(malformed)).toEqual({
      error: "Agent input must be a JSON object.",
    });
    expect(partial.status).toBe(400);
    expect(await json(partial)).toEqual({
      error: "Title must be text between 1 and 120 characters.",
    });
    expect(store.calls).toEqual([]);
  });

  test("returns 404 when get returns null", async () => {
    const store = fakeStore({ get: async () => null });

    const response = await appFor(store).request("http://remii.test/missing");

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: "Agent not found." });
  });

  test.each([
    [new AgentNotFoundError("agent-1"), 404, "Agent not found."],
    [
      new AgentNotManageableError("agent-1"),
      403,
      "You do not have permission to manage this agent.",
    ],
    [
      new ProtectedAgentError("agent-1"),
      403,
      "System-owned agents are protected.",
    ],
  ])("maps known store errors", async (error, status, message) => {
    const store = fakeStore({
      update: async () => {
        throw error;
      },
    });

    const response = await appFor(store).request(
      "http://remii.test/agent-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validInput),
      },
    );

    expect(response.status).toBe(status);
    expect(await json(response)).toEqual({ error: message });
  });

  test("rethrows unexpected errors to the outer Hono error handler", async () => {
    const store = fakeStore({
      duplicate: async () => {
        throw new Error("database disconnected");
      },
    });
    const app = appFor(store);
    app.onError((error, context) =>
      context.json({ sentinel: error.message }, 599),
    );

    const response = await app.request(
      "http://remii.test/agent-1/duplicate",
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(599);
    expect(await json(response)).toEqual({ sentinel: "database disconnected" });
  });
});

describe("agent route composition", () => {
  test("mounts the store behind createApp authentication with the derived actor", async () => {
    const store = fakeStore();
    let session: {
      user: { id: string; email: string; name: string; image: string };
    } | null = null;
    /*
     * The store is NAMED, and the session is a FUNCTION.
     *
     * Both because of what this test is about. It signs out, asks, signs in, and asks again — so the
     * auth service has to be read per request, which a fixed person cannot express. And the store used
     * to be placed by counting six `undefined` down to position 10; every parameter from the fourth
     * onwards is optional, so a count that drifts is a silent `tsc` pass and a 404 at runtime for a
     * reason that names nothing. `support/app.ts` fills the holes from the signature instead.
     */
    const app = createTestApp({
      session: () => session,
      parts: { agentProfileStore: store },
    });

    const unauthenticated = await app.request("http://remii.test/api/agents");
    expect(unauthenticated.status).toBe(401);
    expect(store.calls).toEqual([]);

    session = {
      user: {
        id: actor.id,
        email: actor.email,
        name: "Remii Member",
        image: "https://example.test/member.png",
      },
    };
    const authenticated = await app.request("http://remii.test/api/agents");

    expect(authenticated.status).toBe(200);
    expect(store.calls).toEqual([
      [
        "list",
        {
          ...actor,
          name: "Remii Member",
          image: "https://example.test/member.png",
        },
        false,
      ],
    ]);
  });

  test("leaves agent routes unmounted when createApp has no store", async () => {
    const app = createTestApp();

    const response = await app.request("http://remii.test/api/agents");

    expect(response.status).toBe(404);
  });
});

/*
 * The screen that grants one Bot the right to address another reads this, so what it renders is
 * decided here rather than in the browser: whether the capability is on at all, and whether the
 * person looking may change any of it.
 */
describe("which Bots a Bot may hand work to", () => {
  const admin = {
    id: "admin-1",
    email: "a@remii.test",
    role: "admin",
  } as const;

  function appWith(
    handoff: Parameters<typeof createAgentRoutes>[5],
    who: { id: string; email: string; role: "admin" | "user" } = admin,
  ) {
    const app = new Hono<{ Variables: AppVariables }>();
    const asWho: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", who);
      await next();
    };
    app.route(
      "/",
      createAgentRoutes(fakeStore(), asWho, undefined, handoff),
    );
    return app;
  }

  test("reports the grants, and lets the owner change them", async () => {
    const app = appWith({
      enabled: true,
      reachableFrom: async () => ["knowledge"],
    });

    const body = (await json(
      await app.request("/general-assistant/handoff"),
    )) as {
      handoff: { enabled: boolean; canGrant: boolean; reachable: string[] };
    };

    expect(body.handoff).toEqual({
      enabled: true,
      canGrant: true,
      reachable: ["knowledge"],
      // No runsHere reader was wired, and a Bot nothing can vouch for is not offered grants.
      grantable: false,
    });
  });

  test("granting is the Bot's own, so every signed-in person may grant", async () => {
    /*
     * WAS "somebody who is not an administrator may read it and not change it", asserting
     * `canGrant: false` for a plain user. There is no administrator to be: `RemiiRole` is the
     * literal type `"user"`, so the flag used to be a constant that always said `false` to everybody,
     * and the route now answers `true` with the reason written beside it — "Granting is the owner's:
     * nobody may wire another person's Bot into their own."
     *
     * That is the right answer for this product rather than a loosened one: the Bot in question was
     * fetched through `store.get(actor, agentId)`, so a caller who cannot see it already got a 404
     * above this line. What is left to decide is whether the caller may WIRE IT, and a person wiring
     * their own coworker into their own conversation is the feature, not an escalation.
     *
     * So the test now pins the property that is actually load-bearing — a Bot somebody else owns is
     * not reachable here — rather than a permission tier that no longer exists.
     */
    const app = appWith(
      { enabled: true, reachableFrom: async () => ["knowledge"] },
      actor,
    );

    const body = (await json(
      await app.request("/general-assistant/handoff"),
    )) as {
      handoff: { canGrant: boolean; enabled: boolean; reachable: string[] };
    };

    expect(body.handoff.canGrant).toBe(true);
    // The two things that still decide what the screen offers.
    expect(body.handoff.enabled).toBe(true);
    expect(body.handoff.reachable).toEqual(["knowledge"]);
  });

  test("a Bot the caller cannot see is not found, so granting cannot reach it", async () => {
    /*
     * The store says no, so the route answers 404 rather than a handoff object. This is the check
     * that replaced the permission tier: `store.get(context.var.actor, agentId)` is asked about
     * somebody's Bot by the person asking, and a row that is not theirs comes back absent — which is
     * the same answer as a Bot that does not exist.
     */
    const app = new Hono<{ Variables: AppVariables }>();
    const asWho: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", { ...actor, role: "user" });
      await next();
    };
    app.route(
      "/",
      createAgentRoutes(
        fakeStore({
          // Asked for a Bot that is not this person's, so the store declines to describe it.
          async get() {
            return null;
          },
        }),
        asWho,
        undefined,
        { enabled: true, reachableFrom: async () => ["knowledge"] },
      ),
    );

    const response = await app.request("/somebody-elses/handoff");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Agent not found.",
    });
  });

  /*
   * A deployment with the caps at zero, or with no plugin store to read a grant from, has the
   * capability switched off. Reported rather than left to the screen to infer, because a switch
   * wired to nothing is the thing this says out loud.
   */
  test("says the capability is off when nothing can grant it", async () => {
    const app = appWith(undefined);

    const body = (await json(
      await app.request("/general-assistant/handoff"),
    )) as {
      handoff: { enabled: boolean; reachable: string[] };
    };

    expect(body.handoff.enabled).toBe(false);
    expect(body.handoff.reachable).toEqual([]);
  });

  test("a Bot the person may not see is not found, rather than described", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createAgentRoutes(
        fakeStore({
          async get() {
            return null;
          },
        }),
        requireUser,
        undefined,
        { enabled: true, reachableFrom: async () => ["knowledge"] },
      ),
    );

    const response = await app.request("/somebody-elses/handoff");

    expect(response.status).toBe(404);
  });
});
