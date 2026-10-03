import type { RunAgentInput } from "@ag-ui/client";
import type OpenAI from "openai";
import { memoryConfig } from "./memory-config";
import { buildModelChain } from "./model-router";
import type { createRemiStore } from "./store";

/**
 * Pre-turn memory recall: what the person needs remembered, before the run.
 *
 * Today recall is opt-in — the model must think to call `memory_search`,
 * with a query it invents, or it knows nothing, even about things it saved
 * yesterday. Humans work the other way: relevant memories surface unbidden,
 * and only when relevant. This module is that half:
 *
 * 1. `decideRecall` — a cheap gate over the incoming message. Greetings,
 *    acknowledgements and tool-result continuations need nothing; anything
 *    that could depend on the person, their preferences, or past work gets
 *    1–3 retrieval queries from a small model call.
 * 2. `recallForTurn` — runs the queries through the existing hybrid search,
 *    fuses and dedupes, records `recalled` events, and formats the block the
 *    run injects. Returns null when nothing is needed or nothing found, so
 *    the prompt stays clean and repetition has nowhere to start.
 *
 * Scoping is the sandbox rule, not a suggestion: global/persona rows plus
 * this Bot's own chat rows. Never another Bot's chat rows — the expense Bot
 * must not ramble about support tickets because vector similarity matched.
 */

export type RecallDecision =
  | { needed: false }
  | { needed: true; queries: string[] };

/** Fast path: messages that can never need memory, decided without a model call. */
const NEVER_NEEDS_RECALL =
  /^(hi|hey|hello|yo|thanks|thank you|thx|ok|okay|k|got it|👍|🙏|bye|good (morning|afternoon|evening|night)|how are you)[.!…]*$/i;

const GATE_PROMPT = `You decide whether answering the person's message could depend on anything remembered about them: preferences, identity, past decisions, ongoing work, relationships, how things work in their world.

Answer with exactly one line: either "NO" or up to 3 short search queries, one per line, most important first. Queries name what to recall ("manager name", "invoice dispute preference"), never the message itself.

Examples:
- "hi" -> NO
- "thanks!" -> NO
- "book me a flight like last time" -> "travel preferences\nlast flight booking"
- "what did we decide about the launch?" -> "launch decisions"
- "email John about the contract" -> "John contact\ncontract context"`;

const MAX_QUERY_CHARS = 160;

function clientOf(link: {
  client: OpenAI;
  model: string;
  extraBody?: Record<string, unknown>;
}) {
  return link;
}

export async function decideRecall(input: {
  userText: string;
  model: { provider: "openai"; model: string };
  apiKey?: string | null;
  environment?: Record<string, string | undefined>;
}): Promise<RecallDecision> {
  const text = input.userText.trim().slice(0, 2000);
  if (!text || text.length < 2 || NEVER_NEEDS_RECALL.test(text)) {
    return { needed: false };
  }
  const chain = buildModelChain(
    input.model,
    input.environment ?? process.env,
    input.apiKey,
  );
  if (chain.length === 0) return { needed: false };
  for (const link of chain) {
    try {
      const { client, model, extraBody } = clientOf(link);
      const completion = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: GATE_PROMPT },
            { role: "user", content: text },
          ],
          max_tokens: 120,
          temperature: 0,
          ...(extraBody ?? {}),
        },
        { timeout: 20_000 },
      );
      const out = completion.choices?.[0]?.message?.content?.trim() ?? "";
      if (!out || /^no$/i.test(out.split("\n")[0] ?? "")) {
        return { needed: false };
      }
      const queries = out
        .split("\n")
        .map((line) =>
          line
            .replace(/^[-*\d.)\s]+/, "")
            .trim()
            .slice(0, MAX_QUERY_CHARS),
        )
        .filter((line) => line.length > 2 && !/^no$/i.test(line))
        .slice(0, 3);
      if (queries.length === 0) return { needed: false };
      return { needed: true, queries };
    } catch {}
  }
  // A dead gate must not take recall down with it: fail open would spam
  // context, fail closed would drop memory. Closed is correct — the model
  // still holds memory_search for the turn.
  return { needed: false };
}

export type RecalledMemory = { id: string; content: string; relevance: number };

