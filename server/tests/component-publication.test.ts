import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createComponentRoutes } from "../src/components/routes";
import type { ComponentStore } from "../src/components/store";

/**
 * Who may change what every Bot is allowed to draw, held closed.
 *
 * This file used to assert the opposite: that `POST /components/:name/publication` published on an
 * explicit `true`, unpublished on an explicit `false`, and answered 400 for anything else. That route
 * was closed deliberately — publication decides what every Bot on the deployment may draw, and in
 * individual-user SaaS there is no administrator who could authorise changing it, so the component
 * ships with the deployment. It answers 410 with the reason rather than 404 so an old screen is told
 * why.
 *
 * The tests kept asserting 200/400 and failed on every one of their thirteen cases, which is the
 * right outcome for a test whose subject was removed — but it left the guarantee unasserted. The
 * guarantee worth holding is the one the closure exists to provide: whatever a caller sends, including
 * a well-formed `{"published": false}`, nothing is published and nothing is unpublished.
 *
 * Every case below is answered 410, and the store is never touched. That is the property. If this
 * route is ever reopened, the store calls reappear and this file fails.
 */

const ADMIN = {
  id: "u1",
  email: "admin@remii.test",
  role: "admin",
} as const;

function harness() {
  const calls: { action: string; name: string }[] = [];
  const store = {
    publish: async (name: string) => {
      calls.push({ action: "publish", name });
    },
    unpublish: async (name: string) => {
      calls.push({ action: "unpublish", name });
    },
  } as unknown as ComponentStore;

  const asAdmin: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...ADMIN });
    await next();
  };

  const hono = new Hono().route(
    "/components",
    createComponentRoutes(store, asAdmin, undefined, async () => true),
  );
  return { calls, hono };
}

function post(body?: string) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  };
}

const GONE = 410;

describe("component publication is deployment-owned", () => {
  test("refuses to publish, even on an explicit true", async () => {
    const { calls, hono } = harness();
    const response = await hono.request(
      "http://t/components/showActivityReport/publication",
      post(JSON.stringify({ published: true })),
    );

    expect(response.status).toBe(GONE);
    await expect(response.json()).resolves.toEqual({
      error: "This is managed by the deployment and cannot be changed here.",
    });
    expect(calls).toEqual([]);
  });

  test("refuses to unpublish, even on an explicit false", async () => {
    const { calls, hono } = harness();
    const response = await hono.request(
      "http://t/components/showActivityReport/publication",
      post(JSON.stringify({ published: false })),
    );

    expect(response.status).toBe(GONE);
    expect(calls).toEqual([]);
  });

  test.each([
    ["an empty body", ""],
    ["invalid JSON", "{not json"],
    ["an empty object", "{}"],
    ['the string "no"', '{"published":"no"}'],
    ["zero", '{"published":0}'],
    ["null", '{"published":null}'],
    ["an object", '{"published":{}}'],
  ])("refuses %s the same way, and changes nothing", async (_name, body) => {
    const { calls, hono } = harness();
    const response = await hono.request(
      "http://t/components/showActivityReport/publication",
      post(body),
    );

    /*
     * 410 rather than 400, on every one of them.
     *
     * The malformed cases used to be a separate concern — a 400 for a body that is not a boolean —
     * and that distinction is exactly what must not come back: a caller sending garbage and a caller
     * sending a valid instruction are refused for the same single reason now, so there is no input
     * that reaches the store.
     */
    expect(response.status).toBe(GONE);
    expect(calls).toEqual([]);
  });

  test("a missing body is refused the same way, and changes nothing", async () => {
    const { calls, hono } = harness();
    const response = await hono.request(
      "http://t/components/showActivityReport/publication",
      { method: "POST" },
    );

    expect(response.status).toBe(GONE);
    expect(calls).toEqual([]);
  });

  test("the sibling draft route is closed too", async () => {
    const { hono } = harness();
    const response = await hono.request(
      "http://t/components/showActivityReport/draft",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );

    expect(response.status).toBe(GONE);
  });
});
