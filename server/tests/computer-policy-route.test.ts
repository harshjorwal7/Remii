import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";
import { subscriptions, users } from "../src/db/schema";
import { createDatabase } from "../src/db/client";
import { eq } from "drizzle-orm";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The boundary is a fact about the deployment, not about a Bot.
 *
 * `/api/computers/policy` lives on the same router as the acting routes, which are all
 * `/:botId/...`. The bot-access middleware matches `/:botId/*`, and Hono matches `/*` against zero
 * segments, so `/policy` arrived at it as a Bot called "policy". `canUseBot` correctly answered that
 * there is no such Bot, and the Boundaries screen returned 404 for everybody including an
 * administrator: the whole surface for writing rules, gone, with a message about a Bot.
 *
 * Found by driving the screen rather than by reading the diff, which is the only way this was ever
 * going to turn up: every test of both features passed.
 */

const ADMIN = { id: "u1", email: "admin@remii.test", role: "admin" } as const;

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

/**
 * Give this actor a tier, because a custom boundary now takes one.
 *
 * WAS a `role: "admin" | "user"` parameter and nothing else, on the reasoning that writing a custom
 * boundary was an administrator's to do. Custom boundaries are a PAID-TIER feature decided per
 * person now — the route reads `subscriptions` and answers 403 with the upgrade sentence when the
 * tier is not Pro or Power — so with no subscription row every write was refused, which is why
 * "an administrator can write it" was expecting < 300 and getting 403.
 *
 * The actor's role is kept and still means nothing to this route. What decides is the tier, so that
 * is what the fixture varies.
 */
async function withTier(tier: "free" | "pro") {
  await database
    .insert(users)
    .values({ id: ADMIN.id, email: ADMIN.email, name: "Boundary Owner" })
    .onConflictDoNothing();
  // Delete then insert rather than upsert: `subscriptions.user_id` carries a foreign key but no UNIQUE
  // constraint, so `onConflictDoUpdate` has no arbiter index to infer and the statement fails at
  // prepare time with "no unique or exclusion constraint matching the ON CONFLICT specification".
  await database
    .delete(subscriptions)
    .where(eq(subscriptions.userId, ADMIN.id));
  // `id` is a primary key with no default and `currentPeriodStart` is NOT NULL, both required by the
  // schema rather than inferred: the row is a real subscription as far as the database is concerned,
  // and only its tier is what this test is about.
  const now = new Date();
  await database.insert(subscriptions).values({
    id: `sub_boundary_${tier}`,
    userId: ADMIN.id,
    tier,
    currentPeriodStart: now,
    currentPeriodEnd: now,
  });
}

function app(role: "admin" | "user" = "admin") {
  const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...ADMIN, role });
    await next();
  };

  const policyStore = {
    get: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    set: async () => undefined,
  } as unknown as PolicyStore;

  const routes = createComputerRoutes(
    {} as never,
    policyStore,
    asActor,
    // Nothing is a usable Bot here, which is exactly the deployment where the bug showed: the policy
    // route must not depend on the caller having access to a Bot that happens to be named "policy".
    async () => false,
    undefined,
    undefined,
    database,
  );

  return new Hono<{ Variables: AppVariables }>().route(
    "/api/computers",
    routes,
  );
}

describe("reading and writing the deployment's boundary", () => {
  test("the policy is readable without holding any Bot", async () => {
    const response = await app().request("http://t/api/computers/policy");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      policy: { mode: "enforce" },
    });
  });

  test("an actor on a paid tier can write it", async () => {
    await withTier("pro");
    const response = await app().request("http://t/api/computers/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "enforce", deny: [], allow: ["true"] }),
    });

    expect(response.status).toBeLessThan(300);
  });

  test("a free tier is told what the feature costs", async () => {
    /*
     * WAS "it is still administrator-only", expecting 403 for `role: "user"` on the reasoning that
     * letting a plain user rewrite the boundary would be a worse bug than the 404 being fixed.
     *
     * There is no plain user to protect the boundary from: every account is a plain user, and
     * whoever's boundary it is gets a say. What gates a custom policy now is the tier, and the
     * refusal says so rather than being a bare 403 — a person told "upgrade" can act on it and a
     * person told nothing can only guess.
     */
    await withTier("free");
    const response = await app("user").request(
      "http://t/api/computers/policy",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "enforce", deny: [], allow: [] }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("paid subscription"),
    });
  });

  test("a Bot route is still gated", async () => {
    // The exemption is one named path, not a hole. Everything else under this router still asks.
    const response = await app().request(
      "http://t/api/computers/some-bot/status",
    );

    expect(response.status).toBe(404);
  });
});
