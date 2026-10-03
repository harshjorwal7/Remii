import type OpenAI from "openai";
import { buildModelChain } from "./model-router";
import type { createRemiStore } from "./store";

/**
 * Multi-agent memory flow: brief down, debrief up, episodes sideways.
 *
 * Remii (Chief of Staff) orchestrates specialists. A delegation is three
 * memory acts, mirroring how a human team works:
 *
 * 1. BRIEF (`buildBrief`): Remii compiles what the target Bot needs for this
 *    job — the task episode so far, relevant user-layer facts, explicit
 *    constraints and don'ts — and nothing else. The specialist never rummages
 *    through another agent's memories; it receives a brief.
 * 2. EXECUTE: the specialist works inside the brief plus its own role
 *    memory, writing progress to the task episode (never to global).
 * 3. DEBRIEF (`debriefHandoff`): the outcome is distilled into durable
 *    conclusions saved to the user layer; task trivia stays in the episode.
 *
 * On close (`closeTaskEpisode`), the episode compresses to a few conclusions
 * and expires. Parallel tasks never see each other's episodes, and global
 * only ever holds what's true across tasks.
 */

function clientOf(link: {
  client: OpenAI;
  model: string;
  extraBody?: Record<string, unknown>;
}) {
  return link;
}

async function completeJson<T>(input: {
  model: { provider: "openai"; model: string };
  apiKey?: string | null;
  environment?: Record<string, string | undefined>;
  system: string;
  user: string;
  maxTokens: number;
}): Promise<T | null> {
  const chain = buildModelChain(
    input.model,
    input.environment ?? process.env,
    input.apiKey,
  );
  // No key, no brief magic: the caller falls back to handing the raw task
  // text over, which is what every delegation did before briefs existed.
  if (chain.length === 0) return null;
  for (const link of chain) {
    try {
      const { client, model, extraBody } = clientOf(link);
      const completion = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          max_tokens: input.maxTokens,
          temperature: 0.2,
          ...(extraBody ?? {}),
        },
        { timeout: 60_000 },
      );
      const text = completion.choices?.[0]?.message?.content?.trim() ?? "";
      if (!text) continue;
      const json = text
        .replace(/^```json\s*/i, "")
        .replace(/```$/, "")
        .trim();
      return JSON.parse(json) as T;
    } catch {}
  }
  return null;
}

export type HandoffBrief = {
  brief: string;
  /** Memory ids the brief drew on (episode + user layer), for the trail. */
  sourceIds: string[];
};

export async function buildBrief(input: {
  store: ReturnType<typeof createRemiStore>;
  userId: string;
  /** The Bot being briefed (its own role memory stays its own business). */
  targetBotId: string;
  /** The task episode id (thread id). Created implicitly by the first write. */
  taskId: string;
  /** What is being asked, in the delegator's words. */
  task: string;
  /** Explicit constraints ("Coco drafts, never sends", "no further compensation"). */
  constraints?: string[];
  model: { provider: "openai"; model: string };
  environment?: Record<string, string | undefined>;
}): Promise<HandoffBrief> {
  const episode = await input.store
    .listMemories({
      userId: input.userId,
      taskId: input.taskId,
      limit: 30,
    })
    .catch(() => []);
  const episodeText =
    episode.length > 0
      ? episode.map((row) => `- ${row.content}`).join("\n")
      : "(nothing recorded on this task yet)";
  const relevant = await input.store
    .searchMemories({
      userId: input.userId,
      botId: input.targetBotId,
      query: input.task.slice(0, 500),
      limit: 8,
    })
    .catch(() => ({ found: false as const, memories: [] }));
  const knownText =
    relevant.memories.length > 0
      ? relevant.memories.map((memory) => `- ${memory.content}`).join("\n")
      : "(nothing relevant remembered)";
  const constraints =
    input.constraints && input.constraints.length > 0
      ? input.constraints.map((rule) => `- ${rule}`).join("\n")
      : "(none stated)";

  const brief =
    `Task: ${input.task}\n\n` +
    `What is already known on this task:\n${episodeText}\n\n` +
    `Relevant durable context (do not re-derive what is stated here):\n${knownText}\n\n` +
    `Constraints (hard rules, do not break or re-ask):\n${constraints}\n\n` +
    `Work inside this brief plus your own role. Record progress as task memories; ` +
    `do not write anything to long-term memory — the debrief decides what lasts.`;
  const sourceIds = [
    ...episode.map((row) => row.id),
    ...relevant.memories.map((memory) => memory.id),
  ];
  return { brief, sourceIds };
}

export type HandoffDebrief = {
  saved: number;
  ids: string[];
};

const DEBRIEF_PROMPT = `You close out a delegated task. Read the outcome and extract ONLY durable conclusions about the person, their preferences, or how their world works — things true beyond this one task. Task trivia (ids, drafts, step-by-step) is never durable.

Return ONLY a JSON array of 0-5 short declarative statements, e.g. ["Customer X disputes invoices lacking itemized lines"]. Return [] when nothing is durable. No commentary, no markdown.`;

