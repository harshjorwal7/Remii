import type { createRemiStore } from "./store";

/**
 * Nightly memory consolidation: merge duplicates, resolve contradictions.
 *
 * A flat memory store rots two ways: the same fact saved five times, and two
 * rival facts both recalled with equal weight ("works at A" vs "works at
 * B"). Both make the agent repeat stale things confidently. This job reads
 * one person's live memories, asks the model to find the dupes and the
 * fights, and links losers to winners via `superseded_by` — kept for audit,
 * excluded from every recall path.
 *
 * Authority ordering (who wins a fight): user-stated beats Remii-confirmed
 * beats specialist inference beats auto-extraction; newer beats older within
 * a tier. Dry-run mode logs decisions and changes nothing: run it that way
 * for a week before letting it write.
 */

export type ConsolidationReport = {
  checked: number;
  merged: number;
  superseded: number;
  decisions: Array<{
    winnerId: string;
    loserIds: string[];
    reason: string;
  }>;
};

type Candidate = { id: string; content: string; source: string | null };

const CONSOLIDATE_PROMPT = `You deduplicate and arbitrate one person's remembered facts.

Input is a JSON array of {id, content, source}. Sources: "explicit" (the person stated it), "handoff_debrief" or "episode_close" (a Bot concluded it from work), "auto_extracted" (daemon guess).

Return ONLY JSON: {"groups": [{"keep": "<id>", "drop": ["<id>"], "reason": "<one line>"}]}. Rules:
- Same fact twice: keep the earliest, drop the rest ("duplicate").
- Contradictions: keep ONE. Authority: explicit user statements beat everything; then handoff/episode conclusions; auto-extracted guesses lose ties. Within a tier, newer information beats older. Reason must name the rule, e.g. "newer explicit statement supersedes older guess".
- Unrelated facts: leave them out entirely.
- When in doubt, do nothing: a missed merge is cheaper than a wrong supersession.
- At most 20 groups. No commentary, no markdown.`;

export async function consolidateUserMemory(input: {
  store: ReturnType<typeof createRemiStore>;
  userId: string;
  model: { provider: "openai"; model: string };
  apiKey?: string | null;
  environment?: Record<string, string | undefined>;
  limit?: number;
  dryRun?: boolean;
  decide?: (candidates: Candidate[]) => Promise<{
    groups: Array<{ keep: string; drop: string[]; reason: string }>;
  }>;
}): Promise<ConsolidationReport> {
  const report: ConsolidationReport = {
    checked: 0,
    merged: 0,
    superseded: 0,
    decisions: [],
  };
  const rows = await input.store
    .listMemories({ userId: input.userId, limit: input.limit ?? 200 })
    .catch(() => []);
  /*
   * `source` is what the arbitration below is decided on, so it is read rather than assumed.
   *
   * It used to be hard-coded to `null` for every candidate, with a comment saying the field was not
   * projected and would be re-read. The re-read was never written, so the model that
   * `CONSOLIDATE_PROMPT` asks to rank by authority — "explicit user statements beat everything; then
   * handoff/episode conclusions; auto-extracted guesses lose ties" — was handed a list where every
   * source read `null`.
   *
   * That is not a cosmetic gap. The job's whole output is `superseded_by`, and a superseded row is
   * excluded from every recall path, so a nightly pass was permanently retiring a real remembered
   * fact on a coin flip between two equally-ranked candidates, with the one piece of evidence the
   * decision was specified to consider missing. It failed quietly because a duplicate merge looks
   * exactly like a correct one in the report.
   */
  const candidates: Candidate[] = rows.map((row) => ({
    id: row.id,
    content: row.content,
    source: row.source ?? null,
  }));
  report.checked = candidates.length;
  if (candidates.length < 2) return report;

  let groups: Array<{ keep: string; drop: string[]; reason: string }> = [];
  if (input.decide) {
    const decided = await input.decide(candidates).catch(() => null);
    if (decided) groups = decided.groups ?? [];
  } else {
    groups = (await decideWithModel(input, candidates)) ?? [];
  }
  // Entity linking for the checked set, batched into few model calls:
  // recall-by-entity downstream depends on these links existing.
  try {
    const { extractEntities } = await import("./memory-router");
    const linked = await extractEntities(
      candidates.map((row) => row.content),
      {
        model: input.model,
        apiKey: input.apiKey,
        environment: input.environment,
      },
    );
    for (let index = 0; index < candidates.length; index++) {
      const entities = linked[index];
      const candidate = candidates[index];
      if (!entities || entities.length === 0 || !candidate) continue;
      await input.store
        .linkMemoryEntities({
          memoryId: candidate.id,
          userId: input.userId,
          entities,
        })
        .catch(() => undefined);
    }
  } catch {
    // Linking is enrichment beside consolidation, never consolidation itself.
  }
  const byId = new Map(candidates.map((row) => [row.id, row]));
  for (const group of groups.slice(0, 20)) {
    const winner = byId.get(group.keep);
    const losers = (group.drop ?? []).filter(
      (id) => id !== group.keep && byId.has(id),
    );
    if (!winner || losers.length === 0) continue;
    report.decisions.push({
      winnerId: winner.id,
      loserIds: losers,
      reason: String(group.reason ?? "duplicate").slice(0, 300),
    });
    if (input.dryRun) continue;
    for (const loserId of losers) {
      try {
        await input.store.supersedeMemory({
          id: loserId,
          userId: input.userId,
          supersededBy: winner.id,
        });
        report.merged += 1;
        report.superseded += 1;
      } catch {
        // One failed link must not stop the rest.
      }
    }
  }
  return report;
}

async function decideWithModel(
  input: {
    model: { provider: "openai"; model: string };
    apiKey?: string | null;
    environment?: Record<string, string | undefined>;
  },
  candidates: Candidate[],
): Promise<Array<{
  keep: string;
  drop: string[];
  reason: string;
}> | null> {
  const { buildModelChain } = await import("./model-router");
  const chain = buildModelChain(
    input.model,
    input.environment ?? process.env,
    input.apiKey,
  );
  if (chain.length === 0) return null;
  /*
   * Carries `source`, which is what the prompt's first line tells the model the input is.
   *
   * It was building `{id, content}` while `CONSOLIDATE_PROMPT` opens with "Input is a JSON array of
   * {id, content, source}" — so the authority rule had no field to read even once the store projected
   * one. Prompt and payload have to agree, or the model is asked to rank on something it was never
   * sent and quietly falls back to recency.
   */
  const payload = candidates
    .map((row) => ({
      id: row.id,
      content: row.content.slice(0, 500),
      source: row.source ?? "unknown",
    }))
    .slice(0, 120);
  for (const link of chain) {
    try {
      const completion = await link.client.chat.completions.create(
        {
          model: link.model,
          messages: [
            { role: "system", content: CONSOLIDATE_PROMPT },
            { role: "user", content: JSON.stringify(payload) },
          ],
          max_tokens: 2000,
          temperature: 0,
          ...(link.extraBody ?? {}),
        },
        { timeout: 120_000 },
      );
      const text = completion.choices?.[0]?.message?.content?.trim() ?? "";
      if (!text) continue;
      const parsed = JSON.parse(
        text
          .replace(/^```json\s*/i, "")
          .replace(/```$/, "")
          .trim(),
      ) as {
        groups?: Array<{ keep: string; drop: string[]; reason: string }>;
      };
      if (Array.isArray(parsed.groups)) return parsed.groups;
    } catch {}
  }
  return null;
}