export async function recallForTurn(input: {
  store: ReturnType<typeof createRemiStore>;
  userId: string;
  botId: string;
  userText: string;
  turnId?: string;
  /**
   * The task episode (thread id): its rows join the read so parallel jobs
   * never see each other's working notes.
   */
  taskId?: string;
  model: { provider: "openai"; model: string };
  apiKey?: string | null;
  environment?: Record<string, string | undefined>;
  limit?: number;
  /**
   * Override the gate (tests, future custom gates). Defaults to
   * {@link decideRecall}.
   */
  gate?: (text: string) => Promise<RecallDecision>;
}): Promise<{
  block: string | null;
  memoryIds: string[];
  memories: Array<{ id: string; content: string }>;
}> {
  const decision = input.gate
    ? await input.gate(input.userText)
    : await decideRecall({
        userText: input.userText,
        model: input.model,
        apiKey: input.apiKey,
        environment: input.environment,
      });
  if (!decision.needed) return { block: null, memoryIds: [], memories: [] };
  const limit = Math.min(input.limit ?? memoryConfig.recallTopK, 10);
  const seen = new Map<string, { content: string; relevance: number }>();
  for (const query of decision.queries) {
    let result: Awaited<ReturnType<typeof input.store.searchMemories>>;
    try {
      result = await input.store.searchMemories({
        userId: input.userId,
        botId: input.botId,
        query,
        limit,
        /*
         * The task episode, joined on the SEARCH as well as on the entity boost below.
         *
         * It was only passed to `recallByEntity`, so the two halves of one result set had different
         * visibility: entity-linked rows were confined to this episode, while the vector and keyword
         * rows fell back to the Bot-wide predicate `(scope = 'chat' AND bot_id = …)`. Since the two
         * are then merged and ranked together, a parallel job's working notes were eligible to be
         * injected into this run — the exact thing this module's own header rules out ("parallel
         * jobs never see each other's working notes"), and it failed silently, because the recall
         * that did it was simply a good vector match.
         *
         * The store is explicit that a task read sees its own episode plus the user layer, so the two
         * halves now agree on what "this turn" can see.
         */
        ...(input.taskId ? { taskId: input.taskId } : {}),
      });
    } catch {
      continue;
    }
    for (const memory of result.memories) {
      const prior = seen.get(memory.id);
      if (!prior || prior.relevance < memory.relevance) {
        seen.set(memory.id, {
          content: memory.content,
          relevance: memory.relevance,
        });
      }
    }
    if (seen.size >= limit) break;
  }
  // Entity boost: names and aliases the message mentions resolve to
  // linked memories directly — "everything about Project Y" without
  // depending on vector luck. Merged below top vector hits so a passing
  // mention cannot outrank a direct semantic match.
  try {
    const matched = await input.store.matchEntities({
      userId: input.userId,
      text: input.userText,
    });
    for (const entity of matched) {
      const linked = await input.store
        .recallByEntity({
          userId: input.userId,
          botId: input.botId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          entityId: entity.id,
          limit: 5,
        })
        .catch(() => []);
      for (const memory of linked) {
        if (!seen.has(memory.id)) {
          seen.set(memory.id, { content: memory.content, relevance: 0.85 });
        }
      }
      if (seen.size >= limit + 5) break;
    }
  } catch {
    // Entity boost is enrichment beside retrieval, never retrieval itself.
  }
  const top = [...seen.entries()]
    .sort((a, b) => b[1].relevance - a[1].relevance)
    .slice(0, limit);
  if (top.length === 0) return { block: null, memoryIds: [], memories: [] };
  const ids = top.map(([id]) => id);
  // Served, not yet used: the run records `cited` afterwards for the ones
  // that visibly shaped the answer (see loop-agent.ts).
  for (const id of ids) {
    await input.store
      .recordMemoryEvent({
        memoryId: id,
        userId: input.userId,
        botId: input.botId,
        kind: "recalled",
        ...(input.turnId ? { turnId: input.turnId } : {}),
      })
      .catch(() => undefined);
  }
  const lines = top.map(([id, memory]) => `- [${id}] ${memory.content}`);
  return {
    block:
      `What you remember about this person (only what is relevant below; do not repeat it back unprompted):\n` +
      lines.join("\n"),
    memoryIds: ids,
    memories: top.map(([id, memory]) => ({ id, content: memory.content })),
  };
}

