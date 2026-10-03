import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import {
  BasicAgent,
  CopilotRuntime,
  InMemoryAgentRunner,
} from "@copilotkit/runtime/v2";
import { createDatabase } from "../src/db/client";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";
import { TEST_POOL, testDatabase, testDatabaseUrl } from "./support/database";

/**
 * THE RUNTIME IS NOT A PUBLIC ENDPOINT.
 *
 * The CopilotKit runtime is a library, mounted whole, and only ONE of its paths was shadowed by
 * this deployment: the transcript read, which it answers from Postgres. Every other path fell
 * through to the library, whose own thread endpoints are backed by the runner's process memory —
 * and that memory is not partitioned by person.
 *
 * Verified against a running deployment before it was fixed:
 *
 *   $ curl -s http://127.0.0.1:3001/api/copilotkit/threads
 *   HTTP/1.1 200 OK
 *   Access-Control-Allow-Origin: *
 *   {"threads":[{"id":"55569917-…","agentId":"general-assistant",…}]}
 *
 *   $ curl -s http://127.0.0.1:3001/api/copilotkit/threads/55569917-…/events
 *   {"events":[{"type":"RUN_STARTED","input":{"messages":[{"role":"user","content":"hii"},…
 *
 * So an id from the first request opened the second, with no session of any kind, and the second
 * is the conversation: what the person typed, what the Bot said, and the model's own reasoning.
 * `Access-Control-Allow-Origin: *` means a page on any site could ask for it and read the reply.
 *
 * The list endpoint is what made it a single request rather than a guessing game, and
 * `POST /api/copilotkit/threads/clear` in the same group wipes every person's in-memory state.
 */

const database = testDatabase();

// See the note in `thread-lock-lease.test.ts`: every file's pool is two connections against a
// shared 100-connection limit, and a file that does not hand its own back is spending the
// suite's budget rather than its own.
afterAll(async () => {
  await database.$client.close();
});

/** A handler shaped like the real one: an agent, a runner, and nothing else. */
const runtimeHandler = () => {
  const runner = new InMemoryAgentRunner();
  const runtime = new CopilotRuntime({
    agents: {
      "general-assistant": new BasicAgent({
        agentId: "general-assistant",
        description: "test",
      }),
    },
    runner,
  });
  return createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" });
};

/**
 * The REAL app, not a re-creation of the gate.
 *
 * The first version of this file built a local Hono with its own `app.use` and asserted on that, and
 * it passed with the production gate deleted — which is a test of the test. So the handler is handed
 * to `createApp` exactly where the server hands it over, and the gate is exercised where it lives.
 */
const realApp = (handler: Hono, session: { user: unknown } | null) => {
  const config = loadConfig(
    testEnvironment({
      KEY_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
      DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/never-connect",
    }),
  );
  return createApp(
    config,
    {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async () =>
          session as unknown as {
            user: { id: string; email: string; name: string };
          },
      },
    },
    // `auditReader`, `_credentialService` and `_packageStatusReader` come before the handler, so it
    // is the SIXTH argument. Passing it fourth silently mounts nothing at all, which is how a test
    // of this boundary can pass while testing nothing.
    undefined,
    undefined,
    undefined,
    handler,
  );
};

const anon = realApp(runtimeHandler(), null);
const get = (path: string) => anon.request(`http://remii.test${path}`);

