import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const app = createApp(
  loadConfig({
    ...testEnvironment(),
  }),
);

describe("health endpoint", () => {
  test("reports the server as healthy", async () => {
    const response = await app.request("http://remii.local/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});

describe("runtime capabilities", () => {
  test("reports what the browser half of each capability needs, and no secrets", async () => {
    /*
     * WAS the "Intelligence runtime" projection: `mode: "intelligence"` and five fields.
     *
     * The runtime is `local` now, and the endpoint has grown six fields, each of which the BROWSER
     * reads and each of which therefore has to be here rather than only on the server: the sign-in
     * screen draws buttons from `authProviders` and a form from `emailPassword`; the composer offers
     * the code-generating tool from `generativeUi`; the computer affordances are offered from
     * `computer`; a new Bot inherits its execution mode from `executionMode`; and `authMode` tells
     * the client whether to expect a session at all.
     *
     * The assertion is the whole object, deliberately. This endpoint has no authentication, so a
     * projection bug publishes deployment configuration to anyone who asks — which is the property the
     * next test guards, and the reason "just check the fields you remember" is not enough here.
     */
    const response = await app.request("http://remii.local/api/capabilities");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: "local",
      durableHistory: true,
      // Default-on. The browser reads this to decide whether to offer the tool that generates an
      // interface, so it has to be here and not only in the runtime.
      generativeUi: true,
      // Whether any Bot here has a computer behind it. Also read by the browser, which owns half of
      // that capability: it offers the computer_* tools and draws the watch-screen button.
      computer: false,
      // Names only. The sign-in screen reads this to know which buttons to draw.
      authProviders: ["google"],
      // Whether email or username plus password is on. Separate from the ids above because it draws
      // a form rather than a button.
      emailPassword: false,
      // What a new Bot does by default; a person overrides it on the General screen.
      executionMode: "direct",
      // A boolean, not a list: naming the registered providers would tell anybody who loads the
      // sign-in page which companies use this deployment.
      ssoConfigured: false,
      // "session" when there is an identity provider, "single-user" without one.
      authMode: "session",
    });
  });

  // The runtime object holds the Intelligence API key and licence token, and `config.auth` holds
  // every provider's client secret. This endpoint has no authentication, so a projection bug here
  // publishes deployment secrets to anyone who asks.
  test("never serves a deployment secret, and projects nothing by accident", async () => {
    const response = await app.request("http://remii.local/api/capabilities");
    const body = await response.text();
    const parsed = (await new Response(body).json()) as Record<string, unknown>;

    expect(body).not.toContain("tenant-api-key");
    expect(body).not.toContain("license-token");
    // The provider list is names, never the clients and secrets behind them.
    expect(body).not.toContain("google-client-secret");

    /*
     * The EXACT key list, which is the part that has to keep up with the projection.
     *
     * The previous five were correct when written and drifted as the browser half of each capability
     * was added — a new field in `app.ts` shows up here as a failure, which is the only way this
     * assertion does its job. It is not "check the fields you remember": this endpoint is
     * unauthenticated, so the failure mode is publishing a configuration object rather than a secret.
     */
    expect(Object.keys(parsed)).toEqual([
      "mode",
      "durableHistory",
      "generativeUi",
      "computer",
      "authProviders",
      "emailPassword",
      "executionMode",
      "ssoConfigured",
      "authMode",
    ]);
  });

  /*
   * The answer has to reach the browser, not just the runtime.
   *
   * The app offers the model the tool that generates an interface, and it decides whether to from
   * this field. The two halves disagreeing is the one configuration this capability must not be able
   * to end up in: runtime-only means the tool is never offered, browser-only means a Bot writes a
   * whole interface that nothing renders.
   */
  test("reports generated interfaces as off when the deployment opts out", async () => {
    const disabled = createApp(
      loadConfig(testEnvironment({ REMII_GENERATIVE_UI: "false" })),
    );

    const response = await disabled.request(
      "http://remii.local/api/capabilities",
    );

    expect(response.status).toBe(200);
    expect((await response.json()).generativeUi).toBe(false);
  });
});

describe("authentication availability", () => {
  test("fails loudly when no identity provider has been configured", async () => {
    const response = await app.request(
      "http://remii.local/api/auth/sign-in/social",
      { method: "POST" },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "No identity provider is configured.",
    });
  });

  test("forwards auth requests to the configured Better Auth handler", async () => {
    const authenticatedApp = createApp(
      loadConfig({
        ...testEnvironment(),
      }),
      {
        handler: () => new Response("mounted", { status: 204 }),
      },
    );

    const response = await authenticatedApp.request(
      "http://remii.local/api/auth/callback/google",
    );

    expect(response.status).toBe(204);
  });

  test("forwards logout requests to Better Auth", async () => {
    const authenticatedApp = createApp(
      loadConfig({
        ...testEnvironment(),
      }),
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => null,
        },
      },
    );

    const response = await authenticatedApp.request(
      "http://remii.local/api/auth/sign-out",
      { method: "POST" },
    );

    expect(response.status).toBe(204);
  });
});

