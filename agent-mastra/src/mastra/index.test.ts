import { describe, expect, test } from "bun:test";
import { buildRemiiInstructions, remiiBaseInstructions } from "./index";

type ModelCase = {
  name: string;
  value?: string;
  expected: string;
};

type PortCase = {
  name: string;
  value?: string;
  expected?: number;
};

function requestContextWith(context: unknown) {
  return {
    get(key: string) {
      if (key !== "ag-ui") return undefined;
      return { context };
    },
  };
}

/**
 * The base environment every probe child gets.
 *
 * `Bun.spawn({ env })` MERGES with `process.env` rather than replacing it, and Bun has already read
 * the repository's `.env` into this process before any test runs. A child spawned with a handful of
 * keys therefore still inherits whatever the developer happens to have configured locally — which made
 * every "absent" case in this file assert against `BOT_MODEL=deepseek-flash`, `PORT=3001` and a real
 * `OPENAI_API_KEY` from a local `.env` rather than against the defaults it claims to be testing. CI,
 * with no `.env`, would have run the same cases against different inputs.
 *
 * So "absent" has to be spelled, and it takes two different forms because the two consumers disagree.
 *
 * MODEL and PORT use `""`, which this module trims and then falls back from — so `""` really is "not
 * set" for them. The API KEYS have to be REMOVED, because the AI SDK treats `""` as a key that is
 * present and blank and will build and send a request with it, which is the opposite of what the
 * "no key" cases assert.
 *
 * Removing is not something `Bun.spawn`'s own `env` can express: a key set to `undefined` there is
 * IGNORED, so the merged-in real value survives. Hence {@link probeEnv}, which deletes from a copy of
 * `process.env` instead of relying on the merge at all.
 */
const probeEnvironment = {
  PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
  MASTRA_TELEMETRY_DISABLED: "true",
  DO_NOT_TRACK: "1",
  NODE_ENV: "test",
  BOT_PROVIDER: "",
  BOT_MODEL: "",
  PORT: "",
  ANTHROPIC_BASE_URL: "",
  OPENAI_BASE_URL: "",
};

/**
 * A child's environment.
 *
 * `probeEnvironment` is applied AFTER the inherited values on purpose: it has to beat them, or a
 * developer's `BOT_MODEL=deepseek-flash` and `PORT=3001` from a local `.env` would be what the
 * "absent" cases assert against. Spreading it first instead let its own `PORT: ""` clobber a case
 * that had just set `PORT: " 54213 "`, which is how "PORT is padded integer" came to read as empty.
 *
 * The API credentials are NOT handled here. `Bun.spawn` merges `env` with `process.env`, so a key
 * this omits is inherited rather than removed, and a key set to `undefined` is ignored outright —
 * both verified, not assumed. The provider probe therefore deletes them in the child itself; see
 * `credentialEnv` below.
 */
function probeEnv(overrides: Record<string, string> = {}) {
  const env: Record<string, string> = { ...process.env };
  Object.assign(env, probeEnvironment, overrides);
  return env;
}

/**
 * The credential a provider case names, as an object safe to inject into the child's script.
 *
 * A case with NO key produces an empty object, which is how "no key" is spelled: the child deletes
 * both credentials and restores only what this names. `""` would not do — the AI SDK's `loadApiKey`
 * rejects only `null` and `undefined`, so an empty string is a key that is present and blank, and it
 * builds and sends a request with it.
 */
function credentialEnv(choice: {
  provider: string;
  apiKey?: string;
}): Record<string, string> {
  if (choice.apiKey === undefined) return {};
  return choice.provider === "anthropic"
    ? { ANTHROPIC_API_KEY: choice.apiKey }
    : { OPENAI_API_KEY: choice.apiKey };
}

