import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { RemiLoopAgent } from "../src/remi/loop-agent";
import { recallHooksFor } from "../src/remi/memory-router";
import { createRemiStore } from "../src/remi/store";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabase, testDatabaseUrl } from "./support/database";
import { REMII_AGENT_ID } from "../../shared/remii";

/**
 * LIVE end-to-end recall: gate + injection + citation through a real loop
 * run against the deployment model. Needs model keys (skipped without them),
 * because a mocked chain would prove nothing about the wiring that matters.
 *
 * ASKED FOR BY NAME, LIKE THE OTHER LIVE SUITE. This used to switch itself on whenever
 * `OPENAI_API_KEY` held any non-whitespace, and that is a test of the wrong thing: a key can be
 * present and REJECTED, and then the run dials a real API for the best part of a hundred seconds
 * before failing on the timeout rather than on the thing that is actually wrong. A `.env` carrying a
 * revoked key is enough to cause it, so an ordinary `bun test` lost two minutes to a credential
 * nobody was looking at, and reported a red that pointed at recall.
 *
 * The bar is now explicit — `REMII_LIVE_RECALL=1` — with the credential still required alongside
 * it. `bun run test:live-recall` sets it and refuses to run without the key, which is how
 * `test:live-composio` already handles the same question.
 */
const MODEL = { provider: "openai", model: "deepseek-chat" } as const;
const asked = process.env.REMII_LIVE_RECALL === "1";
const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());

beforeAll(async () => {
  const database = testDatabase();
  await database.execute(
    sql`INSERT INTO users (id, email) VALUES ('P4Xq5dyZW4xERSyRcPTstzaU7tTO9rMa', 'harshjorwal7@gmail.com') ON CONFLICT DO NOTHING`,
  );
});

describe.skipIf(!asked || !hasKey)("live recall turn", () => {
  test("a recalled fact reaches the answer without being asked for", async () => {
    const database = createDatabase(testDatabaseUrl(), TEST_POOL);
    const store = createRemiStore({ database });
    const userId = "P4Xq5dyZW4xERSyRcPTstzaU7tTO9rMa";
    const marker =
      "Live turn probe: the person's favorite debugging snack is salted peanuts.";
    const saved = await store.saveMemory({
      userId,
      botId: REMII_AGENT_ID,
      content: marker,
      scope: "global",
    });
    expect(saved.saved).toBe(true);
    try {
      const hooks = recallHooksFor({
        store,
        userId,
        model: MODEL,
        getApiKey: async () => process.env.OPENAI_API_KEY ?? null,
        environment: process.env,
      });
      const cited: string[][] = [];
      const agent = new RemiLoopAgent({
        botId: REMII_AGENT_ID,
        systemPrompt:
          "You are Remii, the person's chief of staff. Answer briefly.",
        tools: [],
        model: MODEL,
        apiKey: process.env.OPENAI_API_KEY ?? null,
        environment: process.env,
        maxSteps: 3,
        recallBeforeRun: (input) => hooks.recall(REMII_AGENT_ID, input),
        recordCited: (ids) => hooks.recordCited(REMII_AGENT_ID, ids),
      });
      const texts: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const sub = agent.run({
          threadId: "live-turn-probe",
          runId: "live-run-probe",
          messages: [
            {
              id: "m1",
              role: "user",
              content: "what is my favorite debugging snack?",
            },
          ],
        } as never);
        const timer = setTimeout(
          () => reject(new Error("run timeout")),
          100_000,
        );
        sub.subscribe({
          next: (event: unknown) => {
            const record = event as Record<string, unknown>;
            if (typeof record["delta"] === "string") {
              texts.push(record["delta"] as string);
            }
            if (typeof record["message"] === "string" && record["message"]) {
              texts.push(record["message"] as string);
            }
          },
          complete: () => {
            clearTimeout(timer);
            resolve();
          },
          error: (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
      const answer = texts.join("");
      expect(answer.toLowerCase()).toContain("peanut");
    } finally {
      if (saved.id) await store.deleteMemory(saved.id, userId);
    }
  }, 120_000);
});