/**
 * Which recalled memories the answer visibly used.
 *
 * Heuristic, deliberately strict: a clause of the memory (split on sentence
 * and phrase boundaries, minimum 25 characters) appearing verbatim in the
 * reply, normalized for case and whitespace. Whole-prefix matching missed
 * real uses, because answers quote the distinctive tail ("salted peanuts"),
 * not the scaffolding ("the person's favorite debugging snack is ...").
 * Cited rows feed the forgetting curve; everything served-but-unused stays
 * `recalled`.
 */
export function citedMemoryIds(
  memories: Array<{ id: string; content: string }>,
  assistantText: string,
): string[] {
  // Memories speak third-person ("the person's favorite snack"), answers
  // speak second-person ("your favorite snack"). Without bridging that gap,
  // real uses never match and reinforcement starves.
  const voice = (text: string): string =>
    text
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/\byours\b/g, "the person's")
      .replace(/\byour\b/g, "the person's")
      .replace(/\byou\b/g, "the person");
  const normalized = voice(assistantText);
  if (!normalized) return [];
  const cited: string[] = [];
  for (const memory of memories) {
    const clauses = voice(memory.content)
      .split(/[.!?;:\n]+/)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length >= 25);
    if (clauses.some((clause) => normalized.includes(clause))) {
      cited.push(memory.id);
    }
  }
  return cited;
}

/**
 * The per-(actor, deployment) memory hooks a run carries.
 *
 * Bound once per actor beside `loadToolsForActor`: recall needs the person's
 * store rows, and citation events must land on their id. `recall` answers
 * with a prompt block (or null); `recordCited` files the used ids. Both are
 * best-effort — a failure recalls nothing and cites nothing, never fails a
 * turn — because memory is housekeeping beside the conversation, not the
 * conversation.
 */
export type RecallHooks = {
  recall: (
    botId: string,
    input: RunAgentInput,
  ) => Promise<{
    block: string | null;
    memoryIds: string[];
    memories: Array<{ id: string; content: string }>;
  } | null>;
  recordCited: (botId: string, memoryIds: string[]) => Promise<void>;
};

function latestUserText(messages: RunAgentInput["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as unknown as
      | { role?: unknown; content?: unknown }
      | undefined;
    if (message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          typeof part === "string"
            ? part
            : typeof part === "object" && part !== null && "text" in part
              ? String((part as { text?: unknown }).text ?? "")
              : "",
        )
        .join("\n");
    }
    return "";
  }
  return "";
}

export function recallHooksFor(input: {
  store: ReturnType<typeof createRemiStore>;
  userId: string;
  model: { provider: "openai"; model: string };
  /**
   * The resolved model key, read per turn rather than captured at boot: a
   * credential added a moment ago applies to the next recall, and a missing
   * one closes the gate instead of failing the turn.
   */
  getApiKey?: () => Promise<string | null>;
  environment?: Record<string, string | undefined>;
  gate?: (text: string) => Promise<RecallDecision>;
}): RecallHooks {
  // The gate spends the resolved model key beside the deployment default:
  // recall must not depend on per-turn key resolution, or a missing key would
  // take memory down with the model. Absent, the gate stays closed and the
  // model still holds memory_search for the turn.
  const chainModel = input.model;
  const environment = input.environment ?? process.env;
  return {
    recall: async (botId, runInput) => {
      const userText = latestUserText(runInput.messages ?? []);
      if (!userText.trim()) return null;
      const recalled = await recallForTurn({
        store: input.store,
        userId: input.userId,
        botId,
        taskId:
          typeof runInput.threadId === "string" && runInput.threadId
            ? runInput.threadId
            : undefined,
        apiKey: await input.getApiKey?.().catch(() => null),
        ...(input.gate ? { gate: input.gate } : {}),
        userText,
        turnId:
          typeof runInput.runId === "string" && runInput.runId
            ? runInput.runId
            : undefined,
        model: chainModel,
        environment,
      });
      if (!recalled.block) return null;
      return {
        block: recalled.block,
        memoryIds: recalled.memoryIds,
        memories: recalled.memories,
      };
    },
    recordCited: async (botId, memoryIds) => {
      for (const id of memoryIds) {
        await input.store
          .recordMemoryEvent({
            memoryId: id,
            userId: input.userId,
            botId,
            kind: "cited",
          })
          .catch(() => undefined);
      }
    },
  };
}

