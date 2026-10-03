import { expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { RunAgentInput } from "@ag-ui/client";
import { BunSQLPreparedQuery } from "drizzle-orm/bun-sql";
import type { PreparedQueryConfig } from "drizzle-orm/pg-core";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { loadConfig } from "../src/config";
import { buildAgents } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { loadTenantPackage } from "../src/tenant-package";
import { testEnvironment } from "./support/environment";

const fixtureToken = "synthetic-deployment-token";

/** Real query construction, with only the SQL execution boundary replaced. No database connects. */
async function runPicked(options: {
  bundled: boolean;
  installed: boolean;
  target?: "picked" | "bundled" | "elsewhere";
  spelling?: "uppercase";
  configuredQuery?: string;
  rowEndpoint?: (endpoint: string) => string;
  expectedManaged?: boolean;
  invalidCompanion?: boolean;
  packageProducer?: boolean;
}) {
  const requests: {
    path: string;
    search: string;
    method: string;
    headerNames: string[];
    status: number;
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const managed =
        options.expectedManaged ??
        (path.replace(/\/+$/, "") === "/bundled/ag-ui" ||
          (path.replace(/\/+$/, "") === "/picked/ag-ui" && options.installed));
      const authorized = managed
        ? request.headers.get("x-remii-agent-token") === fixtureToken
        : !request.headers.has("x-remii-agent-token");
      const status = authorized ? 200 : 401;
      requests.push({
        path,
        search: new URL(request.url).search,
        method: request.method,
        headerNames: [...request.headers.keys()].sort(),
        status,
      });
      if (!authorized)
        return Response.json({ error: "unauthorised" }, { status });
      const input: RunAgentInput = await request.json();
      return new Response(
        [
          { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
          {
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    },
  });
  const endpoint = (name: string) => {
    const value = new URL(
      `/${name}/ag-ui${options.configuredQuery ?? ""}`,
      server.url,
    ).toString();
    return options.spelling === "uppercase"
      ? value.replace("http://127.0.0.1", "HTTP://LOCALHOST")
      : value;
  };
  let storedEndpoint = endpoint(options.target ?? "picked");
  if (options.packageProducer) {
    const publicEnvironment = {
      MANAGED_AGENT_AG_UI_URL: options.bundled ? endpoint("bundled") : "",
      PICKED_HARNESS_URL: endpoint("picked"),
      PICKED_HARNESS_KIND: "remote-ag-ui",
    };
    const previous = new Map(
      Object.keys(publicEnvironment).map((key) => [key, process.env[key]]),
    );
    try {
      Object.assign(process.env, publicEnvironment);
      const tenant = await loadTenantPackage(
        fileURLToPath(new URL("../../examples/fintech", import.meta.url)),
      );
      const picked = tenant.agents.find(
        (agent) => agent.id === "picked-harness",
      );
      if (!picked || typeof picked.configuration.endpoint !== "string")
        throw new Error("Expected endpoint from default package producer");
      expect(picked.configuration.endpoint).toBe(endpoint("picked"));
      storedEndpoint = picked.configuration.endpoint;
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
  storedEndpoint = options.rowEndpoint?.(storedEndpoint) ?? storedEndpoint;
  const config = loadConfig(
    testEnvironment({
      KEY_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
      DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/never-connect",
      MANAGED_AGENT_AG_UI_URL: options.bundled ? endpoint("bundled") : "",
      MANAGED_AGENT_TOKEN: fixtureToken,
      PICKED_HARNESS_URL: endpoint("picked"),
      PICKED_HARNESS_IMAGE: options.installed
        ? "localhost/synthetic-harness:fixture"
        : "",
    }),
  );
  const database = createDatabase(config.databaseUrl);
  let sqlCalls = 0;
  const refuseDatabase = spyOn(database.$client, "unsafe").mockImplementation(
    () => {
      throw new Error("This fixture must never connect to a database");
    },
  );
  const execute = spyOn(
    BunSQLPreparedQuery.prototype,
    "execute",
  ).mockImplementation(async function (
    this: BunSQLPreparedQuery<PreparedQueryConfig>,
  ) {
    const { sql } = this.getQuery();
    sqlCalls++;
    if (
      sql.startsWith("select distinct ") &&
      sql.includes('"agent_profiles"."deleted_at" is not null')
    )
      return [];
    if (
      !sql.startsWith("select ") ||
      !sql.includes('"agent_profiles"."deleted_at" is null')
    ) {
      throw new Error("Unexpected SQL at the controlled roster boundary");
    }
    /*
     * A stored row can name any address it likes — that is how a package-supplied row arrives, and
     * how the Bot this deployment ships in the box is registered. So the token check below is a
     * refusal on an endpoint we do not run, not a parse. What no row can carry is a credential of its
     * own: there is no per-Bot key to read, so the deployment token is the only header on the call.
     */
    const rows = [
      {
        id: "picked-harness",
        name: "Picked Harness",
        type: "remote_ag_ui",
        title: "Synthetic harness",
        roleDescription: "Answer the controlled protocol request.",
        configuration: {
          endpoint: storedEndpoint,
        },
      },
    ];
    return options.invalidCompanion
      ? [
          ...rows,
          {
            ...rows[0],
            id: "invalid-companion",
            configuration: { endpoint: "not a valid URL" },
          },
        ]
      : rows;
  });
  });
  let failed = false;
  try {
    const loaded = await createRuntimeAgentLoader(
      database,
      config.managedAgent,
    )({ id: "fixture-actor", role: "admin" });
    expect(loaded).toHaveLength(1);
    const agents = await buildAgents(
      loaded,
      { provider: "openai", defaultModel: "unused" },
      null,
    );
    const agent = agents["picked-harness"];
    if (!agent)
      throw new Error("Expected picked harness from production loader");
    agent.threadId = "synthetic-auth-thread";
    const quietFailure = spyOn(console, "error").mockImplementation(() => {});
    try {
      await agent.runAgent({ runId: "synthetic-auth-run" });
    } catch {
      failed = true;
    } finally {
      quietFailure.mockRestore();
    }
    expect(sqlCalls).toBe(2);
    expect(refuseDatabase).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    console.log(
      JSON.stringify({
        boundary: "config-loader-buildAgents-HTTP",
        ...options,
        requests,
        failed,
      }),
    );
    return { config, requests, failed };
  } finally {
    execute.mockRestore();
    refuseDatabase.mockRestore();
    await database.$client.close();
    await server.stop(true);
  }
}

test("a plan's installed picked harness authenticates without advertising the Bot in the box", async () => {
  const result = await runPicked({ bundled: false, installed: true });
  expect(result.requests.map((request) => request.status)).toEqual([200]);
  expect(result.failed).toBe(false);
  expect(result.config.managedAgent?.endpoint).toBeUndefined();
});

test.each(["picked", "bundled"] as const)(
  "an eligible deployment authenticates the %s endpoint it runs",
  async (target) => {
    const result = await runPicked({ bundled: true, installed: true, target });
    expect(result.requests.map((request) => request.status)).toEqual([200]);
    expect(result.failed).toBe(false);
    expect(result.config.managedAgent?.endpoint).toBeDefined();
  },
);

/*
 * The floor that is left, and it is worth stating as a refusal rather than a convenience.
 *
 * Every address a run can reach is one this deployment configured: the Bot it ships in the box, or the
 * harness chosen at setup. A person cannot add one, and a row written straight into
 * `agents.configuration` — which is how a package-supplied row arrives — is still only ever dialled at
 * the address it names. So the deployment token travels to our own endpoints and nowhere else, and a
 * stored row that names somewhere else gets no credential of ours at all.
 */
test("an endpoint this deployment does not run receives no deployment token", async () => {
  const result = await runPicked({
    bundled: false,
    installed: true,
    target: "elsewhere",
  });
  expect(result.requests.map((request) => request.status)).toEqual([200]);
  expect(result.requests[0]?.headerNames).not.toContain(
    "x-remii-agent-token",
  );
});

/*
 * WAS "a customer endpoint differing by path case keeps only its own credential", and the credential
 * half is gone with the feature: a person cannot point a Bot at an address and attach a key to it any
 * more, so there is no per-Bot credential for a difference in spelling to confuse.
 *
 * The address half survives, and it is the more interesting one. Matching is canonical, so a stored row
 * whose address differs from the configured one only by path case, query value or a trailing slash must
 * NOT be treated as one this deployment runs — that is what keeps the deployment token off anything we
 * do not own.
 */
test.each([
  [
    "path case",
    "",
    (endpoint: string) => endpoint.replace("/picked/", "/Picked/"),
  ],
  [
    "query value",
    "?owner=managed",
    (endpoint: string) => endpoint.replace("owner=managed", "owner=elsewhere"),
  ],
  [
    "query trailing slash",
    "?owner=elsewhere",
    (endpoint: string) => `${endpoint}/`,
  ],
] as const)(
  "a stored endpoint differing by %s is not mistaken for one this deployment runs",
  async (_difference, configuredQuery, rowEndpoint) => {
    const result = await runPicked({
      bundled: false,
      installed: true,
      configuredQuery,
      rowEndpoint,
      expectedManaged: false,
    });
    expect(result.requests.map((request) => request.status)).toEqual([200]);
    expect(result.requests[0]?.headerNames).not.toContain(
      "x-remii-agent-token",
    );
    expect(result.failed).toBe(false);
  },
);
  expect(result.requests.map((request) => request.status)).toEqual([200]);
  expect(result.requests[0]?.headerNames).not.toContain(
    "x-remii-agent-token",
  );
});

test("a picked installed harness requires a token even when the Bot in the box is omitted", () => {
  expect(() =>
    loadConfig(
      testEnvironment({
        MANAGED_AGENT_AG_UI_URL: "",
        MANAGED_AGENT_TOKEN: "",
        PICKED_HARNESS_IMAGE: "localhost/synthetic-harness:fixture",
        PICKED_HARNESS_URL: "http://127.0.0.1:4206/ag-ui",
      }),
    ),
  ).toThrow("MANAGED_AGENT_TOKEN");
});

test("the default package's case-only picked address authenticates through the real HTTP client", async () => {
  const result = await runPicked({
    bundled: false,
    installed: true,
    spelling: "uppercase",
    packageProducer: true,
  });
  expect(result.requests.map((request) => request.status)).toEqual([200]);
  expect(result.failed).toBe(false);
  expect(result.config.managedAgent?.endpoint).toBeUndefined();
});

test.each(["picked", "bundled"] as const)(
  "canonical matching authenticates an uppercase %s endpoint",
  async (target) => {
    const result = await runPicked({
      bundled: true,
      installed: true,
      target,
      spelling: "uppercase",
    });
    expect(result.requests.map((request) => request.status)).toEqual([200]);
    expect(result.failed).toBe(false);
  },
);

test("canonical matching keeps trailing pathname slash tolerance", async () => {
  const result = await runPicked({
    bundled: false,
    installed: true,
    spelling: "uppercase",
    rowEndpoint: (endpoint) => `${endpoint}/`,
  });
  expect(result.requests.map((request) => request.status)).toEqual([200]);
  expect(result.failed).toBe(false);
});

test("an invalid stored companion does not prevent the valid endpoint loading", async () => {
  const result = await runPicked({
    bundled: false,
    installed: true,
    invalidCompanion: true,
  });
  expect(result.requests.map((request) => request.status)).toEqual([200]);
  expect(result.failed).toBe(false);
});