/**
 * Who may register an identity provider.
 *
 * Better Auth's SSO plugin guards these with a session, which asks only that somebody is signed in.
 * That is the wrong bar: registering an IdP for a domain means anybody it vouches for can sign in,
 * so a plain user reaching it could mint themselves colleagues. These pin the gate in front of it.
 */
/*
 * The three SSO mutation routes are closed outright, and `identity-provider-audit.test.ts` is where
 * that is tested.
 *
 * This block used to live here, and every case in it was about ROLES: a plain user refused with a 403,
 * an administrator let through, a signed-out caller refused. Individual-user SaaS has no roles —
 * `RemiiRole` is the literal type `"user"`, so an administrator is unrepresentable — and the routes
 * are now closed for everybody with a 410, which removed the role question rather than answering it.
 * Six of the nine cases were failing against that, and the three that passed were passing by
 * coincidence: they asserted `reached() === false`, which a 410 also satisfies.
 *
 * The replacement keeps the properties that are still load-bearing — the refusal happens IN FRONT of
 * Better Auth, so the plugin never sees the request, and `/api/auth/*` is otherwise untouched, so
 * sign-in through a configured provider still works — and adds what is new: that the closure is
 * narrow, that no audit row is written, and that the reason is the absence of an administrator rather
 * than a forgotten guard.
 */
describe("identity provider registration", () => {
  const routes = [
    "/api/auth/sso/register",
    "/api/auth/sso/update-provider",
    "/api/auth/sso/delete-provider",
  ];

  /** An app whose Better Auth handler records whether anything reached it. */
  function appWithHandler() {
    let reachedHandler = false;
    const app = createApp(loadConfig(testEnvironment()), {
      handler: () => {
        reachedHandler = true;
        return new Response(null, { status: 200 });
      },
      api: {
        getSession: async () => ({
          user: { id: "u1", email: "u1@remii.test" },
        }),
      },
    } as never);
    return { app, reached: () => reachedHandler };
  }

  test.each(routes)(
    "closes %s rather than letting the plugin serve it",
    async (route) => {
      const { app, reached } = appWithHandler();

      const response = await app.request(`http://remii.test${route}`, {
        method: "POST",
      });

      // Refused in front of Better Auth: the plugin's own guard asks only that somebody is signed in,
      // which would let any user register a provider for a domain and mint themselves colleagues.
      expect(response.status).toBe(410);
      expect(reached()).toBe(false);
      await expect(response.json()).resolves.toEqual({
        error: "Registering an identity provider is not available.",
      });
    },
  );

  // Everything else under /api/auth is Better Auth's own business, including sign-in itself, which by
  // definition happens before anybody has signed in. This is the test that would catch a closure that
  // had been written against `/api/auth/*` rather than against the three routes.
  test("leaves the rest of the auth routes alone", async () => {
    const { app, reached } = appWithHandler();

    await app.request("http://remii.test/api/auth/sign-in/social", {
      method: "POST",
    });

    expect(reached()).toBe(true);
  });
});
