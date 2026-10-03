import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createAgentRoutes } from "../src/agents/routes";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";

/**
 * The actions that change what a Bot is, and what it can reach.
 *
 * The trail recorded every mouse movement a Bot made and nothing about the Bot itself. Ten mutating
 * routes wrote one audit row between them, and there was no event type for any of the other nine, so
 * this was a missing vocabulary before it was a missing call.
 *
 * A Bot's endpoint is where conversation content is sent and its callback token is a capability
 * handed to somebody else's infrastructure. "Who pointed this Bot at that host, and when" is the
 * first question asked in an incident and the trail could not answer it.
 */

const ACTOR = { id: "u1", email: "admin@remii.test", role: "admin" } as const;

function app(overrides: Record<string, unknown> = {}) {
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };

  const store = {
    get: async (_actor: unknown, id: string) =>
      id === "bot-1" ? { id: "bot-1", name: "Sales" } : null,
    create: async () => ({ id: "bot-1", name: "Sales" }),
    update: async () => ({ id: "bot-1", name: "Sales" }),
    duplicate: async () => ({ id: "bot-2", name: "Sales copy" }),
    setHidden: async () => undefined,
    softDelete: async () => undefined,
    issueCallbackToken: async () => "the-token-nobody-records",
    revokeCallbackToken: async () => undefined,
    ...overrides,
  } as never;

  const requireUser: MiddlewareHandler = async (context, next) => {
    context.set("actor", ACTOR);
    await next();
  };

  const routes = createAgentRoutes(store, requireUser, auditStore);
  return { rows, hono: new Hono().route("/api/agents", routes) };
}

type MiddlewareHandler = Parameters<typeof createAgentRoutes>[1];

/**
 * Everything the input parser insists on, so a test about auditing is not a test about validation.
 *
 * `private`, not `public`. Public sharing was removed — the parser answers `visibility: "public"`
 * with a 400 before it reaches the audit store — so every request here was refused at the edge and
 * `rows` stayed empty. That reads as "nothing is audited" rather than as "the request never got that
 * far", which is the failure this file exists to catch.
 */
const VALID = {
  name: "Sales",
  title: "Sales assistant",
  roleDescription: "Helps with sales questions.",
  visibility: "private",
};

const json = (body: Record<string, unknown>) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...VALID, ...body }),
});

