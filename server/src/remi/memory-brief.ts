import type { createRemiStore } from "./store";

/**
 * Proactive memory (Phase 6): the morning brief.
 *
 * Recall without being asked, driven by the clock rather than a query. Once
 * a day the worker asks for one per user with open work: open todos, recent
 * task episodes still warm, and the durable context around them. The brief is
 * saved as an artifact (`briefing-YYYY-MM-DD`) so the Memory page shows it
 * and nothing is pushed anywhere uninvited — briefing is reading, not
 * interrupting.
 */

const BRIEF_PROMPT = `Write a short morning brief for the person, in second person, plain sentences. Sections only when they have content: "Open loops" (todos past or due, with what is blocked), "Worth remembering today" (1-3 durable facts relevant to what is open), "Suggested" (at most 2 concrete next actions). Under 200 words total. No greeting, no filler, no markdown headings (plain lines fine). If there is nothing open and nothing relevant, answer exactly: QUIET.`;

export async function buildMorningBrief(input: {
  store: ReturnType<typeof createRemiStore>;
  userId: string;
  model: { provider: "openai"; model: string };
  apiKey?: string | null;
  environment?: Record<string, string | undefined>;
  date?: string;
}): Promise<{ briefed: boolean; artifactId: string | null }> {
  const store = input.store;
  const [todos, recentGlobals] = await Promise.all([
    store.todos.list({ userId: input.userId, limit: 15 }).catch(() => []),
    store.listMemories({ userId: input.userId, limit: 15 }).catch(() => []),
  ]);
  const openTodos = todos.filter((todo) =>
    ["OPEN", "IN_PROGRESS", "NEEDS_REVIEW"].includes(todo.status),
  );
  // No open work and no fresh task activity: nothing actionable, so no model
  // call. A nightly LLM pass per user regardless would burn spend restating
  // a quiet workspace.
  if (openTodos.length === 0) {
    const active = await store
      .hasRecentTaskActivity({ userId: input.userId })
      .catch(() => true);
    if (!active) return { briefed: false, artifactId: null };
  }
  const context = recentGlobals.filter((row) => row.scope !== "task");
  if (openTodos.length === 0 && context.length === 0) {
    return { briefed: false, artifactId: null };
  }
  const { buildModelChain } = await import("./model-router");
  const chain = buildModelChain(
    input.model,
    input.environment ?? process.env,
    input.apiKey,
  );
  if (chain.length === 0) return { briefed: false, artifactId: null };
  const material =
    `Open todos:\n${openTodos.map((todo) => `- [${todo.status}] ${todo.title}`).join("\n") || "(none)"}\n\n` +
    `Remembered context:\n${context.map((row) => `- ${row.content}`).join("\n") || "(none)"}`;
  let text = "";
  for (const link of chain) {
    try {
      const completion = await link.client.chat.completions.create(
        {
          model: link.model,
          messages: [
            { role: "system", content: BRIEF_PROMPT },
            { role: "user", content: material.slice(0, 6000) },
          ],
          max_tokens: 500,
          temperature: 0.3,
          ...(link.extraBody ?? {}),
        },
        { timeout: 60_000 },
      );
      text = completion.choices?.[0]?.message?.content?.trim() ?? "";
      if (text) break;
    } catch {}
  }
  if (!text || text === "QUIET") return { briefed: false, artifactId: null };
  const day = input.date ?? new Date().toISOString().slice(0, 10);
  const name = `briefing-${day}.md`;
  const existing = await store.artifacts
    .byIdOrName(input.userId, name)
    .catch(() => null);
  if (existing) return { briefed: false, artifactId: existing.id };
  const id = await store.artifacts
    .create({
      userId: input.userId,
      name,
      url: `memory://${input.userId}/${name}`,
      mimeType: "text/markdown",
      size: Buffer.byteLength(text, "utf8"),
      extractedText: text.slice(0, 50_000),
      source: "morning-brief",
    })
    .catch(() => null);
  return { briefed: id !== null, artifactId: id };
}
