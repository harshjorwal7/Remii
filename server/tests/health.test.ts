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

describe("the auth proxy", () => {
  /** An app whose auth service records whether anything reached it. */
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

  /*
   * Every auth route is forwarded, with no closure list in front of them.
   *
   * WAS three tests asserting that `/api/auth/sso/register`, `/api/auth/sso/update-provider` and
   * `/api/auth/sso/delete-provider` answer 410 — the Better Auth SSO plugin's registration routes,
   * closed so that a signed-in person could not register an identity provider for a domain and mint
   * themselves colleagues.
   *
   * The closure is gone with the plugin. The identity provider admits no SAML and no generic OIDC, so
   * there is no route behind those paths to protect against, and a deny-list kept "just in case"
   * would be three paths refused for no stated reason — which is how a deny-list quietly stops
   * matching the thing it was written for.
   */
  test.each([
    "/api/auth/sign-in/social",
    "/api/auth/sign-in/email",
    "/api/auth/sign-up/email",
    "/api/auth/get-session",
    "/api/auth/sign-out",
  ])("forwards %s to the provider", async (route) => {
    const { app, reached } = appWithHandler();

    await app.request(`http://remii.test${route}`, { method: "POST" });

    expect(reached()).toBe(true);
  });

  /*
   * `/api/auth/oauth-complete` is this server's own route, and the reason is structural.
   *
   * A social sign-in completes on the PROVIDER's host: Google redirects there, the provider sets its
   * cookie there, and the browser returns to this application holding nothing for this origin. The
   * wildcard proxy above cannot help, because the browser is the one talking during that leg and it
   * talks to somebody else. So the browser comes back here with a token, and this route turns it into
   * a cookie for this origin.
   *
   * Named `oauth-complete` rather than `callback/google` on purpose. A path shaped like Google's
   * callback invites registering it as the OAuth redirect URI — which would put this route INSIDE the
   * handshake it follows, and it has no code to exchange because the provider holds the OAuth client.
   */
  describe("POST /api/auth/oauth-complete", () => {
    function appWithCompletion(
      completeSocialSignIn: (request: Request) => Response,
    ) {
      const app = createApp(loadConfig(testEnvironment()), {
        handler: () => new Response(null, { status: 200 }),
        completeSocialSignIn,
        api: { getSession: async () => null },
      } as never);
      return app;
    }

    test("is answered by this server rather than forwarded to the provider", async () => {
      let reached = false;
      let completed = false;
      const app = createApp(loadConfig(testEnvironment()), {
        handler: () => {
          reached = true;
          return new Response(null, { status: 200 });
        },
        completeSocialSignIn: () => {
          completed = true;
          return Response.json({ ok: true });
        },
        api: { getSession: async () => null },
      } as never);

      const response = await app.request(
        "http://remii.test/api/auth/oauth-complete",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "a.b.c" }),
        },
      );

      expect(response.status).toBe(200);
      expect(completed).toBe(true);
      // The provider has no such route, so forwarding would have answered 404 with a message about
      // the provider's API rather than anything about signing in.
      expect(reached).toBe(false);
    });

    test("is POST only, so a stray GET cannot spend a token", async () => {
      let completed = false;
      const app = appWithCompletion(() => {
        completed = true;
        return Response.json({ ok: true });
      });

      const response = await app.request(
        "http://remii.test/api/auth/oauth-complete",
      );

      // The wildcard catches it instead, so this asserts the narrower route did not: a token in a
      // query string is a token in a log, and this route should never be reachable that way.
      expect(completed).toBe(false);
    });

    test("answers 501 when the sign-in cannot be completed out of process", async () => {
      // A sign-in that finishes inside this server has nothing to hand over, so it has no such
      // method. Saying 501 rather than forwarding names the gap instead of hiding it behind a 404
      // from a provider that has never heard of the route.
      const app = createApp(loadConfig(testEnvironment()), {
        handler: () => new Response(null, { status: 200 }),
        api: { getSession: async () => null },
      } as never);

      const response = await app.request(
        "http://remii.test/api/auth/oauth-complete",
        { method: "POST" },
      );

      expect(response.status).toBe(501);
    });

    test("answers 503 when no provider is configured at all", async () => {
      const app = createApp(
        loadConfig(
          testEnvironment({
            NEON_AUTH_BASE_URL: undefined,
            REMII_SINGLE_USER: "true",
          }),
        ),
      );

      const response = await app.request(
        "http://remii.test/api/auth/oauth-complete",
        { method: "POST" },
      );

      expect(response.status).toBe(503);
    });
  });

  test("answers 503 when no provider is configured", async () => {
    const app = createApp(
      loadConfig(
        testEnvironment({
          NEON_AUTH_BASE_URL: undefined,
          REMII_SINGLE_USER: "true",
        }),
      ),
    );

    const response = await app.request(
      "http://remii.test/api/auth/get-session",
      {
        method: "GET",
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "No identity provider is configured.",
    });
  });
});