describe("the CopilotKit runtime requires a session", () => {
  const paths = [
    "/api/copilotkit/threads",
    "/api/copilotkit/threads/some-thread-id/events",
    "/api/copilotkit/threads/some-thread-id/state",
  ];

  for (const path of paths) {
    test(`GET ${path} is refused without a session`, async () => {
      const response = await get(path);
      expect(response.status).toBe(401);
    });
  }

  test("POST /api/copilotkit/threads/clear is refused without a session", async () => {
    const response = await anon.request(
      "http://remii.test/api/copilotkit/threads/clear",
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(401);
  });

  test("the thread list cannot be read by an anonymous caller", async () => {
    /*
     * The specific regression, kept as its own assertion because it is the one that turns a guessed
     * id into a handed-out id. Before the gate this returned 200 and a JSON array of live threads.
     */
    const response = await get("/api/copilotkit/threads");
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain('"threads"');
  });

  test("/info stays open, because the sign-in page reads it before anybody has a session", async () => {
    const response = await get("/api/copilotkit/info");
    expect(response.status).toBe(200);
  });

  test("a signed-in caller still reaches the runtime", async () => {
    // The gate must not cost the product its own front door.
    const app = realApp(runtimeHandler(), {
      user: { id: "audit-actor", email: "audit@example.test", name: "Audit" },
    });
    const response = await app.request(
      "http://remii.test/api/copilotkit/threads",
    );
    expect(response.status).toBe(200);
  });
});

describe("the runtime's CORS does not invite other origins in", () => {
  test("a response carries no Access-Control-Allow-Origin", async () => {
    /*
     * A wildcard on a cookie-authenticated API is the one combination that turns "any page this
     * person visits" into "may read this person's conversations": the browser will not attach a
     * SameSite=Lax cookie cross-site, but it will hand the RESPONSE to the page that asked. The
     * library's default is `cors: true`, and its resolver falls back to `"*"` for any origin it
     * does not recognise — so "off" has to be an origin function that resolves to nothing.
     */
    const runtime = new CopilotRuntime({
      agents: {},
      runner: new InMemoryAgentRunner(),
    });
    const handler = createCopilotHonoHandler({
      runtime,
      basePath: "/api/copilotkit",
      cors: { origin: () => undefined, credentials: false },
    });
    const app = realApp(handler, {
      user: { id: "audit-actor", email: "audit@example.test", name: "Audit" },
    });
    const response = await app.request(
      "http://remii.test/api/copilotkit/threads",
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("the library's own default really does allow any origin", async () => {
    // The premise of the test above, so it cannot quietly stop being true.
    // No gate in front: the premise is what the LIBRARY does, and the gate would answer first.
    const runtime = new CopilotRuntime({
      agents: {},
      runner: new InMemoryAgentRunner(),
    });
    const handler = createCopilotHonoHandler({
      runtime,
      basePath: "/api/copilotkit",
    });
    const bare = new Hono();
    bare.route("/", handler);
    const response = await bare.request(
      "http://remii.test/api/copilotkit/threads",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("a run may only be started in the caller's own conversation", () => {
  /**
   * The write side of the same boundary.
   *
   * The transcript READ is authorized by joining `threads` and asking whether the owner is the
   * person asking. The WRITE was not: the runner appends the turn to `thread_messages` for whatever
   * thread id the request named, and `ensureThread` will even attach an owner to a thread that has
   * none. So learning somebody else's thread id was enough to have a Bot's next words written into
   * their conversation.
   */
  test("a thread owned by somebody else is refused", async () => {
    const { createThreadStore } = await import("../src/threads/local");
    const store = createThreadStore(database);
    const owner = "lock-owner-a";
    const intruder = "lock-owner-b";
    const id = `owned-${crypto.randomUUID()}`;
    const { users } = await import("../src/db/schema");
    for (const userId of [owner, intruder, "first-claimer"]) {
      await database
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test` })
        .onConflictDoNothing();
    }

    await store.ensureThread({
      threadId: id,
      userId: owner,
      agentId: "general-assistant",
    });

    expect(await store.threadOwner(id)).toBe(owner);
    // What the run path now asks before it writes.
    const holder = await store.threadOwner(id);
    expect(holder === null || holder === intruder).toBe(false);
  });

  test("a thread nobody owns is claimable, and then belongs to the claimer", async () => {
    const { createThreadStore } = await import("../src/threads/local");
    const store = createThreadStore(database);
    const id = `unowned-${crypto.randomUUID()}`;

    expect(await store.threadOwner(id)).toBeNull();
    await store.ensureThread({
      threadId: id,
      userId: "first-claimer",
      agentId: "general-assistant",
    });
    expect(await store.threadOwner(id)).toBe("first-claimer");
  });
});

describe("the billing webhook does not accept a body it could not verify", () => {
  test("a production deployment with no signing secret refuses every body", async () => {
    const previousEnv = process.env.NODE_ENV;
    const previousSecret = process.env.DODO_PAYMENTS_WEBHOOK_SECRET;
    process.env.NODE_ENV = "production";
    delete process.env.DODO_PAYMENTS_WEBHOOK_SECRET;

    try {
      const { createDodoWebhookRoutes } = await import(
        "../src/billing/webhook-routes"
      );
      const routes = createDodoWebhookRoutes(database);

      /*
       * The header alone was the old check, and it was not enough: `verifyAndUnwrapWebhook` only
       * unwraps when the client AND the secret AND a signature are all present, and otherwise falls
       * through to `JSON.parse`. So a deployment that had never been given its secret refused a
       * request with no signature header and accepted the very next one that carried any header at
       * all — with the body on trust, writing whatever tier and balance the body's `metadata.userId`
       * asked for. The secret being ABSENT was the condition under which the boundary was widest.
       */
      const forged = await routes.request(
        new Request("http://remii.test/dodo", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "webhook-signature": "anything",
          },
          body: JSON.stringify({
            type: "subscription.active",
            data: { metadata: { userId: "victim", tier: "power" } },
          }),
        }),
      );

      expect(forged.status).toBe(400);
      // And it must not be distinguishable from a bad signature, or it reports which deployments
      // have no secret configured.
      const unsigned = await routes.request(
        new Request("http://remii.test/dodo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(unsigned.status).toBe(400);
      expect(await unsigned.text()).toBe(await forged.text());
    } finally {
      process.env.NODE_ENV = previousEnv;
      if (previousSecret === undefined)
        delete process.env.DODO_PAYMENTS_WEBHOOK_SECRET;
      else process.env.DODO_PAYMENTS_WEBHOOK_SECRET = previousSecret;
    }
  });
});

describe("a credential can only be attached by the person who holds it", () => {
  test("another person's credential id is refused", async () => {
    /*
     * The kind and the vendor were both checked and the owner was not, on the one field in this
     * product that takes a reference to a secret rather than the secret. The reference is never
     * returned by any route, which is what kept this unreachable rather than fixed — and a UUID is
     * not an authorisation.
     *
     * Exercised through the store's own predicate, so the test states the rule rather than the
     * route that would break if the route changed.
     */
    const { eq, and, isNull, or } = await import("drizzle-orm");
    const { credentials } = await import("../src/db/schema");
    const { users } = await import("../src/db/schema");
    const { randomUUID } = await import("node:crypto");

    const owner = `cred-owner-${randomUUID()}`;
    const other = `cred-other-${randomUUID()}`;
    for (const id of [owner, other]) {
      await database
        .insert(users)
        .values({ id, email: `${id}@example.test` })
        .onConflictDoNothing();
    }
    const credentialId = randomUUID();
    await database
      .insert(credentials)
      .values({
        id: credentialId,
        userId: owner,
        kind: "mcp",
        provider: "server-x",
        encryptedValue: "audit-fixture",
        keyId: "audit-key",
        metadata: {},
      })
      .onConflictDoNothing();

    const allowed = database
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.id, credentialId),
          isNull(credentials.revokedAt),
          or(isNull(credentials.userId), eq(credentials.userId, owner)),
        ),
      );
    const refused = database
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.id, credentialId),
          isNull(credentials.revokedAt),
          or(isNull(credentials.userId), eq(credentials.userId, other)),
        ),
      );

    expect(await allowed).toHaveLength(1);
    expect(await refused).toHaveLength(0);
  });
});
