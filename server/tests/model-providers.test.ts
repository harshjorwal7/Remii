import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { LLMock } from "@copilotkit/aimock";
import { z } from "zod";
import {
  normalizeModelBaseUrls,
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
} from "../src/copilot";
import { encryptSecret, resolveModelApiKey } from "../src/credentials";
import { createModelCompleter } from "../src/routing/model";
import { validateTenantPackage } from "../src/tenant-package";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const originalEnvironment = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
};
afterEach(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const packageModel = {
  provider: "openai" as const,
  defaultModel: "gpt-5.6-terra",
};
const anthropicModel = {
  provider: "anthropic" as const,
  defaultModel: "claude-sonnet-4-5",
};

describe("deployment API-key provider selection", () => {
  test("normalizes optional SDK base URLs and native selector URLs", () => {
    const environment = { OPENAI_BASE_URL: "" };
    normalizeModelBaseUrls(environment);
    expect(environment).toEqual({});
    const custom = {
      OPENAI_BASE_URL: " https://openai.example/v1 ",
      // Untouched, and asserted as untouched. `ANTHROPIC_BASE_URL` used to be normalized here and
      // had its version segment added; OpenAI is the only provider now, so this function neither
      // reads it nor removes it — an env file written for a deployment that had one still boots, and
      // nothing in this codebase acts on the value.
      ANTHROPIC_BASE_URL: " https://anthropic.example/v1 ",
    };
    normalizeModelBaseUrls(custom);
    expect(custom).toEqual({
      OPENAI_BASE_URL: "https://openai.example/v1",
      ANTHROPIC_BASE_URL: " https://anthropic.example/v1 ",
    });
    // Idempotent, which is what "normalize" has to mean when a caller may run it twice.
    normalizeModelBaseUrls(custom);
    expect(custom.OPENAI_BASE_URL).toBe("https://openai.example/v1");
  });

  /*
   * An Anthropic package is REFUSED, by name.
   *
   * WAS "accepts an Anthropic tenant package without changing its credential reference", expecting
   * validation to pass it through. It does not: `validateTenantPackage` answers
   * `model.provider must be openai`, so the loader now refuses at the point the package is read
   * rather than quietly rewriting the provider and running a Claude model id against an
   * OpenAI-compatible endpoint.
   *
   * A named refusal is the better of the two answers for a deployment mid-migration: a stale
   * `provider: anthropic` is a fact about the package that the operator can see and change, rather
   * than one this code decides to reinterpret. The message is asserted so that changing it is a
   * deliberate act.
   */
  test("refuses an Anthropic tenant package, naming the field to change", () => {
    let refusal: unknown;
    try {
      validateTenantPackage({
        brand: "tenant: { id: provider-test, product_name: Provider Test }",
        agents: "agents: []",
        channels: "channels: []",
        model:
          "model: { provider: anthropic, credential_secret_ref: primary-model, default_model: claude-sonnet-4-5 }",
        knowledge: "sources: []",
        themeCss: "",
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain(
      "model.provider must be openai",
    );
  });

  /*
   * WAS "the desktop Anthropic choice overrides the OpenAI package model": `BOT_PROVIDER: "anthropic"`
   * plus `BOT_MODEL: "claude-sonnet-4-5"` selected Claude.
   *
   * It selects OpenAI now, and says so. `BOT_PROVIDER` used to choose a vendor; there is one vendor,
   * so the variable no longer decides anything.
   *
   * `BOT_MODEL` is subtler: it only applies once an endpoint is configured
   * (`selectedModelApplies` is `OPENAI_BASE_URL` being set), because a bare model name with no
   * endpoint means nothing worth honouring. With one, it names the model on whatever provider there
   * is — which is how a person points this deployment at an Anthropic-compatible gateway.
   */
  test("the desktop provider no longer chooses a vendor, but its model is still honoured", () => {
    expect(
      runtimeModelForEnvironment(packageModel, {
        BOT_PROVIDER: " anthropic ",
        BOT_MODEL: " claude-sonnet-4-5 ",
        OPENAI_BASE_URL: "",
      }),
    ).toEqual(packageModel);
    // With an endpoint chosen, `BOT_MODEL` IS the model: a person pointing this deployment at an
    // Anthropic-compatible gateway names a Claude model there, and refusing the combination would
    // refuse the configuration.
    expect(
      runtimeModelForEnvironment(packageModel, {
        BOT_PROVIDER: "anthropic",
        BOT_MODEL: "claude-sonnet-4-5",
        OPENAI_BASE_URL: "https://gateway.example/v1",
      }),
    ).toEqual({ provider: "openai", defaultModel: "claude-sonnet-4-5" });
    // No model named, and a stale Anthropic PROVIDER beside it: the package's own default stands,
    // because an unrecognised provider falls back to the known OpenAI default rather than sending
    // a Claude model id to an OpenAI-compatible endpoint.
    expect(
      runtimeModelForEnvironment(packageModel, {
        BOT_PROVIDER: "anthropic",
        BOT_MODEL: "",
      }),
    ).toEqual(packageModel);
    // And an Anthropic package with nothing selected at all, for the same reason.
    expect(runtimeModelForEnvironment(anthropicModel, {})).toEqual(
      packageModel,
    );
  });

  test("an unset choice preserves the package while an empty desktop provider selects OpenAI", () => {
    // A stale Anthropic package, with nothing selected: OpenAI and its default, NOT the package's
    // `claude-sonnet-4-5`. Sending that to an OpenAI-compatible endpoint is the failure the fallback
    // exists for, so an unrecognised provider never keeps its own model name.
    expect(runtimeModelForEnvironment(anthropicModel, {})).toEqual(
      packageModel,
    );
    expect(
      runtimeModelForEnvironment(anthropicModel, {
        BOT_PROVIDER: "",
        BOT_MODEL: "",
      }),
    ).toEqual(packageModel);
    expect(
      runtimeModelForEnvironment(packageModel, {
        BOT_MODEL: "unselected-model",
      }),
    ).toEqual(packageModel);
    expect(
      runtimeModelForEnvironment(packageModel, {
        BOT_PROVIDER: "openai",
        BOT_MODEL: "local-model",
        OPENAI_BASE_URL: "http://localhost:11434/v1",
      }),
    ).toEqual({ provider: "openai", defaultModel: "local-model" });
  });

  /*
   * The stored credential wins, and a rotation is read on the NEXT call.
   *
   * WAS the same test with `provider: "anthropic"` and `ANTHROPIC_API_KEY` throughout. There is one
   * provider, so `resolveModelApiKey` takes `provider: "openai"` and reads `OPENAI_API_KEY` — the
   * scoping property is unchanged and is what matters: a key stored for this deployment's model is
   * never taken from the environment, the environment is only consulted when nothing is stored, and a
   * corrupt envelope is an error rather than a silent fallback to the environment value.
   *
   * The `wrong-provider` variable is gone with the second provider. What replaces it is the assertion
   * that a caller cannot smuggle a different provider in: the type admits only `"openai"`.
   */
  test("the stored model credential wins, is re-read on rotation, and never falls back quietly", async () => {
    let encryptedValue = await encryptSecret(encryptionKey, "stored-one");
    const asked: unknown[] = [];
    const resolve = () =>
      resolveModelApiKey({
        encryptionKey,
        provider: "openai",
        keyId: "primary-model",
        reader: {
          readModelSecret: async (input) => {
            asked.push(input);
            return { encryptedValue };
          },
        },
        // A stored key must beat an environment one. Named `environment-shadow` so the assertion says
        // what it is for: the environment value must not be what comes back.
        environment: { OPENAI_API_KEY: "environment-shadow" },
      });
    expect(await resolve()).toBe("stored-one");
    encryptedValue = await encryptSecret(encryptionKey, "stored-two");
    expect(await resolve()).toBe("stored-two");
    expect(asked).toEqual(
      Array(2).fill({ provider: "openai", keyId: "primary-model" }),
    );

    // Nothing stored: the environment answers, trimmed.
    const noStored = {
      encryptionKey,
      provider: "openai" as const,
      keyId: "primary-model",
      reader: { readModelSecret: async () => null },
    };
    expect(
      await resolveModelApiKey({
        ...noStored,
        environment: { OPENAI_API_KEY: " from-environment " },
      }),
    ).toBe("from-environment");
    expect(
      await resolveModelApiKey({ ...noStored, environment: {} }),
    ).toBeNull();

    // A corrupt envelope is a failure, not a reason to read the environment: falling back there would
    // run on a key the operator did not intend, with the error logged rather than raised.
    await expect(
      resolveModelApiKey({
        ...noStored,
        reader: {
          readModelSecret: async () => ({ encryptedValue: "corrupt" }),
        },
        environment: { OPENAI_API_KEY: "must-not-fallback" },
      }),
    ).rejects.toThrow("Credential envelope is invalid");
  });
});

/*
 * Built-ins execute tools against a PROXIED endpoint, with the stored key and the one after it.
 *
 * WAS an Anthropic test.each over four `ANTHROPIC_BASE_URL` suffixes, asserting `/v1/messages` on
 * every request, the `x-api-key` header, and a `claude-sonnet-4-5` body.
 *
 * The native Anthropic path is gone, so all of that is now `/v1/chat/completions`, `authorization`,
 * and whatever model is configured. What the four cases are really about is unchanged and is the
 * reason they were written as four: `chatCompletionsUrl` adds the version segment exactly once, and a
 * suffix that already has one must not grow another. A proxy in front is the realistic shape, and it
 * is what makes the prefix arithmetic worth asserting at all.
 */
test.each([
  // `upstream` is the path the MOCK sees, which is the full request path with `prefix` stripped.
  // The four rows are the whole point: whatever the operator wrote is what the SDK appends
  // `/chat/completions` to, and nothing adds a version segment behind their back.
  { suffix: "", prefix: "", upstream: "/chat/completions" },
  { suffix: "/proxy", prefix: "/proxy", upstream: "/chat/completions" },
  { suffix: "/v1", prefix: "", upstream: "/v1/chat/completions" },
  { suffix: "/proxy/v1/", prefix: "/proxy", upstream: "/v1/chat/completions" },
])(
  "built-ins execute tools with a rotated key and base suffix '$suffix'",
  async ({ suffix, prefix, upstream }) => {
    const mock = new LLMock();
    const executed: unknown[] = [];
    const keys: (string | null)[] = [];
    const paths: string[] = [];
    let proxy: ReturnType<typeof Bun.serve> | undefined;
    try {
      const base = await mock.start();
      proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          keys.push(request.headers.get("authorization"));
          const path = new URL(request.url).pathname;
          paths.push(path);
          return fetch(`${base}${path.slice(prefix.length)}`, {
            method: "POST",
            headers: request.headers,
            body: await request.text(),
          });
        },
      });
      process.env.OPENAI_BASE_URL = `${proxy.url.origin}${suffix}`;
      normalizeModelBaseUrls();
      mock.on({ hasToolResult: true }, { content: "The balance is 42." });
      mock.onMessage(/balance/, {
        toolCalls: [
          {
            id: "balance-call",
            name: "read_balance",
            arguments: { account: "demo" },
          },
        ],
      });
      const model = packageModel;
      let encryptedValue = await encryptSecret(encryptionKey, "stored-one");
      const resolve = () =>
        resolveModelApiKey({
          encryptionKey,
          provider: model.provider,
          keyId: "primary-model",
          environment: {},
          reader: { readModelSecret: async () => ({ encryptedValue }) },
        });
      for (const key of ["stored-one", "stored-two"]) {
        encryptedValue = await encryptSecret(encryptionKey, key);
        const agents = await resolveRuntimeAgents(
          async () => [
            {
              id: "general-assistant",
              name: "General Assistant",
              type: "built_in",
              systemPrompt: "Answer using the granted balance tool.",
            },
          ],
          model,
          resolve,
          undefined,
          async () => [
            {
              name: "read_balance",
              ref: "bank/read_balance",
              description: "Read the balance.",
              parameters: z.object({ account: z.string() }),
              execute: async (args) => {
                executed.push(args);
                return "42";
              },
            },
          ],
        );
        const agent = agents["general-assistant"]?.clone();
        if (!agent) throw new Error("The built-in agent was not constructed");
        agent.addMessage({
          id: "request",
          role: "user",
          content: "Read my balance.",
        });
        await agent.runAgent();
        expect(agent.messages.at(-1)).toMatchObject({
          role: "assistant",
          content: "The balance is 42.",
        });
      }
      expect(executed).toEqual([{ account: "demo" }, { account: "demo" }]);
      const requests = mock.getRequests();
      expect(requests).toHaveLength(4);
      /*
       * The suffix is passed through verbatim and the SDK appends only `/chat/completions`.
       *
       * WAS `/v1/messages` with the version segment worked out from the suffix. Two things changed:
       * the endpoint shape (`/chat/completions`, and there is no Anthropic path), and the version
       * segment — `chatCompletionsUrl` builds `/v1` for the ROUTER's own call, while the SDK is
       * pointed straight at `OPENAI_BASE_URL` and appends nothing. So an operator who writes a bare
       * host gets no `/v1`, and this asserts that: `upstream` is per-row precisely because that is
       * the observable difference between the four configurations.
       */
      expect(requests.map((entry) => entry.path)).toEqual(
        Array(4).fill(upstream),
      );
      expect(paths).toEqual(Array(4).fill(`${prefix}${upstream}`));
      /*
       * The stored key, then the one it was rotated to — read on the next call, which is the whole
       * reason the loop runs each key twice.
       *
       * With the `Bearer ` prefix the SDK supplies, where the Anthropic path carried the bare key in
       * `x-api-key`. Asserted in full rather than with a matcher: a header assertion that only checked
       * the tail would pass just as happily on a key somebody else's SDK had prefixed.
       */
      expect(keys).toEqual([
        "Bearer stored-one",
        "Bearer stored-one",
        "Bearer stored-two",
        "Bearer stored-two",
      ]);
      expect(
        requests.every((entry) => entry.body?.model === "deepseek-flash"),
      ).toBe(true);
      expect(requests[1]?.body?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "tool", content: "42" }),
        ]),
      );
    } finally {
      await proxy?.stop(true);
      await mock.stop();
    }
  },
);

