import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDesktopControlRoutes } from "../src/computer/desktop-control";
import type { UserComputer } from "../src/computer/user-computers";

/**
 * A person watching their Bot work must not have the machine paused underneath them.
 *
 * The idle sweep reclaims on `last_seen_at`, and the only thing that used to write it was a tool call.
 * So a screen sitting still after the Bot finished a step stopped looking alive — and the noVNC bytes
 * go from the browser straight to the sandbox without passing through this server, so the server had no
 * way to know a human was watching. The result was the desktop being reclaimed while it was being
 * looked at, which reads to a person as the product being broken rather than as a cost decision.
 *
 * `/control` is the fix and it is nearly free: the browser already polls it, the handler already reads
 * the row, and the heartbeat is a throttled database write with no round trip to the sandbox — so it
 * keeps a machine alive without competing with the Bot that is driving it.
 */

type Patch = Partial<{
  lastSeenAt: Date | null;
  status: string;
}>;

const makeStore = (row: Partial<UserComputer> = {}) => {
  const patches: Patch[] = [];
  let current: Partial<UserComputer> = {
    controlHolder: "bot",
    controlSince: new Date(),
    lastSeenAt: new Date("2026-03-11T12:00:00.000Z"),
    ...row,
  };
  return {
    patches,
    row: () => current,
    get: async () => current as UserComputer,
    patch: async (_userId: string, patch: Patch) => {
      patches.push(patch);
      current = { ...current, ...patch } as Partial<UserComputer>;
      return current as UserComputer;
    },
    create: async () => current as UserComputer,
    listRunning: async () => [current] as UserComputer[],
  };
};

/**
 * A `requireUser` that does what the real one does, which is the part that matters here: it puts the
 * signed-in person on the context. A stub that just calls `next()` leaves `actor` undefined and every
 * route 500s, which says nothing about the heartbeat.
 *
 * Per-test, because the throttle is keyed by user id and lives for the life of the process — which is
 * the point of it. Two tests sharing one id would silently share one heartbeat budget, and the second
 * would assert nothing.
 */
let actorId = 0;
const appWith = (store: ReturnType<typeof makeStore>) => {
  actorId += 1;
  const who = `watcher-${actorId}`;
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    c,
    next,
  ) => {
    c.set("actor" as never, { id: who } as never);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createDesktopControlRoutes(
      store as never,
      requireUser,
      null,
      async () => [],
      undefined,
      undefined,
    ),
  );
  return app;
};

describe("a person watching a computer", () => {
  test("counts as using it", async () => {
    const store = makeStore();
    const app = appWith(store);

    const before = store.row().lastSeenAt;
    await app.request("/control");

    expect(store.patches.some((p) => p.lastSeenAt instanceof Date)).toBe(true);
    const written = store.patches.find((p) => p.lastSeenAt instanceof Date);
    // Newer than the value the row already carried, which is what the sweep compares against.
    expect((written!.lastSeenAt as Date).getTime()).toBeGreaterThan(
      (before as Date).getTime(),
    );
  });

  test("does not write once per poll", async () => {
    const store = makeStore();
    const app = appWith(store);

    /*
     * Fifty polls is a realistic minute of somebody watching a screen. If each one wrote, this would
     * put fifty database writes in front of a status check that is supposed to be free — trading a
     * machine being paused for a database being hammered, which is not a trade worth making.
     */
    for (let i = 0; i < 50; i += 1) await app.request("/control");

    expect(
      store.patches.filter((p) => p.lastSeenAt instanceof Date),
    ).toHaveLength(1);
  });

  test("still answers, whether or not a write was due", async () => {
    const store = makeStore();
    const app = appWith(store);

    await app.request("/control");
    const second = await app.request("/control");

    // The second poll writes nothing, and must still be a correct answer — throttling the heartbeat
    // cannot be allowed to throttle the route.
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ holder: "bot" });
  });

  test("a failed write does not fail the poll", async () => {
    const app = appWith({
      ...makeStore(),
      patch: async () => {
        throw new Error("connection reset");
      },
    });

    const response = await app.request("/control");
    expect(response.status).toBe(200);
  });
});