export async function debriefHandoff(input: {
  store: ReturnType<typeof createRemiStore>;
  userId: string;
  /** The Bot that did the work (recorded as source, never as owner). */
  sourceBotId: string;
  taskId: string;
  outcomeText: string;
  model: { provider: "openai"; model: string };
  apiKey?: string | null;
  environment?: Record<string, string | undefined>;
}): Promise<HandoffDebrief> {
  const outcome = input.outcomeText.trim().slice(0, 6000);
  if (!outcome) return { saved: 0, ids: [] };
  const conclusions = await completeJson<string[]>({
    model: input.model,
    apiKey: input.apiKey,
    environment: input.environment,
    system: DEBRIEF_PROMPT,
    user: `Outcome:\n${outcome}`,
    maxTokens: 400,
  });
  if (!Array.isArray(conclusions) || conclusions.length === 0) {
    return { saved: 0, ids: [] };
  }
  const ids: string[] = [];
  const promoted: Array<{ id: string; content: string }> = [];
  for (const conclusion of conclusions.slice(0, 5)) {
    if (typeof conclusion !== "string" || conclusion.trim().length < 8) {
      continue;
    }
    try {
      const saved = await input.store.saveMemory({
        userId: input.userId,
        content: conclusion.trim().slice(0, 2000),
        scope: "global",
        source: "handoff_debrief",
      });
      if (saved.saved && saved.id) {
        ids.push(saved.id);
        promoted.push({ id: saved.id, content: conclusion.trim() });
      }
    } catch {
      // One unsavable conclusion must not stop the rest.
    }
  }
  // Entity links for what lasted, so recall-by-entity finds it later.
  if (promoted.length > 0) {
    try {
      const { extractEntities } = await import("./memory-router");
      const groups = await extractEntities(
        promoted.map((row) => row.content),
        {
          model: input.model,
          apiKey: input.apiKey,
          environment: input.environment,
        },
      );
      for (let index = 0; index < promoted.length; index++) {
        const entities = groups[index];
        const row = promoted[index];
        if (!entities || entities.length === 0 || !row) continue;
        await input.store
          .linkMemoryEntities({
            memoryId: row.id,
            userId: input.userId,
            entities,
          })
          .catch(() => undefined);
      }
    } catch {
      // Linking is enrichment beside the debrief, never the debrief itself.
    }
  }
  return { saved: ids.length, ids };
}

const EPISODE_CLOSE_PROMPT = `You close a finished task. Read its episode notes and write the 0-5 durable conclusions worth keeping about the person (preferences, decisions, standing rules learned). Task trivia (ids, drafts, play-by-play) is never durable.

Return ONLY a JSON array of short declarative statements, e.g. ["Customer X prefers PDF invoices"]. Return [] when nothing lasts. No commentary, no markdown.`;

/**
 * Close a task episode: compress to conclusions, expire the trivia.
 *
 * Conclusions promote to the user layer; the episode rows get a near expiry
 * so parallel tasks' details fade instead of lingering in recall. Returns
 * the promoted fact ids.
 */
export async function closeTaskEpisode(input: {
  store: ReturnType<typeof createRemiStore>;
  userId: string;
  taskId: string;
  model: { provider: "openai"; model: string };
  apiKey?: string | null;
  environment?: Record<string, string | undefined>;
  /** Override the conclusions (tests). Defaults to the model. */
  conclude?: (notes: string[]) => Promise<string[]>;
}): Promise<{ promoted: string[] }> {
  const episode = await input.store
    .listMemories({ userId: input.userId, taskId: input.taskId, limit: 50 })
    .catch(() => []);
  const promoted: string[] = [];
  const promotedTexts: Array<{ id: string; content: string }> = [];
  if (episode.length > 0) {
    const notes = episode.map((row) => row.content);
    const conclusions = input.conclude
      ? await input.conclude(notes).catch(() => null)
      : await completeJson<string[]>({
          model: input.model,
          apiKey: input.apiKey,
          environment: input.environment,
          system: EPISODE_CLOSE_PROMPT,
          user: `Episode notes:\n${notes
            .map((note) => `- ${note}`)
            .join("\n")
            .slice(0, 8000)}`,
          maxTokens: 400,
        });
    if (Array.isArray(conclusions)) {
      for (const conclusion of conclusions.slice(0, 5)) {
        if (typeof conclusion !== "string" || conclusion.trim().length < 8) {
          continue;
        }
        try {
          const saved = await input.store.saveMemory({
            userId: input.userId,
            content: conclusion.trim().slice(0, 2000),
            scope: "global",
            source: "episode_close",
          });
          if (saved.saved && saved.id) {
            promoted.push(saved.id);
            promotedTexts.push({ id: saved.id, content: conclusion.trim() });
          }
        } catch {
          // One unsavable conclusion must not stop the rest.
        }
      }
    }
  }
  // The episode's job is done: its trivia expires in days, while the
  // promoted conclusions above live on as global rows.
  await input.store
    .expireTaskEpisode({ userId: input.userId, taskId: input.taskId })
    .catch(() => undefined);
  if (promotedTexts.length > 0) {
    try {
      const { extractEntities } = await import("./memory-router");
      const groups = await extractEntities(
        promotedTexts.map((row) => row.content),
        {
          model: input.model,
          apiKey: input.apiKey,
          environment: input.environment,
        },
      );
      for (let index = 0; index < promotedTexts.length; index++) {
        const entities = groups[index];
        const row = promotedTexts[index];
        if (!entities || entities.length === 0 || !row) continue;
        await input.store
          .linkMemoryEntities({
            memoryId: row.id,
            userId: input.userId,
            entities,
          })
          .catch(() => undefined);
      }
    } catch {
      // Linking is enrichment beside the close, never the close itself.
    }
  }
  return { promoted };
}
