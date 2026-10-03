import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * The verified-email gate on computer use, and when it stands down.
 *
 * Provisioning a browser costs real money, so unverified trials are refused — but only when
 * verification can actually be completed. A deployment with no mail provider delivers no
 * codes, and demanding one there refuses every computer use forever rather than anyone's
 * abuse. That deployment stranded its owner with "Verify your email address before using a
 * computer" on every action, and retrying could never clear it.
 */

function signedIn(id: string): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id, email: `${id}@remii.test`, role: "user" });
    await next();
  };
}

function app(emailVerified: boolean, emailVerificationEnforced?: boolean) {
  const reached: string[] = [];
  const gateway = {
    read: async (botId: string) => {
      reached.push(`read:${botId}`);
      return { text: "a page" };
    },
    status: async (botId: string) => {
      reached.push(`status:${botId}`);
      return { botId, state: "ready" };
    },
  } as never;
  // Just enough query chain for the gate's own read: select().from().where().limit().
  const database = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ emailVerified }],
        }),
      }),
    }),
  } as never;

  const routes = createComputerRoutes(
    gateway,
    { get: () => ({ mode: "enforce", deny: [], allow: [] }) } as never,
    signedIn("owner"),
    async () => true,
    undefined,
    undefined,
    database,
    emailVerificationEnforced,
  );
  return {
    reached,
    hono: new Hono().route("/api/computers", routes),
  };
}

describe("the computer email gate", () => {
  test("refuses an unverified person when verification is enforced", async () => {
    const { hono, reached } = app(false, true);
    const response = await hono.request("http://t/api/computers/sales/read");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Verify your email address before using a computer.",
    });
    expect(reached).toEqual([]);
  });

  test("lets a verified person through when verification is enforced", async () => {
    const { hono, reached } = app(true, true);
    const response = await hono.request("http://t/api/computers/sales/read");

    expect(response.status).toBe(200);
    expect(reached).toEqual(["read:sales"]);
  });

  test("stands down when the deployment cannot deliver codes", async () => {
    const { hono, reached } = app(false, false);
    const response = await hono.request("http://t/api/computers/sales/read");

    expect(response.status).toBe(200);
    expect(reached).toEqual(["read:sales"]);
  });

  test("absent means enforced, the safe direction for older callers", async () => {
    const { hono } = app(false, undefined);
    const response = await hono.request("http://t/api/computers/sales/read");

    expect(response.status).toBe(403);
  });
});