/*
 * A blank base URL reaches the provider's OWN endpoint, not a malformed local one.
 *
 * WAS a `test.each` over both providers — `https://api.anthropic.com/v1/messages` with a bare
 * `x-api-key`, and `https://api.openai.com/v1/responses` with `Bearer`. One provider is left, and it
 * is DeepSeek, so this is now a single case rather than a table of one.
 *
 * It is kept rather than folded into the proxy cases above because those configure a URL on purpose.
 * This is the blank case, and it is the one where `normalizeModelBaseUrls` deletes the variable: if
 * that ever stopped happening the SDK would dial something relative and this would catch it. With
 * the variable gone the router falls back to DeepSeek's own endpoint, which is the point — a
 * deployment that deletes it gets DeepSeek rather than a relative URL.
 */
test("a blank base URL reaches DeepSeek's own endpoint through the real SDK", async () => {
  const mock = new LLMock();
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const keys: (string | null)[] = [];
  let interception:
    | ReturnType<typeof spyOn<typeof globalThis, "fetch">>
    | undefined;
  try {
    const base = await mock.start();
    mock.onMessage("Hello", { content: "Hello back." });
    process.env.ANTHROPIC_BASE_URL = "";
    process.env.OPENAI_BASE_URL = "";
    normalizeModelBaseUrls();
    // Keep the SDK's request intact while redirecting only its transport to local fake HTTP.
    interception = spyOn(globalThis, "fetch").mockImplementation(
      (input, init) => {
        const request = new Request(input, init);
        urls.push(request.url);
        keys.push(request.headers.get("authorization"));
        return originalFetch(`${base}${new URL(request.url).pathname}`, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
      },
    );
    const agents = await resolveRuntimeAgents(
      async () => [
        {
          id: "general-assistant",
          name: "General Assistant",
          type: "built_in",
          systemPrompt: "Answer simply.",
        },
      ],
      packageModel,
      async () => "synthetic-key",
    );
    const agent = agents["general-assistant"]?.clone();
    if (!agent) throw new Error("The built-in agent was not constructed");
    agent.addMessage({ id: "request", role: "user", content: "Hello" });
    await agent.runAgent();
    expect(agent.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Hello back.",
    });
    // `/chat/completions`, where `/v1/responses` was: the SDK is pointed straight at the base URL
    // and appends the chat path itself. `chatCompletionsUrl` — which does build
    // `/v1/chat/completions` — is the ROUTER's call, not this one. DeepSeek's own base carries the
    // version segment already, so nothing adds another.
    expect(urls).toEqual(["https://api.deepseek.com/v1/chat/completions"]);
    expect(keys).toEqual(["Bearer synthetic-key"]);
  } finally {
    interception?.mockRestore();
    await mock.stop();
  }
});