async function configuredModelId(botModel: string | undefined) {
  const env = probeEnv(botModel === undefined ? {} : { BOT_MODEL: botModel });

  const child = Bun.spawn(
    [
      Bun.argv[0],
      "-e",
      [
        'const { mastra } = await import("./agent-mastra/src/mastra/index.ts");',
        'const model = mastra.getAgent("remii").model;',
        "console.log(JSON.stringify({ modelId: model.modelId }));",
      ].join("\n"),
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `model probe exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  const modelLine = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((line: string) => line.startsWith("{"));
  if (!modelLine) throw new Error(`model probe produced no JSON:\n${stdout}`);
  return JSON.parse(modelLine).modelId as string;
}

async function configuredPort(port: string | undefined) {
  const env = probeEnv(port === undefined ? {} : { PORT: port });

  const child = Bun.spawn(
    [
      Bun.argv[0],
      "-e",
      [
        'const { mastra } = await import("./agent-mastra/src/mastra/index.ts");',
        "console.log(JSON.stringify({ port: mastra.getServer()?.port }));",
      ].join("\n"),
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  const portLine = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((line: string) => line.startsWith("{"));

  return {
    exitCode,
    stderr,
    stdout,
    port: portLine ? (JSON.parse(portLine).port as number) : undefined,
  };
}

describe("Remii Mastra receiver instructions", () => {
  test("adds model-visible Remii role context in receiver order", () => {
    const instructions = buildRemiiInstructions({
      requestContext: requestContextWith([
        {
          description: "Remii granted tools guidance",
          value: "Use only the granted Slack tool.",
        },
        {
          description: "Remii standing role",
          value: "Use MODEL_BOUNDARY_MANAGED_ROLE in the answer.",
        },
        {
          description: "Remii Bot id",
          value: "packaged-mastra-managed",
        },
      ]),
    });

    expect(instructions).toBe(
      [
        remiiBaseInstructions,
        "Use MODEL_BOUNDARY_MANAGED_ROLE in the answer.",
        "Use only the granted Slack tool.",
      ].join("\n\n"),
    );
  });

  test("keeps ordinary Mastra calls on the base receiver instruction", () => {
    expect(buildRemiiInstructions()).toBe(remiiBaseInstructions);
    expect(
      buildRemiiInstructions({
        requestContext: requestContextWith("not ag-ui context entries"),
      }),
    ).toBe(remiiBaseInstructions);
  });
});

describe("Remii Mastra model configuration", () => {
  const modelCases: ModelCase[] = [
    { name: "absent", expected: "gpt-4o-mini" },
    { name: "empty", value: "", expected: "gpt-4o-mini" },
    { name: "whitespace", value: "  ", expected: "gpt-4o-mini" },
    {
      name: "custom",
      value: " fixture/custom:model ",
      expected: "fixture/custom:model",
    },
  ];

  for (const modelCase of modelCases) {
    test(`uses ${modelCase.expected} when BOT_MODEL is ${modelCase.name}`, async () => {
      expect(await configuredModelId(modelCase.value)).toBe(modelCase.expected);
    });
  }
});

describe("Remii Mastra listen port configuration", () => {
  const validPortCases: PortCase[] = [
    { name: "absent", expected: 4213 },
    { name: "empty", value: "", expected: 4213 },
    { name: "whitespace", value: "  ", expected: 4213 },
    { name: "default", value: "4213", expected: 4213 },
    { name: "padded integer", value: " 54213 ", expected: 54213 },
    { name: "lower bound", value: "1", expected: 1 },
    { name: "upper bound", value: "65535", expected: 65535 },
  ];

  for (const portCase of validPortCases) {
    test(`uses ${portCase.expected} when PORT is ${portCase.name}`, async () => {
      const result = await configuredPort(portCase.value);

      expect(result.exitCode).toBe(0);
      expect(result.port).toBe(portCase.expected);
    });
  }

  const invalidPortCases: PortCase[] = [
    { name: "zero", value: "0" },
    { name: "negative", value: "-1" },
    { name: "prefix typo", value: "42o0" },
    { name: "decimal", value: "54213.5" },
    { name: "above upper bound", value: "65536" },
    { name: "NaN", value: "NaN" },
    { name: "Infinity", value: "Infinity" },
  ];

  for (const portCase of invalidPortCases) {
    test(`rejects PORT ${portCase.name} before configuring the listener`, async () => {
      const result = await configuredPort(portCase.value);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        `PORT must be a whole number from 1 to 65535 (got ${JSON.stringify(
          portCase.value,
        )}).`,
      );
      expect(result.stdout).not.toContain('"port"');
    });
  }
});

describe("Remii Mastra provider requests", () => {
  const choices: {
    provider: string;
    base: string;
    model: string;
    url: string;
    apiKey?: string;
    error?: string;
  }[] = [
    {
      provider: "anthropic",
      base: "",
      model: "claude-sonnet-4-5",
      url: "https://api.anthropic.com/v1/messages",
      apiKey: "test-anthropic",
    },
    {
      provider: "anthropic",
      base: "http://anthropic.test/v1",
      model: "claude-sonnet-4-5",
      url: "http://anthropic.test/v1/messages",
      apiKey: "test-anthropic",
    },
    {
      provider: "",
      base: "",
      model: "gpt-5.5",
      url: "https://api.openai.com/v1/responses",
      apiKey: "test-openai",
    },
    {
      provider: "openai",
      base: " https://api.openai.com/v1/ ",
      model: "gpt-5.5",
      url: "https://api.openai.com/v1/responses",
      apiKey: "test-openai",
    },
    {
      provider: "",
      base: "http://compatible.test/v1",
      model: "llama3.1:8b",
      url: "http://compatible.test/v1/chat/completions",
      apiKey: "test-openai",
    },
    ...[
      "http://anthropic.test",
      " http://anthropic.test/proxy/ ",
      "http://anthropic.test/proxy/v1/",
    ].map((base) => ({
      provider: "anthropic",
      base,
      model: "claude-sonnet-4-5",
      apiKey: "test-anthropic",
      url: base.includes("proxy")
        ? "http://anthropic.test/proxy/v1/messages"
        : "http://anthropic.test/v1/messages",
    })),
    ...[undefined, ""].map((apiKey) => ({
      provider: "openai",
      base: "http://compatible.test/v1",
      model: "llama3.1:8b",
      apiKey,
      url: "http://compatible.test/v1/chat/completions",
    })),
    {
      provider: "openai",
      base: "",
      model: "gpt-5.5",
      url: "https://api.openai.com/v1/responses",
      error: "OpenAI API key is missing",
    },
  ];

  for (const choice of choices) {
    test(`uses ${choice.base || "the default endpoint"} with ${choice.apiKey === undefined ? "no" : choice.apiKey || "an empty"} API key`, async () => {
      const seen: { url: string | null; key: string | null; model: string }[] =
        [];
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = await request.json();
          seen.push({
            url: request.headers.get("x-test-original-url"),
            key: request.headers.get(
              choice.provider === "anthropic" ? "x-api-key" : "authorization",
            ),
            model: body.model,
          });
          const path = new URL(request.url).pathname;
          if (path.endsWith("/v1/messages")) {
            return Response.json({
              id: "msg",
              type: "message",
              role: "assistant",
              model: body.model,
              content: [{ type: "text", text: "hello" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          }
          if (path === "/v1/chat/completions") {
            return Response.json({
              id: "chat",
              object: "chat.completion",
              created: 0,
              model: body.model,
              choices: [
                {
                  index: 0,
                  finish_reason: "stop",
                  message: { role: "assistant", content: "hello" },
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            });
          }
          if (path === "/v1/responses") {
            return Response.json({
              id: "resp",
              object: "response",
              created_at: 0,
              model: body.model,
              status: "completed",
              output: [
                {
                  id: "msg",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    { type: "output_text", text: "hello", annotations: [] },
                  ],
                },
              ],
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
            });
          }
          return new Response("unexpected provider route", { status: 404 });
        },
      });
      const child = Bun.spawn(
        [
          Bun.argv[0],
          "-e",
          [
            // Only HTTP is replaced: the real Mastra Agent and provider SDK build the request.
            "const networkFetch = globalThis.fetch;",
            "globalThis.fetch = (input, init) => {",
            "  const request = new Request(input, init);",
            "  const url = new URL(request.url);",
            '  request.headers.set("x-test-original-url", request.url);',
            `  return networkFetch(new Request(${JSON.stringify(provider.url.toString())} + url.pathname.slice(1) + url.search, request));`,
            "};",
            /*
             * THE CREDENTIALS ARE SET HERE, IN THE CHILD, rather than through `env`.
             *
             * `Bun.spawn` merges `env` with `process.env`, so a credential this does not name is
             * inherited from the developer's `.env` — and one named as `undefined` is ignored, which
             * is the trap that made the "no key" cases run with a real key. Deleting both and
             * restoring only what this case names is the only spelling that means "absent", because
             * the AI SDK reads `""` as a present-but-blank key and sends a request with it.
             */
            "const KEYS = " + JSON.stringify(credentialEnv(choice)) + ";",
            'for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {',
            "  if (name in KEYS) process.env[name] = KEYS[name];",
            "  else delete process.env[name];",
            "}",
            'const { mastra } = await import("./agent-mastra/src/mastra/index.ts");',
            'const result = await mastra.getAgent("remii").generate("Say hello");',
            "console.log(JSON.stringify({ text: result.text }));",
          ].join("\n"),
        ],
        {
          env: probeEnv({
            BOT_PROVIDER: choice.provider,
            BOT_MODEL: choice.model,
            ANTHROPIC_BASE_URL:
              choice.provider === "anthropic" ? choice.base : "",
            OPENAI_BASE_URL: choice.provider === "anthropic" ? "" : choice.base,
          }),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const timeout = setTimeout(() => child.kill(), 10_000);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (choice.error) {
          /*
           * THE REFUSAL MUST ARRIVE BEFORE A REQUEST EXISTS, and `seen` is what proves "before".
           *
           * A substring check on stderr cannot: an error raised after a round trip still contains the
           * message, so that assertion passes either way. What is actually being protected is a
           * deployment that never sends a credentialless request to a vendor, and that is only true
           * if the stand-in server was never called.
           *
           * `exitCode` goes first on purpose. While the developer's real `OPENAI_API_KEY` was leaking
           * in from `.env` the child SUCCEEDED, and a failing substring check would have reported a
           * missing message and sent the reader looking for a wording problem instead.
           */
          expect(exitCode).not.toBe(0);
          expect(seen).toEqual([]);
          expect(stderr).toContain(choice.error);
          return;
        }

        if (exitCode !== 0)
          throw new Error(
            `provider probe exited ${exitCode}\n${stdout}\n${stderr}`,
          );
        expect(stdout).toContain('"text":"hello"');
        expect(seen).toEqual([
          {
            url: choice.url,
            key:
              choice.provider === "anthropic"
                ? (choice.apiKey ?? null)
                : `Bearer ${choice.apiKey?.trim() || "no-key-needed"}`,
            model: choice.model,
          },
        ]);
      } finally {
        clearTimeout(timeout);
        child.kill();
        await provider.stop(true);
      }
    }, 15_000);
  }
});