describe("what a Bot is, on the trail", () => {
  test("creating one records who made it", async () => {
    const { rows, hono } = app();

    await hono.request("http://t/api/agents", json({}));

    expect(rows[0]?.eventType).toBe("bot.created");
    expect(rows[0]?.targetId).toBe("bot-1");
    expect(rows[0]?.payload.name).toBe(VALID.name);
    expect(rows[0]?.actorUserId).toBe("u1");
  });

  /*
   * WAS "creating one records the endpoint it was pointed at" and "repointing one records where to",
   * the second of which this file called the dangerous edit because it decides which host
   * conversation content is sent to.
   *
   * Both are gone rather than unrecorded: nobody can point a Bot at an address any more. Every
   * coworker runs on the engine this deployment runs, so there is no host for a create to record and
   * no repointing for an edit to perform. Asserted as a refusal below, because "the trail stopped
   * recording it" and "it can no longer happen" look identical from outside.
   */
  test.each([
    ["create", "http://t/api/agents", "POST"],
    ["edit", "http://t/api/agents/bot-1", "PATCH"],
  ])(
    "a %s that names an address is refused, and writes nothing",
    async (_which, path, method) => {
      const { rows, hono } = app();

      const response = await hono.request(path, {
        ...json({ endpoint: "https://partner.example/ag-ui" }),
        method,
      });

      expect(response.status).toBe(400);
      expect(rows).toEqual([]);
    },
  );

  test("a create that carries a key is refused, and writes nothing", async () => {
    const { rows, hono } = app();

    const response = await hono.request("http://t/api/agents", {
      ...json({
        auth: { header: "Authorization", value: "Bearer sk-do-not-log-me" },
      }),
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(rows).toEqual([]);
  });

  /*
   * The other dangerous edit, and the one the trail was silent about.
   *
   * `visibility` is not a display preference. `accessFilter` admits a public coworker to every
   * signed-in person, and `canRunAgent` is `canAccessAgent`, so public hands everybody in the
   * deployment the right to act as this Bot and spend the connector grants it holds. It is one click
   * in the coworker dialog.
   */
  test("creating one records who may reach it", async () => {
    const { rows, hono } = app();

    await hono.request("http://t/api/agents", json({ visibility: "private" }));

    expect(rows[0]?.eventType).toBe("bot.created");
    expect(rows[0]?.payload.visibility).toBe("private");
  });

  test("opening one to the whole deployment is refused, and nothing is written", async () => {
    /*
     * WAS "opening one to the whole deployment says so", asserting an audited `bot.updated` with
     * `visibility: "public"`. Public sharing was removed: the parser refuses `public` before the
     * audit store is reached, so there is no row to record and — more to the point — no way for this
     * deployment to make a Bot visible to the whole of it.
     *
     * Asserted as a 400 with an empty trail rather than deleted, because "sharing is gone" and
     * "sharing was quietly re-allowed but stopped being audited" look identical from the outside.
     */
    const { rows, hono } = app();

    const response = await hono.request("http://t/api/agents/bot-1", {
      ...json({ visibility: "public" }),
      method: "PATCH",
    });

    expect(response.status).toBe(400);
    expect(rows).toEqual([]);
  });

  test("an edit that leaves it private says that too", async () => {
    // Carried on every row rather than only on the row that moved it: reading the trail forward has
    // to tell you what was reachable at each point, and the route has no before to compare against.
    const { rows, hono } = app();

    await hono.request("http://t/api/agents/bot-1", {
      ...json({ visibility: "private", title: "Sales assistant, revised" }),
      method: "PATCH",
    });

    expect(rows[0]?.payload.visibility).toBe("private");
  });

  test("issuing a callback token records that, never the token", async () => {
    // A trail that records credentials is a credential store with worse access control.
    const { rows, hono } = app();

    const response = await hono.request(
      "http://t/api/agents/bot-1/callback-token",
      { method: "POST" },
    );

    expect(await response.json()).toEqual({
      token: "the-token-nobody-records",
    });
    expect(rows[0]?.eventType).toBe("bot.callback_token_issued");
    expect(JSON.stringify(rows[0])).not.toContain("the-token-nobody-records");
  });

  test.each([
    ["/api/agents/bot-1/hide", "POST", "bot.hidden"],
    ["/api/agents/bot-1/unhide", "POST", "bot.unhidden"],
    [
      "/api/agents/bot-1/callback-token",
      "DELETE",
      "bot.callback_token_revoked",
    ],
    ["/api/agents/bot-1", "DELETE", "bot.deleted"],
  ])("%s writes %s", async (path, method, eventType) => {
    const { rows, hono } = app();

    await hono.request(`http://t${path}`, { method });

    expect(rows[0]?.eventType).toBe(eventType);
    expect(rows[0]?.targetId).toBe("bot-1");
  });

  test("duplicating records the copy and names the original", async () => {
    const { rows, hono } = app();

    await hono.request("http://t/api/agents/bot-1/duplicate", {
      method: "POST",
    });

    expect(rows[0]?.eventType).toBe("bot.duplicated");
    expect(rows[0]?.targetId).toBe("bot-2");
    expect(rows[0]?.payload.copiedFrom).toBe("bot-1");
  });

  test("a refused change writes nothing", async () => {
    // The row says what happened. An attempt that the store rejected did not happen.
    const { rows, hono } = app({
      update: async () => {
        throw new Error("nope");
      },
    });

    await hono.request("http://t/api/agents/bot-1", {
      ...json({ title: "Renamed" }),
      method: "PATCH",
    });

    expect(rows).toHaveLength(0);
  });

  test("a decline is recorded against a Bot the caller may reach", async () => {
    // The Bot reports through the person's session, so the row is only worth what that session
    // could reach: a decline on a Bot the caller may talk to is the Bot's own word.
    const { rows, hono } = app();

    const response = await hono.request("http://t/api/agents/bot-1/declined", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "It asked me to delete the ledger." }),
    });

    expect(response.status).toBe(200);
    expect(rows[0]?.eventType).toBe("bot.declined");
    expect(rows[0]?.targetId).toBe("bot-1");
    expect(rows[0]?.payload.reportedBy).toBe("the Bot itself");
  });

  test("a decline against a Bot the caller cannot reach is not found, and writes nothing", async () => {
    // Every other route here asks the store first. Without the same question, a signed-in person
    // could write "the Bot itself declined" against any id at all and an administrator would read
    // it as something the Bot said.
    const { rows, hono } = app();

    const response = await hono.request(
      "http://t/api/agents/somebody-elses-bot/declined",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Forged." }),
      },
    );

    expect(response.status).toBe(404);
    expect(rows).toHaveLength(0);
  });

  test("a trail that is down does not fail the change", async () => {
    // The Bot is already updated and the caller has been told so.
    const failing: AuditStore = {
      insert: async () => {
        throw new Error("the trail is unavailable");
      },
    };
    const requireUser: MiddlewareHandler = async (context, next) => {
      context.set("actor", ACTOR);
      await next();
    };
    const routes = createAgentRoutes(
      { setHidden: async () => undefined } as never,
      requireUser,
      failing,
    );
    const hono = new Hono<{ Variables: AppVariables }>().route(
      "/api/agents",
      routes,
    );

    const response = await hono.request("http://t/api/agents/bot-1/hide", {
      method: "POST",
    });

    expect(response.status).toBe(204);
  });
});

/*
 * Retiring a replaced key used to live here, and it has gone with the feature rather than with a
 * rename: a Bot could be registered against an address a person supplied and sit behind a bearer key
 * of theirs, so rotating that key was the standard answer to a suspected leak and retiring the old
 * one was what made that answer real. Nobody can supply either now — every coworker runs on the
 * engine this deployment runs, authenticated with the deployment's own token — so there is no
 * per-Bot key to rotate and nothing here left to retire.
 */
