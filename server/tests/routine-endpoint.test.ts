import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createTestApp } from "./support/app";
import type { RoutineRunner } from "../src/routines/runner";
import { testEnvironment } from "./support/environment";

/**
 * `/internal/routines/run` is the one door the worker gets: no session, no cookie, one bearer
 * secret, and a route that does not exist at all unless a runner was actually built. See
 * server/src/app.ts and server/src/config.ts.
 */

const SECRET = "worker-shared-secret";

function stubRunner(): { runner: RoutineRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    runner: {
      run: (id: string) => {
        calls.push(id);
        return Promise.resolve();
      },
    },
    calls,
  };
}

/** Captures every row written, so a test can assert on the reason without touching a database. */
function recordingAuditStore(): {
  store: AuditStore;
  rows: AuditEventInput[];
} {
  const rows: AuditEventInput[] = [];
  return { store: { insert: async (event) => void rows.push(event) }, rows };
}

/**
 * The internal door, with the two collaborators this file is about.
 *
 * NAMED rather than counted into place. `createApp` is a thirty-five-parameter positional function and
 * every one after `config` is optional, so building the argument list by hand means a list that has
 * to be edited every time the signature grows — and this one had drifted: it still carried a
 * `roleRepository` slot that no longer exists, which pushed `routineRunner` three places along and
 * left the route unmounted. `support/app.ts` fills the holes from the signature instead.
 */
function buildApp(
  environment: Record<string, string | undefined>,
  runner: RoutineRunner | undefined,
  auditStore?: AuditStore,
) {
  return createTestApp({
    config: loadConfig(environment),
    // No auth service: this door is reached with a bearer header and no session at all.
    parts: {
      routineRunner: runner,
      ...(auditStore ? { auditStore } : {}),
    },
  });
}

function appWithSecret(runner?: RoutineRunner, auditStore?: AuditStore) {
  return buildApp(
    { ...testEnvironment(), WORKER_SHARED_SECRET: SECRET },
    runner,
    auditStore,
  );
}

function appWithoutSecret(runner?: RoutineRunner, auditStore?: AuditStore) {
  return buildApp(
    { ...testEnvironment(), WORKER_SHARED_SECRET: undefined },
    runner,
    auditStore,
  );
}

async function post(
  app: ReturnType<typeof appWithSecret>,
  init: RequestInit = {},
) {
  return app.request("http://remii.local/internal/routines/run", {
    method: "POST",
    ...init,
  });
}

describe("POST /internal/routines/run", () => {
  test("401s with no authorization header", async () => {
    const { runner } = stubRunner();
    const { store, rows } = recordingAuditStore();
    const response = await post(appWithSecret(runner, store), {
      body: JSON.stringify({ routineRunId: "run-1" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(401);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("routines.dispatch_refused");
    expect(rows[0]?.payload.reason).toBe("missing-header");
  });

  test("401s with the wrong bearer secret", async () => {
    const { runner } = stubRunner();
    const { store, rows } = recordingAuditStore();
    const response = await post(appWithSecret(runner, store), {
      body: JSON.stringify({ routineRunId: "run-1" }),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong",
      },
    });

    expect(response.status).toBe(401);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("routines.dispatch_refused");
    expect(rows[0]?.payload.reason).toBe("mismatch");
  });

  test(
    "401s, byte-identically to a wrong secret, when no secret is configured " +
      "even with a correct-looking header",
    async () => {
      const { runner } = stubRunner();
      const { store, rows } = recordingAuditStore();

      const wrongSecretResponse = await post(appWithSecret(runner), {
        body: JSON.stringify({ routineRunId: "run-1" }),
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong",
        },
      });
      const noSecretResponse = await post(appWithoutSecret(runner, store), {
        body: JSON.stringify({ routineRunId: "run-1" }),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${SECRET}`,
        },
      });

      expect(noSecretResponse.status).toBe(401);
      expect(noSecretResponse.status).toBe(wrongSecretResponse.status);
      // The distinction between "nobody configured a secret" and "somebody guessed wrong" must
      // live in the audit row, never on the wire: the raw bodies (not just their parsed shape)
      // have to match byte for byte.
      expect(await noSecretResponse.text()).toBe(
        await wrongSecretResponse.text(),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.eventType).toBe("routines.dispatch_refused");
      expect(rows[0]?.payload.reason).toBe("unconfigured");
    },
  );

  test("400s with the right secret and no routineRunId", async () => {
    const { runner } = stubRunner();
    const response = await post(appWithSecret(runner), {
      body: JSON.stringify({}),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });

    expect(response.status).toBe(400);
  });

  test("400s with the right secret and a non-string routineRunId", async () => {
    const { runner } = stubRunner();
    const response = await post(appWithSecret(runner), {
      body: JSON.stringify({ routineRunId: 12345 }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });

    expect(response.status).toBe(400);
  });

  test("202s with the right secret and a routineRunId, running it exactly once", async () => {
    const { runner, calls } = stubRunner();
    const { store, rows } = recordingAuditStore();
    const response = await post(appWithSecret(runner, store), {
      body: JSON.stringify({ routineRunId: "run-42" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    // The response is 202 before the turn runs, so give the fire-and-forget call a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["run-42"]);
    // The 202 is already the record, via `routine_runs`. A dispatch that succeeded writes no
    // refusal row.
    expect(rows).toHaveLength(0);
  });

  test("requires no session or cookie: a bearer header alone is accepted", async () => {
    const { runner } = stubRunner();
    const response = await post(appWithSecret(runner), {
      body: JSON.stringify({ routineRunId: "run-1" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });

    expect(response.status).toBe(202);
  });

  test("the route does not exist at all when no runner was built", async () => {
    const response = await post(appWithSecret(undefined), {
      body: JSON.stringify({ routineRunId: "run-1" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });

    expect(response.status).toBe(404);
  });
});
