import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * The fleet is a fact about the deployment, not about a Bot. This is the same bug as the boundary
 * one in computer-policy-route.test.ts, a second time.
 *
 * Admin listed the fleet by calling `/:botId/computers` with a placeholder id, on the reasoning that
 * the endpoint answers with every computer whatever the path says. True when it was written. Then
 * the bot-access middleware arrived, the placeholder was not a Bot, `canUseBot` said so, and
 * `/admin/computers` answered 404 for everybody including an administrator. The screen renders
 * nothing at all while the list is null, so it did not even look broken: it looked like a
 * deployment with no computers, while two containers were running.
 *
 * The middleware's own comment asked for this: "a second deployment-wide route added later should
 * have to think about this line." It was added later and did not. So the fleet has a route of its
 * own now, and this holds it there.
 *
 * Found by driving the screen against a deployment that had computers, not by reading the diff.
 */

const ADMIN = { id: "u1", email: "admin@remii.test", role: "admin" } as const;

/**
 * `actorId` rather than a `role`.
 *
 * The role parameter was how this file asked "is this an administrator", which is not a question this
 * deployment can answer — `AuthenticatedActor.role` still carries the field and every actor is
 * `user`. What the fleet actually filters on is the actor's ID, so that is what the fixture varies.
 */
function app(actorId = ADMIN.id) {
  const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...ADMIN, id: actorId });
    await next();
  };

  const gateway = {
    computers: async () => ({
      isolation: "per-bot",
      computers: [
        {
          botId: "risk-analyst",
          running: true,
          startedAt: null,
          owner: ADMIN.id,
        },
        {
          botId: "general-assistant",
          running: false,
          startedAt: null,
          owner: ADMIN.id,
        },
        // Somebody else's. The route filters on `owner`, so this row is the whole reason the
        // list is not deployment-wide — and its presence is what makes the filter testable.
        {
          botId: "a-coworkers-computer",
          running: true,
          startedAt: null,
          owner: "u2",
        },
      ],
    }),
  } as unknown as ComputerGateway;

  const policyStore = {
    get: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    set: async () => undefined,
  } as unknown as PolicyStore;

  const routes = createComputerRoutes(
    gateway,
    policyStore,
    asActor,
    // No Bot is reachable, which is the deployment the bug showed up in: listing the fleet must not
    // depend on the caller having access to a Bot that happens to share the collection's name.
    async () => false,
  );

  return new Hono<{ Variables: AppVariables }>().route(
    "/api/computers",
    routes,
  );
}

/*
 * WAS "listing every computer in the deployment", asserting an administrator got the whole fleet and
 * that it was administrator-only.
 *
 * Both halves describe an administrator role this deployment does not have. There is nobody to be
 * "somebody else from", so the second test was asserting a 403 the route never produced, and the
 * first was asserting a deployment-wide list — which meant a caller was handed every computer in the
 * deployment, including coworkers' they had never been granted.
 *
 * The route now keeps rows on `owner`, and that is what these assert: your own computers come back
 * whatever Bots you can reach (the original bug), and a coworker's does not.
 */
describe("listing this person's own computers", () => {
  test("an actor gets their own, whatever Bots they can reach", async () => {
    const response = await app().request("http://t/api/computers/fleet");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      isolation: "per-bot",
      computers: [{ botId: "risk-analyst" }, { botId: "general-assistant" }],
    });
  });

  test("a coworker's computer is not in it", async () => {
    const response = await app("user").request("http://t/api/computers/fleet");

    // 200, not 403: the route is open to every signed-in person because it answers only about
    // theirs. The answer is the filter, and the filter is the security property.
    expect(response.status).toBe(200);
    expect((await response.json()).computers).toEqual([]);
  });

  test("a Bot route is still gated", async () => {
    // One named path, not a hole.
    const response = await app().request(
      "http://t/api/computers/some-bot/status",
    );

    expect(response.status).toBe(404);
  });
});
