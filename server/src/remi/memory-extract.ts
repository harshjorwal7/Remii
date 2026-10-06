import type OpenAI from "openai";
import { buildModelChain, type ModelProvider } from "./model-router";
import type { createRemiStore } from "./store";

/**
 * Background memory extraction, ported from Remi.
 *
 * After a turn, a quiet daemon pass reads the latest exchange and saves durable facts about
 * the person — preferences, decisions, context worth keeping forever. Chitchat, greetings
 * and transient details are explicitly not memories. The person never waits for this: the
 * caller fires and forgets, and every failure is silent, because a turn that already
 * answered must not fail over housekeeping.
 *
 * Locks per person and Bot while running, so two turns settling at once do not extract and
 * save the same fact twice. The source used Redis; this deployment keeps the lock in memory
 * beside the process that runs every turn, which is where the duplicate settlement happens.
 */

const DAEMON_PROMPT = `You are a quiet background daemon. Your job is to analyze the latest exchange between a user and their AI assistant and extract any new, durable, and highly significant facts, preferences, decisions, or contextual information about the user that should be remembered forever.

Rules:
1. ONLY extract clear, durable facts/preferences (e.g. "User prefers TypeScript over JavaScript", "User lives in Seattle", "User wants JSON response structure").
2. DO NOT extract transient details, chat greetings, questions, or chitchat (e.g. "User asked how to write a function", "User is having a nice day").
3. Format each extracted memory as a single clear, declarative statement in the third-person.
4. Output each memory on a new line starting with a bullet (-).
5. If there are no new durable facts or preferences to extract, reply with exactly: <none>`;

const running = new Set<string>();

function clientOf(link: {
  client: OpenAI;
  model: string;
  extraBody?: Record<string, unknown>;
}) {
  return link;
}

export async function extractMemoriesAfterRun(input: {
  store: ReturnType<typeof createRemiStore>;
  botId: string;
  actorId: string;
  userText: string;
  assistantText: string;
  model: { provider: ModelProvider; model: string };
  /**
   * The deployment's key for that model, resolved per turn rather than captured at boot.
   *
   * Load-bearing, and absent once: without it `buildModelChain` returns nothing and this whole function
   * returns on its first line. Its three siblings all pass it, which is what made the omission here easy
   * to miss — nothing about the call site looked wrong, and nothing was reported.
   */
  apiKey?: string | null;
  environment?: Record<string, string | undefined>;
}): Promise<void> {
  const userText = input.userText.trim().slice(0, 4000);
  const assistantText = input.assistantText.trim().slice(0, 8000);
  if (!userText || !assistantText) return;

  const lock = `${input.actorId}:${input.botId}`;
  if (running.has(lock)) return;
  running.add(lock);
  try {
    /*
     * THE KEY, PASSED IN — AND THIS FUNCTION WAS A NO-OP WITHOUT IT.
     *
     * `buildModelChain` takes the primary key as its third argument and returns an EMPTY chain when it is
     * absent: fallbacks cover an outage, never a missing configuration. This call passed only the model
     * and the environment, so `primaryApiKey` was always `undefined`, the chain was always empty, and
     * `extractMemoriesAfterRun` returned on the very next line — on every single turn, silently, by
     * design, because it is fire-and-forget and every failure in it is deliberate.
     *
     * THAT IS WHY NOTHING WAS EVER SAVED, and it is the whole of the writing half of "memory does not
     * work at all": every other module that calls this one passes the key — `memory-router.ts` (the recall
     * gate), `memory-consolidate.ts`, `memory-brief.ts` — and extraction alone did not, so the one path
     * that writes memories automatically was the one path that never ran. An explicit `memory_save` still
     * worked, which is exactly why this read as "the feature is broken" rather than "the feature never
     * started": the tool the model could call did something.
     *
     * BEFORE THE BUDGET CHECK, which is the other half of that sentence. The write budget is a count of
     * what has been saved today, so it was being queried once per turn for a function that then returned
     * without doing anything — a pointless database round trip on the hot path of every conversation, for
     * the whole life of the process. Now the chain is built first, and a deployment with no key spends
     * nothing at all.
     */
    const chain = buildModelChain(
      input.model,
      input.environment ?? process.env,
      input.apiKey ?? null,
    );
    if (chain.length === 0) return;

    // Write budget: the daemon stops saving for the day once the person has
    // banked enough auto-extracted facts. An explicit `memory_save` is never
    // budgeted — a person saying "remember this" is always honoured — but
    // the background pass must not pile trivia onto a noisy store.
    const { memoryConfig } = await import("./memory-config");
    const spent = await input.store
      .autoSavesToday(input.actorId)
      .catch(() => 0);
    if (spent >= memoryConfig.dailySaveBudget) return;

    let text = "";
    let lastError: unknown = null;
    for (const link of chain) {
      try {
        const { client, model, extraBody } = clientOf(link);
        const completion = await client.chat.completions.create(
          {
            model,
            messages: [
              { role: "system", content: DAEMON_PROMPT },
              {
                role: "user",
                content: `Exchange:\nUser: "${userText}"\nAssistant: "${assistantText}"\n\nExtract any durable facts or preferences:`,
              },
            ],
            max_tokens: 500,
            ...(extraBody ?? {}),
          },
          { timeout: 60_000 },
        );
        text = completion.choices?.[0]?.message?.content?.trim() ?? "";
        if (text) break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!text || text.toLowerCase().includes("<none>")) return;
    void lastError;

    const facts = text
      .split("\n")
      .map((line) => line.replace(/^-\s*/, "").trim())
      .filter((line) => line.length > 5)
      .slice(0, 10);
    for (const fact of facts) {
      try {
        await input.store.saveMemory({
          userId: input.actorId,
          botId: input.botId,
          content: fact,
          scope: "chat",
          source: "auto_extracted",
        });
      } catch {
        // One unsavable fact must not stop the rest.
      }
    }
  } finally {
    running.delete(lock);
  }
}
