import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { AuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import type { ExecutionModeStore } from "../src/execution-mode";
import { testEnvironment } from "./support/environment";

const MEMBER = {
  id: "member-1",
  email: "member@remii.test",
  name: "A Member",
  image: null,
};

/**
 * One person's execution switch, over HTTP.
 *
 * The rules worth pinning are the ones a screen cannot check for itself: that the choice is
 * scoped to whoever the session says is asking, that anything outside the closed set is
 * refused rather than stored, that clearing falls back to inheriting the deployment default,
 * and that the trail records the switch position (unlike instructions prose, a mode is safe
 * to audit).
 */
function appWith(
  store?: ExecutionModeStore,
  options: { as?: typeof MEMBER; auditStore?: AuditStore } = {},
) {
  return createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: options.as ?? MEMBER }) },
    } as never,
    /*
     * Positions mirror settings-instructions-routes.test.ts: 3-11 other stores, 12 auditStore,
     * 13-22 more stores, 23 userInstructions, 24-31 the rest, and `store` is 32,
     * executionModes. A trigger callback rides at 33; every parameter from 3 on is optional,
     * so a wrong count is a silent type-check pass.
     */
    ...(Array.from({ length: 9 }) as never[]),
    options.auditStore as never,
    ...(Array.from({ length: 19 }) as never[]),
    store as never,
  );
}

/** One switch per person, in memory, with the same inherit rules the real store has. */
function memoryStore(initial: Record<string, "direct" | "ask-first"> = {}) {
  const state: Record<string, "direct" | "ask-first"> = { ...initial };
  const store: ExecutionModeStore = {
    read: async (userId) => state[userId] ?? null,
    write: async (userId, mode) => {
      if (mode === null || mode === undefined || String(mode).trim() === "") {
        delete state[userId];
        return null;
      }
      if (mode !== "direct" && mode !== "ask-first") {
        const { InvalidExecutionModeError } = await import(
          "../src/execution-mode"
        );
        throw new InvalidExecutionModeError(String(mode));
      }
      state[userId] = mode;
      return mode;
    },
  };
  return { store, state };
}

function memoryAudit() {
  const rows: Parameters<AuditStore["insert"]>[0][] = [];
  return {
    rows,
    store: {
      insert: async (event) => {
        rows.push(event);
      },
    } satisfies AuditStore,
  };
}

describe("execution mode routes", () => {
  test("inherits the deployment default when this person chose nothing", async () => {
    const { store } = memoryStore();
    const app = appWith(store);

    const response = await app.request(
      "http://remii.local/api/settings/execution-mode",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: null,
      defaultMode: "direct",
    });
  });

  test("saves a choice and answers with what was stored", async () => {
    const { store, state } = memoryStore();
    const app = appWith(store);

    const response = await app.request(
      "http://remii.local/api/settings/execution-mode",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "ask-first" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: "ask-first",
      defaultMode: "direct",
    });
    expect(state[MEMBER.id]).toBe("ask-first");
  });

  test("an empty save clears back to inheriting", async () => {
    const { store, state } = memoryStore({ [MEMBER.id]: "ask-first" });
    const app = appWith(store);

    const response = await app.request(
      "http://remii.local/api/settings/execution-mode",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: null,
      defaultMode: "direct",
    });
    expect(state[MEMBER.id]).toBeUndefined();
  });

  test("refuses anything outside the closed set, and stores nothing when it does", async () => {
    const { store, state } = memoryStore({ [MEMBER.id]: "direct" });
    const app = appWith(store);

    const response = await app.request(
      "http://remii.local/api/settings/execution-mode",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "auto" }),
      },
    );

    expect(response.status).toBe(400);
    expect(state[MEMBER.id]).toBe("direct");
  });

  test("refuses a body it does not understand", async () => {
    const { store } = memoryStore();
    const app = appWith(store);

    const response = await app.request(
      "http://remii.local/api/settings/execution-mode",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: 42 }),
      },
    );

    expect(response.status).toBe(400);
  });

  test("records the switch position in the trail", async () => {
    const { store } = memoryStore();
    const audit = memoryAudit();
    const app = appWith(store, { auditStore: audit.store });

    await app.request("http://remii.local/api/settings/execution-mode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "ask-first" }),
    });

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      targetType: "execution_mode",
      payload: { mode: "ask-first" },
    });
  });

  test("answers 503 without the store", async () => {
    const app = appWith(undefined);

    const response = await app.request(
      "http://remii.local/api/settings/execution-mode",
    );

    expect(response.status).toBe(503);
  });
});