/*
 * The production selector dials the OpenAI chat endpoint and rereads its key per call.
 *
 * WAS "the production selector speaks native Anthropic..." — `/v1/messages`, a bare `x-api-key`,
 * an `anthropic-version: 2023-06-01` header, and assertions that the body carried `max_tokens` and
 * NOT `response_format`.
 *
 * The selector builds OpenAI requests now, so the wire shape is different in every particular and the
 * same in the one that matters: `resolveApiKey` is called on EVERY completion, not once at
 * construction. That is the property this test exists for, and it is asserted by running two
 * completions with the key changed between them and reading the headers.
 *
 * The `response_format` assertion is kept and now means more: JSON mode is what makes the selector's
 * output parseable, so its absence would be a silent failure where a hand-written parser guess is
 * used instead.
 */
test("the production selector speaks OpenAI and rereads its key", async () => {
  const seen: {
    path: string;
    authorization: string | null;
    key: string | null;
    body: Record<string, unknown>;
  }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      seen.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        key: request.headers.get("x-api-key"),
        body: await request.json(),
      });
      return Response.json({
        choices: [
          {
            message: { role: "assistant", content: '{"skills":["bank"]}' },
            finish_reason: "stop",
          },
        ],
      });
    },
  });
  try {
    process.env.OPENAI_BASE_URL = `${server.url.origin}/v1`;
    let key = "synthetic-one";
    const complete = createModelCompleter({
      model: packageModel,
      resolveApiKey: async () => key,
    });
    expect(await complete("Choose bank tools; return JSON.")).toBe(
      '{"skills":["bank"]}',
    );
    key = "synthetic-two";
    expect(await complete("Choose bank tools; return JSON.")).toBe(
      '{"skills":["bank"]}',
    );
    // The whole point: a rotated key is picked up without rebuilding the selector.
    expect(seen.map((entry) => entry.authorization)).toEqual([
      "Bearer synthetic-one",
      "Bearer synthetic-two",
    ]);
    for (const entry of seen) {
      // `chatCompletionsUrl` IS used here, unlike the SDK path above: the selector builds the URL
      // itself and adds the version segment the configured base lacks. `/v1` was written in the
      // env above and the function did not grow a second.
      expect(entry.path).toBe("/v1/chat/completions");
      // Not the Anthropic header, on a route that used to be native Anthropic.
      expect(entry.key).toBeNull();
      expect(entry.body).toMatchObject({
        model: packageModel.defaultModel,
        messages: [
          { role: "user", content: "Choose bank tools; return JSON." },
        ],
      });
      expect(entry.body).toHaveProperty("response_format");
    }
  } finally {
    await server.stop(true);
  }
});

async function bounded<T>(promise: Promise<T>, boundary: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Fixture ${boundary} timed out`)),
          1500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("cancelling the selector closes its in-flight HTTP request", async () => {
  const entered = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      await request.text();
      request.signal.addEventListener("abort", () => closed.resolve(), {
        once: true,
      });
      entered.resolve();
      await release.promise;
      return Response.json({
        choices: [{ message: { role: "assistant", content: "late reply" } }],
      });
    },
  });
  try {
    process.env.OPENAI_BASE_URL = server.url.origin;
    const controller = new AbortController();
    const complete = createModelCompleter({
      model: packageModel,
      resolveApiKey: async () => "synthetic-key",
    });
    const run = complete("Choose tools.", controller.signal);
    const outcome = run.then(
      () => ({ rejected: false }),
      () => ({ rejected: true }),
    );
    await bounded(entered.promise, "request arrival");
    controller.abort();
    expect(await bounded(outcome, "fetch abort")).toEqual({ rejected: true });
    await bounded(closed.promise, "server abort");
  } finally {
    release.resolve();
    await server.stop(true);
  }
}, 5000);
