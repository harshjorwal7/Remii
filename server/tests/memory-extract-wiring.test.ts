import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

/**
 * MEMORY DID NOTHING, AND BOTH HALVES OF IT WERE SILENT.
 *
 * "The memory is not working at all" had two independent causes, and neither reported anything, which is
 * what made it read as a vague dissatisfaction rather than two concrete bugs.
 *
 * THE WRITE SIDE NEVER RAN. `extractMemoriesAfterRun` builds a model chain and returns immediately on an
 * empty one, and `buildModelChain` returns empty whenever it is not given a primary key — fallbacks cover
 * an outage, never a missing configuration. The call passed only the model and the environment, so
 * `primaryApiKey` was always undefined, the chain was always empty, and the function returned on its
 * first real line. Every turn, forever. Its three siblings all pass the key, which is exactly why the
 * omission was invisible in review: nothing at the call site looked wrong.
 *
 * It is fire-and-forget by design and every failure in it is deliberately quiet, so it also had no way to
 * complain. An explicit `memory_save` still worked throughout, which is the detail that makes this so
 * confusing in production: the tool the model can call does something, and the automatic path does not.
 *
 * THE READ SIDE FOUND NOTHING TO INJECT is covered in `remi-store.test.ts`, which needs a database. These
 * tests drive the real extraction against a real OpenAI-shaped HTTP endpoint, so they hold the wiring
 * rather than the prose around it.
 */

let server: ReturnType<typeof Bun.serve>;
/** Every prompt the daemon sent, so "did it ask at all" is observable. */
let prompts: string[] = [];
/** What the fake model answers with. */
let answer = "";

/** Memories the daemon tried to save, through a stub store. */
let saved: string[] = [];
/** Times the store was asked how much had been saved today. */
let budgetQueries = 0;

const stubStore = () => ({
  autoSavesToday: async () => {
    budgetQueries += 1;
    return 0;
  },
  saveMemory: async (input: { content: string }) => {
    saved.push(input.content);
    return { saved: true, id: `memory-${randomUUID()}` };
  },
});

const MODEL = { provider: "openai" as const, model: "test-model" };

function extract(
  store: unknown,
  extra: { apiKey?: string; userText?: string; assistantText?: string } = {},
) {
  return import("../src/remi/memory-extract").then(({ extractMemoriesAfterRun }) =>
    extractMemoriesAfterRun({
      store: store as never,
      botId: "remii",
      actorId: "user-1",
      userText: extra.userText ?? "Remind me to call the accountant about the invoice.",
      assistantText:
        extra.assistantText ?? "Noted — I will remind you to call the accountant.",
      model: MODEL,
      environment: { OPENAI_BASE_URL: server.url.toString() },
      ...(extra.apiKey ? { apiKey: extra.apiKey } : {}),
    }),
  );
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: { content: string }[];
      };
      prompts.push(body.messages[1]?.content ?? "");
      return Response.json({
        choices: [{ message: { role: "assistant", content: answer } }],
      });
    },
  });
});

afterEach(() => {
  prompts = [];
  saved = [];
  budgetQueries = 0;
  answer = "- the person needs to call the accountant about an invoice";
});

afterAll(() => {
  server?.stop(true);
});

describe("memory extraction, which is the write half", () => {
  test("asks the model when it is given a key", async () => {
    await extract(stubStore(), { apiKey: "sk-test" });
    expect(prompts.length).toBe(1);
  });

  test("saves what it extracted", async () => {
    const store = stubStore();
    await extract(store, { apiKey: "sk-test" });
    expect(saved).toEqual([
      "the person needs to call the accountant about an invoice",
    ]);
  });

  test("does nothing at all without a key, which is what it used to do WITH one", async () => {
    await extract(stubStore());
    expect(prompts).toEqual([]);
    expect(saved).toEqual([]);
  });

  test("spends no database round trip when it is going to do nothing", async () => {
    /*
     * The budget check used to come first, so a deployment with no key queried "how much has been saved
     * today" once per turn for a function that then returned without doing anything — on the hot path of
     * every conversation, for the life of the process. The chain is built first now, so a keyless
     * deployment spends nothing at all.
     */
    const store = stubStore();
    await extract(store);
    expect(budgetQueries).toBe(0);
  });

  test("still consults the write budget when it is going to do something", async () => {
    /*
     * The other side of moving that check, and the one that would be a real bug if it regressed: a budget
     * that is never consulted is not a budget. Ordering it after the chain is right; skipping it is not.
     */
    const store = stubStore();
    await extract(store, { apiKey: "sk-test" });
    expect(budgetQueries).toBe(1);
  });

  test("writes nothing when the model finds no durable fact", async () => {
    /*
     * "<none>" is the daemon's own answer for "nothing here is worth keeping", and it must not be saved
     * as though it were a fact about the person — a store full of "<none>" rows is worse than an empty
     * one, because it makes the feature look busy while recalling nothing.
     */
    answer = "<none>";
    const store = stubStore();
    await extract(store, { apiKey: "sk-test" });
    expect(prompts.length).toBe(1);
    expect(saved).toEqual([]);
  });

  test("writes nothing for a greeting", async () => {
    answer = "<none>";
    const store = stubStore();
    await extract(store, {
      apiKey: "sk-test",
      userText: "hello",
      assistantText: "hi there",
    });
    expect(saved).toEqual([]);
  });

  test("survives a model that fails, because a turn that answered must not fail over housekeeping", async () => {
    const failing = {
      autoSavesToday: async () => 0,
      saveMemory: async () => {
        throw new Error("the daemon must not reach here when the model failed");
      },
    };
    server.stop(true);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("upstream unavailable", { status: 503 }),
    });

    await extract(failing, { apiKey: "sk-test" });
    // Reaching here at all is the assertion: it returned rather than throwing into the turn that just
    // answered somebody.
  });
});