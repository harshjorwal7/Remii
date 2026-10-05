import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createTestApp } from "./support/app";
import { loadConfig } from "../src/config";
import { createRoutingRoutes } from "../src/routing/routes";
import { createComputerRoutes } from "../src/computer/routes";
import type { RoutineRunner } from "../src/routines/runner";
import { testEnvironment } from "./support/environment";

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "user-1",
    email: "user@remii.test",
    role: "admin",
  });
  await next();
};

/**
 * Unbounded `text` becomes the model prompt in the router. A multi-megabyte body would force a
 * timeout or OOM; over 10000 characters is now a 400 before the roster is read or the model is
 * asked.
 */
describe("POST /api/route text cap", () => {
  function app(calls: unknown[]) {
    const store = { list: async () => [] };
    const router = {
      route: async (...a: unknown[]) => {
        calls.push(a);
        return { chosen: "bot-1" };
      },
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createRoutingRoutes(store as never, router as never, requireUser),
    );
    return app;
  }

  test("refuses oversized text with 400 and never routes", async () => {
    const calls: unknown[] = [];
    const response = await app(calls).request("http://remii.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(10001) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "A message of at most 10000 characters is required.",
    });
    expect(calls).toEqual([]);
  });

  test("accepts a message at the cap boundary", async () => {
    const calls: unknown[] = [];
    // Empty roster -> 409 "No coworker is available.", which still proves the text passed the
    // cap and reached the router path.
    const response = await app(calls).request("http://remii.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(10000) }),
    });
    expect(response.status).toBe(409);
  });
});

const SECRET = "worker-shared-secret";

/**
 * The worker callback, mounted and not.
 *
 * WAS a hand-written array of twenty `undefined`s and then `runner`, spread into `createApp(...args)`.
 * `routineRunner` is parameter 20 of thirty-five, not 23 — the list ran past it and the runner landed
 * on `triggerIncoming`, so the route this describe is about was never mounted and every case was
 * answering 404 against an expected 400.
 *
 * {@link createTestApp} names it, which is the only version of this that survives the signature
 * changing again. The comment above it is not decoration either: a positional list of thirty-five
 * optional slots is silent about its own mistake, and this one had been wrong long enough for the
 * tests to be green-wrong about it.
 */
function internalApp(runner: RoutineRunner | undefined) {
  return createTestApp({
    config: loadConfig({ ...testEnvironment(), WORKER_SHARED_SECRET: SECRET }),
    parts: { routineRunner: runner },
  });
}

/**
 * `""` is a string and used to answer 202 Accepted while the worker swallowed the failure.
 * Only a non-empty run id is accepted for dispatch now.
 */
describe("POST /internal/routines/run id", () => {
  test.each([
    ["empty", ""],
    ["whitespace", "   "],
  ])(
    "refuses a %s routineRunId with 400 and never runs",
    async (_n, routineRunId) => {
      const calls: string[] = [];
      const app = internalApp({
        run: (id: string) => {
          calls.push(id);
          return Promise.resolve();
        },
      });
      const response = await app.request(
        "http://remii.local/internal/routines/run",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${SECRET}`,
          },
          body: JSON.stringify({ routineRunId }),
        },
      );
      expect(response.status).toBe(400);
      expect(calls).toEqual([]);
    },
  );
});

/**
 * Blank or overlong frame params can never name a stored frame. Refused here instead of
 * becoming junk reads against the frame table.
 */
describe("GET /api/computers/:botId/page-frame/:toolCallId", () => {
  function app(calls: unknown[]) {
    const pageFrames = {
      load: async (...a: unknown[]) => {
        calls.push(a);
        return null;
      },
    };
    /*
     * `keyOf`, which the route needs to turn the Bot in the path into the (user, Bot) key a frame is
     * filed under. Without it the read threw inside the handler and the route answered 500 — which
     * this case was reporting as "a blank tool call id is accepted" when it had not reached the
     * validation at all.
     */
    const gateway = { keyOf: async (botId: string) => `computer:${botId}` };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createComputerRoutes(
        gateway as never,
        {} as never,
        requireUser,
        async () => true,
        pageFrames as never,
      ),
    );
    return app;
  }

  test("returns null frame on the happy path", async () => {
    const calls: unknown[] = [];
    const response = await app(calls).request(
      "http://remii.test/bot-1/page-frame/turn-1",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ frame: null });
    // The COMPUTER KEY, not the Bot id: a frame is a screenshot of a signed-in page, so it is filed
    // under the (user, Bot) key the gateway resolves. The read above reaches the store with whatever
    // `keyOf` returned, which is what this asserts — it used to expect the bare Bot id and so could
    // never have passed against a gateway that resolves keys.
    expect(calls).toEqual([["computer:bot-1", "turn-1"]]);
  });

  test("refuses an overlong toolCallId with 400 and never reads", async () => {
    const calls: unknown[] = [];
    const response = await app(calls).request(
      `http://remii.test/bot-1/page-frame/${"t".repeat(201)}`,
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
