import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * The three SSO mutation routes are CLOSED, and the point of closing them is that no row is written.
 *
 * WHY THESE ROUTES ARE SHUT. Individual-user SaaS has no company SSO to register at runtime: providers
 * come from deployment configuration and there is no administrator who could authorize a new one.
 * Better Auth's SSO plugin still serves its mutation routes, and its own guard asks only that somebody
 * is signed in — which would let any user register an identity provider for a domain and mint
 * themselves colleagues. `app.ts` closes all three with a 410, and sign-in through an
 * already-configured provider keeps working.
 *
 * THIS REPLACES A TEST THAT ASSERTED THE OLD BEHAVIOUR. It used to prove that registering a provider
 * wrote `identity_provider.registered`, that the row named who did it, that a removal wrote
 * `identity_provider.removed`, and that a non-administrator was refused. Every one of those described
 * a route that no longer answers, so all four were failing against a 410 the code deliberately
 * returns.
 *
 * What is worth keeping is not the audit row — there is no row, and that is the feature — but the two
 * properties that make the closure safe: the refusal is a refusal rather than a pass-through, and the
 * audit store is never touched. A 410 that still called `auth.handler` would be worse than no closure
 * at all, and a 410 that wrote a trail row would be a route that appears in the log for something
 * nobody did.
 */

const ADMIN = { id: "admin", email: "admin@remii.test" };

const CLOSED = [
  "/api/auth/sso/register",
  "/api/auth/sso/update-provider",
  "/api/auth/sso/delete-provider",
] as const;

function app(rows: AuditEventInput[]) {
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  /*
   * The library's handler answers 200 and writes nothing, which is the shape of the thing being kept
   * out: if this app ever stopped closing these routes, the request would succeed and the test below
   * would say so.
   */
  let handled = 0;
  const hono = createApp(
    loadConfig(testEnvironment()),
    {
      handler: async (request: Request) => {
        await request.json().catch(() => null);
        handled += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => ["admin"] },
    ...(Array.from({ length: 9 }) as never[]),
    auditStore as never,
  );
  return { hono, rows, handled: () => handled };
}

describe("the SSO mutation routes are closed", () => {
  for (const route of CLOSED) {
    test(`${route} answers 410 rather than registering anything`, async () => {
      const rows: AuditEventInput[] = [];
      const { hono, handled } = app(rows);

      const response = await hono.request(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "acme",
          issuer: "https://login.acme.test",
          domain: "acme.test",
        }),
      });

      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toEqual({
        error: "Registering an identity provider is not available.",
      });
      /*
       * The two properties that make the closure mean anything. If the request reached the library
       * handler it would have answered 200 with `{ok:true}`, so any route that stopped being closed
       * fails here rather than looking like a success.
       */
      expect(handled()).toBe(0);
      expect(rows).toEqual([]);
    });
  }

  test("a signed-out caller gets the same 410, and still writes nothing", async () => {
    /*
     * 410, not 401 — and that is the deliberate answer rather than an accident of ordering.
     *
     * The closure sits in `app.on(["GET","POST"], "/api/auth/*")`, in front of `requireUser`, so it
     * is reached before anything asks who is asking. That ordering is what makes it airtight: a guard
     * that ran first would have to ask the same question for every signed-in user as well, and the
     * route would depend on the guard rather than on itself.
     *
     * The property worth pinning is the one a reader cannot infer from the status code: these routes
     * tell a signed-out caller nothing about whether a provider exists, and write no row either way.
     * So both callers get the same answer and neither moves the trail.
     */
    const rows: AuditEventInput[] = [];
    let handled = 0;
    const hono = createApp(
      loadConfig(testEnvironment()),
      {
        handler: async (request: Request) => {
          await request.json().catch(() => null);
          handled += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        api: { getSession: async () => null },
      } as never,
      { rolesForUser: async () => ["admin"] },
      ...(Array.from({ length: 9 }) as never[]),
      { insert: async (event) => void rows.push(event) } as AuditStore,
    );

    for (const route of CLOSED) {
      const response = await hono.request(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "acme" }),
      });
      expect(response.status).toBe(410);
    }
    expect(handled).toBe(0);
    expect(rows).toEqual([]);
  });

  test("sign-in through a configured provider still reaches the library", async () => {
    /*
     * The other half of "these three and only these three". A closure that swallowed `/api/auth/*`
     * would have locked every signed-in user out of every SSO deployment on this configuration, and
     * the only way to know the closure is narrow is to check something beside it still works.
     */
    const rows: AuditEventInput[] = [];
    const { hono, handled } = app(rows);

    const response = await hono.request("/api/auth/sign-in/sso", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "acme", callbackURL: "/callback" }),
    });

    expect(response.status).toBe(200);
    expect(handled()).toBe(1);
  });

  test("a GET on a closed route is closed too", async () => {
    const rows: AuditEventInput[] = [];
    const { hono, handled } = app(rows);

    const response = await hono.request("/api/auth/sso/delete-provider");
    expect(response.status).toBe(410);
    expect(handled()).toBe(0);
    expect(rows).toEqual([]);
  });
});