const ENTITY_PROMPT = `Extract the named entities memories are about: people, projects, companies, places, topics. Input lines are numbered "INDEX: text". Return ONLY a JSON array with one entry per input line that has any: [{"index":0,"entities":[{"type":"person","name":"Prakhar","aliases":[]}]}]. Types: person, project, company, place, topic. At most 6 entities per line. Concrete proper nouns only — no generic words like "email" or "meeting". Skip lines with none (no empty entries). No commentary, no markdown.`;

/**
 * Which entities a batch of memory texts is about (Phase 5).
 *
 * Batched into one model call per ~20 texts: entity linking must never cost
 * a call per fact. Returns parallel arrays (entities per input index); a
 * failure anywhere yields empties rather than failing the caller, because
 * linking is enrichment beside storage, never storage itself.
 */
export async function extractEntities(
  texts: string[],
  input: {
    model: { provider: "openai"; model: string };
    apiKey?: string | null;
    environment?: Record<string, string | undefined>;
  },
): Promise<Array<Array<{ type: string; name: string; aliases: string[] }>>> {
  const empty = texts.map(() => []);
  /*
   * Paired with the index it came from, and the pairing is the point.
   *
   * This used to filter the texts first (`texts.map(…).filter(Boolean)`) and then number the filtered
   * list from zero. One blank memory text therefore shifted every later index by one, and because the
   * model is asked to echo the index it was given, its answer was written straight into `out[at]` —
   * so entity "John" was linked to the memory AFTER the one that mentioned him. Nothing errored: a
   * wrong-but-confident link is exactly what an entity table cannot detect, and the symptom is a
   * person whose name surfaces on an unrelated memory weeks later.
   */
  const batch = texts
    .map((text, index) => ({ text: text.slice(0, 600), index }))
    .filter((entry) => entry.text.length > 0);
  if (batch.length === 0) return empty;
  const { buildModelChain } = await import("./model-router");
  const chain = buildModelChain(
    input.model,
    input.environment ?? process.env,
    input.apiKey,
  );
  if (chain.length === 0) return empty;
  const out: Array<Array<{ type: string; name: string; aliases: string[] }>> =
    texts.map(() => []);
  for (let start = 0; start < batch.length; start += 20) {
    const slice = batch.slice(start, start + 20);
    let parsed: unknown = null;
    for (const link of chain) {
      try {
        const completion = await link.client.chat.completions.create(
          {
            model: link.model,
            messages: [
              { role: "system", content: ENTITY_PROMPT },
              {
                role: "user",
                content: slice
                  .map((entry) => `${entry.index}: ${entry.text}`)
                  .join("\n"),
              },
            ],
            max_tokens: 800,
            temperature: 0,
            ...(link.extraBody ?? {}),
          },
          { timeout: 60_000 },
        );
        const text = completion.choices?.[0]?.message?.content?.trim() ?? "";
        if (!text) continue;
        parsed = JSON.parse(
          text
            .replace(/^```json\s*/i, "")
            .replace(/```$/, "")
            .trim(),
        );
        break;
      } catch {}
    }
    const groups = Array.isArray(parsed) ? parsed : [];
    for (const group of groups) {
      if (typeof group !== "object" || group === null) continue;
      const record = group as { index?: unknown; entities?: unknown };
      if (typeof record.index !== "number") continue;
      // The number is now the index into the ORIGINAL `texts`, exactly as it was numbered in the
      // prompt, so the bounds check is against `texts` rather than against this slice.
      const at = record.index;
      if (at < 0 || at >= texts.length) continue;
      const list = Array.isArray(record.entities) ? record.entities : [];
      out[at] = list
        .filter(
          (
            entry,
          ): entry is {
            type?: unknown;
            name?: unknown;
            aliases?: unknown;
          } => typeof entry === "object" && entry !== null,
        )
        .map((entry) => ({
          type:
            typeof entry.type === "string" && entry.type ? entry.type : "topic",
          name: typeof entry.name === "string" ? entry.name : "",
          aliases: Array.isArray(entry.aliases)
            ? entry.aliases.filter(
                (alias): alias is string => typeof alias === "string",
              )
            : [],
        }))
        .filter((entry) => entry.name.trim().length > 1)
        .slice(0, 6);
    }
  }
  return out;
}
