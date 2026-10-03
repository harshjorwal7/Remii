import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * Who may ask this server for something.
 *
 * There is no administrator here, and that is the point of the file rather than an omission from it.
 * `RemiiRole` is the literal type `"user"` — see `auth/guards.ts` — so an admin bypass is not
 * merely unused here, it is unrepresentable: a route cannot be written that consults one. What remains
 * is the only two questions the guard layer still answers, which are the ones worth testing.
 *
 * The tests this file used to hold, and why they are gone:
 *
 *   - "denies a signed-in user from an administrator route" and "allows an administrator to reach an
 *     administrator route" both asked `/api/admin/status` a 403 and a 200. The Admin surface was
 *     deleted, so the path answers 404 for every caller and the role question is moot.
 *   - The `rolesForUser` third argument no longer exists on `createApp`; every call site was passing a
 *     guard repository that `app.ts` did not take.
 *
 * What replaces them is not nothing: the 401, the derived actor, and the fact that a removed route is
 * gone for everybody rather than merely closed to some.
 */

const config = loadConfig({
  ...testEnvironment(),
});

const noSessionAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => null,
  },
};

function authenticatedAs(
  userId: string,
  email = "member@remii.test",
  name = "Remii Member",
  image = "https://example.test/member.png",
) {
  return {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({ user: { id: userId, email, name, image } }),
    },
  };
}

describe("server authorization", () => {
  test("returns 401 when a protected route has no session", async () => {
    const app = createApp(config, noSessionAuth);

    const response = await app.request("http://remii.local/api/me");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required.",
    });
  });

  test("returns the authenticated user actor, derived from the session and nothing else", async () => {
    const app = createApp(config, authenticatedAs("member"));

    const response = await app.request("http://remii.local/api/me");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      user: {
        id: "member",
        email: "member@remii.test",
        name: "Remii Member",
        image: "https://example.test/member.png",
        role: "user",
        /*
         * The three billing fields, defaulted because no database was passed to this app.
         *
         * They are read from `users` when one is available and defaulted otherwise — 50 credits, no
         * Stripe customer, not banned — which is what a deployment with no database behind `/api/me`
         * can honestly say. Listed here because `/api/me` is read by the browser before it draws
         * anything, so its shape is a contract and a fourth column added to `users` should fail a test
         * rather than quietly appear.
         */
        creditBalance: 50,
        stripeCustomerId: null,
        isBanned: false,
        // No store was passed, so this deployment tracks no onboarding and the app gates nobody.
        onboarding: null,
      },
    });
  });

  test("a removed administrator route is gone for every caller, not merely closed to some", async () => {
    /*
     * The 404 both callers get is the point. Under the old surface this path answered 403 to a plain
     * user and 200 to an administrator, which made "is there an admin?" a question the status code
     * answered — so the removal had to make the path indistinguishable for everyone, and does.
     */
    for (const auth of [authenticatedAs("member"), authenticatedAs("admin")]) {
      const response = await createApp(config, auth).request(
        "http://remii.local/api/admin/status",
      );
      expect(response.status).toBe(404);
    }
  });

  test("a route nobody may reach is 404 rather than 403, and says nothing about who is calling", async () => {
    /*
     * The response body matters as much as the status: a 403 would confirm that the path EXISTS and
     * is merely closed, which is a small amount of information about a deployment's surface. A 404 with
     * Hono's default empty body tells the caller nothing at all.
     */
    const response = await createApp(config, authenticatedAs("member")).request(
      "http://remii.local/api/admin/people",
    );

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain("Administrator");
    expect(body).not.toContain("admin");
  });
});
