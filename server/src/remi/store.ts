import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  artifacts,
  automations,
  cronJobs,
  memories,
  memoryEntities,
  memoryEntityLinks,
  memoryEvents,
  senderVerdicts,
  tasks,
} from "../db/schema";
import type { BlobStore } from "../storage/blob-store";
import { CATEGORY_EXPIRY_DAYS } from "./memory-config";

/**
 * Remi's brain, on Remii's database.
 *
 * Durable memory (vector + full-text hybrid search), artifacts, todos and scheduled jobs,
 * ported from remi.in. Keyed on Remii user ids: one Remi instance was one person, and one
 * Remii user is one person. Per-Bot scoping (`botId`) replaces Remi's per-chat scoping,
 * matching how Remii addresses coworkers.
 *
 * Embeddings come from OpenAI (`text-embedding-3-large`, 1024 dimensions) when
 * `EMBEDDINGS_API_KEY` is set, and from a deterministic local hash otherwise. The local
 * fallback keeps every write and read working with no key, but vectors from the two models
 * never mix meaningfully — switching models later orphans old similarities, and the keyword
 * fallback below is what keeps search honest through that.
 */

export type RemiStoreOptions = {
  database: Database;
  /** OpenAI-compatible key for embeddings. Absent means the local-hash fallback. */
  embeddingsApiKey?: string;
  embeddingsBaseUrl?: string;
  /**
   * Where a saved file's bytes are. Absent in tests, and then an artifact's bytes are reached
   * through the pre-driver `url` path — which is also how every row written before this option
   * existed is read, so the fallback is not a test-only branch but the migration's own reading of
   * its own past.
   */
  blobs?: BlobStore;
};

const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMS = 1024;
/** Skip saving when an existing memory is this similar (cosine). */
const DEDUP_SIMILARITY = 0.88;
/**
 * Floor for vector candidates when REAL embeddings are in use.
 *
 * 0.55 is a sentence-similarity threshold, and it is calibrated against vectors from a model trained to
 * put paraphrases near each other. "manager name" and "the person's manager is called John" score well
 * above it.
 */
const SEARCH_SIMILARITY = 0.55;
/**
 * Floor for vector candidates when the LOCAL HASH is in use, and what it can honestly be expected to do.
 *
 * A djb2 feature hash is not a semantic model. It maps words to buckets, so two sentences score highly
 * only when they literally share vocabulary. The recall gate is instructed to invent abstract queries
 * rather than reuse the message ("Queries name what to recall — 'manager name' — never the message
 * itself"), and those share little with the stored sentence.
 *
 * MEASURED, on a six-query grid of gate-style queries against single stored facts: 3 of 6 recalled at
 * 0.55, 4 of 6 at this floor. So this is a real improvement and it is NOT the fix, and the difference
 * matters more than the number. A query with no shared words at all ("who do they work for" against "the
 * person's employer is Northwind Analytics") scores 0.00 against the hash and cannot be recalled at ANY
 * floor — there is no similarity to threshold. Half of semantic recall is simply unavailable without
 * `EMBEDDINGS_API_KEY`, and no constant here changes that.
 *
 * So: keep it low enough to admit the partial lexical overlap a hash actually measures, which stops the
 * floor from discarding the cases the hash CAN see, and be honest in `.env.example` that real recall needs
 * a key. Pretending otherwise is what made this read as a feature that was switched off rather than one
 * running without its model.
 */
const SEARCH_SIMILARITY_LOCAL = 0.12;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Deterministic 1024-d embedding with no network.
 *
 * Feature hashing (djb2 over lowercased words, random sign, log-length weight, L2-normalized):
 * same text always maps to the same vector, near-duplicates land close together, and unrelated
 * texts land far apart in 1024 dimensions. Good enough for dedup and rough recall; the keyword
 * fallback in search covers what it misses.
 */
function localEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMS).fill(0);
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const weight = Math.log(words.length + 1);
  for (const word of new Set(words)) {
    let hash = 5381;
    for (let index = 0; index < word.length; index += 1) {
      hash = ((hash << 5) + hash + word.charCodeAt(index)) >>> 0;
    }
    const sign = hash % 2 === 0 ? 1 : -1;
    vector[hash % EMBEDDING_DIMS] += sign * weight;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/** Obvious card numbers never reach storage. */
function maskPANs(text: string): string {
  return text.replace(/\b\d{13,19}\b/g, "[card-removed]");
}

export function createRemiStore(options: RemiStoreOptions) {
  const { database, blobs } = options;
  /*
   * The OpenAI client, built on first embedding rather than at boot: the SDK is heavy and
   * most boots never embed anything. Null means the local-hash fallback for the life of the
   * process — which is also what a missing key means, decided once and said out loud once.
   */
  let openai: import("openai").default | null | undefined;
  async function embeddings(): Promise<import("openai").default | null> {
    if (openai !== undefined) return openai;
    if (!options.embeddingsApiKey) {
      console.warn(
        "EMBEDDINGS_API_KEY is not set: memory similarity runs on a local hash, " +
          `which matches shared words rather than meaning (similarity floor ` +
          `${SEARCH_SIMILARITY_LOCAL} instead of ${SEARCH_SIMILARITY}). ` +
          "Set an OpenAI key for real embeddings.",
      );
      openai = null;
      return null;
    }
    const { default: OpenAI } = await import("openai");
    openai = new OpenAI({
      apiKey: options.embeddingsApiKey,
      ...(options.embeddingsBaseUrl
        ? { baseURL: options.embeddingsBaseUrl }
        : {}),
    });
    return openai;
  }

  /**
   * The floor a similarity has to clear to be a candidate, which depends on WHO produced the vectors.
   *
   * Not a constant because the two embedders are not the same kind of thing and the same number means
   * opposite things for them: 0.55 is a paraphrase threshold for a trained model and roughly unreachable
   * for a word hash. Using one constant for both is what made recall silently return nothing on every
   * deployment without `EMBEDDINGS_API_KEY` — which is every default install.
   *
   * Read per call rather than cached, because the embedder can change under a live process: an API call
   * that fails falls back to the hash for that one embedding. A cached "we are on the hash" would keep
   * applying the low floor after the real model recovered.
   */
  async function similarityFloor(): Promise<number> {
    return (await embeddings()) ? SEARCH_SIMILARITY : SEARCH_SIMILARITY_LOCAL;
  }

  async function embed(text: string): Promise<number[]> {
    const client = await embeddings();
    if (!client) return localEmbedding(text);
    try {
      const response = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text,
        dimensions: EMBEDDING_DIMS,
      });
      const vector = response.data[0]?.embedding;
      if (vector && vector.length === EMBEDDING_DIMS) return [...vector];
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "remi-embedding-failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return localEmbedding(text);
  }

  return {
    usingRealEmbeddings: openai !== null,

    /**
     * Save a durable fact. Skips near-duplicates, resurrects a soft-deleted same-hash row.
     */
    async saveMemory(input: {
      userId: string;
      botId?: string;
      content: string;
      scope?: string;
      tags?: string[];
      category?: string;
      importance?: number;
      source?: string;
      expiresInDays?: number;
      taskId?: string;
    }): Promise<{ saved: boolean; id: string | null }> {
      const content = maskPANs(input.content.trim()).slice(0, 8000);
      if (!content) return { saved: false, id: null };
      // Category expiry default: working context rots, identity does not.
      // An explicit expiresInDays always wins; null means live indefinitely.
      const categoryKey = input.category?.trim().toLowerCase() ?? "";
      const defaultExpiry =
        input.expiresInDays ?? CATEGORY_EXPIRY_DAYS[categoryKey] ?? null;
      const contentHash = sha256(
        `${input.userId}${input.botId ?? ""}${content}`,
      );
      const vector = await embed(content);
      const literal = vectorLiteral(vector);
      // An empty JS array does not survive as a query parameter for a text[] column, so the
      // empty case is spelled as SQL.
      const tagsExpr =
        input.tags && input.tags.length > 0
          ? sql`${input.tags}`
          : sql`ARRAY[]::text[]`;
      // One statement: skip when something this similar already lives, resurrect a soft-deleted
      // same-hash row, insert otherwise. `ON CONFLICT` needs the unique index, which the
      // migration created; the similarity gate runs first because nearness is not sameness.
      const rows = await database.execute(sql`
        WITH dup_check AS (
          SELECT id FROM memories
          WHERE user_id = ${input.userId}
            AND deleted_at IS NULL
            AND superseded_by IS NULL
            AND (expires_at IS NULL OR expires_at > now())
            AND (1 - (embedding <=> ${literal}::vector)) > ${DEDUP_SIMILARITY}
          LIMIT 1
        ), new_row AS (
          INSERT INTO memories (id, user_id, bot_id, content, content_hash, embedding, scope, tags, category, importance, source, expires_at, task_id)
          SELECT ${randomUUID()}, ${input.userId}, ${input.botId ?? null}, ${content}, ${contentHash}, ${literal}::vector,
            ${input.scope ?? "chat"}, ${tagsExpr}, ${input.category ?? null},
            ${input.importance ?? 5}, ${input.source ?? "explicit"},
            ${defaultExpiry ? sql`now() + (${defaultExpiry} || ' days')::interval` : null},
            ${input.taskId ?? null}
          WHERE NOT EXISTS (SELECT 1 FROM dup_check)
          ON CONFLICT (user_id, bot_id, content_hash) DO UPDATE SET
            deleted_at = NULL, content = EXCLUDED.content, embedding = EXCLUDED.embedding,
            updated_at = now()
          RETURNING id
        )
        SELECT id, 'inserted' AS how FROM new_row
        UNION ALL SELECT id, 'similar' FROM dup_check
      `);
      const first = (rows as unknown as Array<{ id: string; how: string }>)[0];
      if (!first) return { saved: false, id: null };
      /*
       * RECORD THAT IT WAS SAVED.
       *
       * `recordMemoryEvent` accepts a `"saved"` kind and NOTHING ever passed it: the only two call sites
       * were the recall path (`"recalled"`) and the citation path (`"cited"`). So the observability trail
       * for memory contained no saves at all, `recallStats` could only ever report what had been recalled
       * and cited, and a person asking "is it learning anything?" was shown a table with the write half
       * missing rather than one that was empty.
       *
       * Only on a real insert. A duplicate is not a save — it is the statement refusing to save — and
       * recording one would make the stats claim the store is growing when it is not. `inserted` is the
       * branch the caller above already distinguishes, so the distinction is not being invented here.
       *
       * Best-effort, like every other event: a memory that is stored but not tallied is a far smaller
       * problem than a save that fails because the tally did.
       */
      if (first.how === "inserted") {
        await this.recordMemoryEvent({
          memoryId: first.id,
          userId: input.userId,
          ...(input.botId ? { botId: input.botId } : {}),
          kind: "saved",
        });
      }
      return { saved: first.how === "inserted", id: first.id };
    },

    async updateMemory(
      id: string,
      userId: string,
      patch: {
        content?: string;
        scope?: string;
        tags?: string[];
        category?: string | null;
        importance?: number;
        pinned?: boolean;
      },
    ): Promise<boolean> {
      const set: Record<string, unknown> = {};
      if (patch.content !== undefined) {
        const content = maskPANs(patch.content.trim()).slice(0, 8000);
        set.content = content;
        // Hash matches saveMemory exactly (user + bot + content): the unique
        // index is (user_id, bot_id, content_hash), so a hash that omits the
        // Bot collides across coworkers and resurrects the wrong row.
        const [row] = await database
          .select({ botId: memories.botId })
          .from(memories)
          .where(and(eq(memories.id, id), eq(memories.userId, userId)))
          .limit(1)
          .catch(() => []);
        set.contentHash = sha256(`${userId}${row?.botId ?? ""}${content}`);
        set.embedding = vectorLiteral(await embed(content));
      }
      if (patch.scope !== undefined) set.scope = patch.scope;
      if (patch.tags !== undefined) set.tags = patch.tags;
      if (patch.category !== undefined) set.category = patch.category;
      if (patch.importance !== undefined) set.importance = patch.importance;
      if (patch.pinned !== undefined) set.pinned = patch.pinned;
      if (Object.keys(set).length === 0) return false;
      const updated = await database
        .update(memories)
        .set(set)
        .where(and(eq(memories.id, id), eq(memories.userId, userId)))
        .returning({ id: memories.id });
      return updated.length > 0;
    },

    /**
     * Link a memory as replaced by another (consolidation, debrief revision).
     * The row is kept for audit but leaves every recall path: save-dup,
     * search (all three lanes), and list all filter `superseded_by IS NULL`.
     * Refuses to re-link an already-superseded row, so two jobs racing cannot
     * chain losers onto losers.
     */
    async supersedeMemory(input: {
      id: string;
      userId: string;
      supersededBy: string;
    }): Promise<boolean> {
      const updated = await database
        .update(memories)
        .set({ supersededBy: input.supersededBy, validUntil: new Date() })
        .where(
          and(
            eq(memories.id, input.id),
            eq(memories.userId, input.userId),
            isNull(memories.deletedAt),
            isNull(memories.supersededBy),
          ),
        )
        .returning({ id: memories.id });
      return updated.length > 0;
    },

    /**
     * Reinforce a memory the answer visibly used (Phase 4 forgetting curve).
     *
     * Cited memories get harder to forget: importance climbs toward 10 and
     * the recall stamp moves to now. Served-but-ignored memories get nothing,
     * so the curve separates used knowledge from wallpaper on its own.
     */
    async reinforceMemory(input: {
      id: string;
      userId: string;
    }): Promise<boolean> {
      const updated = await database
        .update(memories)
        .set({
          importance: sql`LEAST(${memories.importance} + 1, 10)`,
          lastRecalledAt: new Date(),
        })
        .where(
          and(
            eq(memories.id, input.id),
            eq(memories.userId, input.userId),
            isNull(memories.deletedAt),
            isNull(memories.supersededBy),
          ),
        )
        .returning({ id: memories.id });
      return updated.length > 0;
    },

    /**
     * How many background saves this person has banked today (UTC): daemon
     * extractions, debriefs and episode closes — everything except an
     * explicit `memory_save`. The write budget throttles exactly this set:
     * a person saying "remember this" is always honoured, but the background
     * pass must not pile trivia onto a noisy store.
     */
    async autoSavesToday(userId: string): Promise<number> {
      const rows = await database.execute(
        sql`SELECT COUNT(*)::int AS count FROM memories WHERE user_id = ${userId} AND source <> 'explicit' AND created_at >= date_trunc('day', now())`,
      );
      const first = (rows as unknown as Array<{ count: number }>)[0];
      return first?.count ?? 0;
    },

    /**
     * Sweep what forgetting takes (Phase 4): old, unimportant, never
     * recalled, unpinned, and never in a protected category. Soft-deletes so
     * a sweep is reversible from the trail; hard-delete never happens here.
     * Dry-run reports candidates without touching them.
     */
    async sweepMemories(input: {
      userId?: string;
      olderThanDays?: number;
      maxImportance?: number;
      limit?: number;
      dryRun?: boolean;
    }): Promise<{ candidates: string[]; swept: number }> {
      const { memoryConfig } = await import("./memory-config");
      const olderThanDays = input.olderThanDays ?? memoryConfig.sweepAfterDays;
      const maxImportance = input.maxImportance ?? 3;
      const limit = Math.min(input.limit ?? 100, 500);
      const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
      const conditions = [
        isNull(memories.deletedAt),
        isNull(memories.supersededBy),
        sql`${memories.createdAt} < ${cutoff}`,
        sql`${memories.importance} <= ${maxImportance}`,
        sql`COALESCE(${memories.recallCount}, 0) = 0`,
        eq(memories.pinned, false),
        sql`COALESCE(${memories.category}, '') NOT IN ('safety', 'identity')`,
      ];
      if (input.userId) conditions.push(eq(memories.userId, input.userId));
      const rows = await database
        .select({ id: memories.id })
        .from(memories)
        .where(and(...conditions))
        .limit(limit)
        .catch(() => []);
      const ids = rows.map((row) => row.id);
      if (input.dryRun || ids.length === 0) {
        return { candidates: ids, swept: 0 };
      }
      await database
        .update(memories)
        .set({ deletedAt: new Date() })
        .where(inArray(memories.id, ids))
        .catch(() => undefined);
      return { candidates: ids, swept: ids.length };
    },

    async deleteMemory(id: string, userId: string): Promise<boolean> {
      const updated = await database
        .update(memories)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(memories.id, id),
            eq(memories.userId, userId),
            isNull(memories.deletedAt),
          ),
        )
        .returning({ id: memories.id });
      return updated.length > 0;
    },

    async listMemories(input: {
      userId: string;
      botId?: string;
      scope?: string;
      taskId?: string;
      tags?: string[];
      category?: string;
      minImportance?: number;
      limit?: number;
    }): Promise<
      Array<{
        id: string;
        content: string;
        scope: string;
        importance: number;
        source: string;
      }>
    > {
      const conditions = [
        eq(memories.userId, input.userId),
        isNull(memories.deletedAt),
        isNull(memories.supersededBy),
      ];
      if (input.scope && input.taskId && input.scope === "task")
        conditions.push(
          and(eq(memories.scope, "task"), eq(memories.taskId, input.taskId))!,
        );
      else if (input.scope) conditions.push(eq(memories.scope, input.scope));
      else if (input.taskId)
        conditions.push(
          or(
            eq(memories.taskId, input.taskId),
            and(eq(memories.scope, "global"), isNull(memories.taskId)),
            and(eq(memories.scope, "persona"), isNull(memories.taskId)),
          )!,
        );
      else if (input.botId)
        conditions.push(
          or(eq(memories.botId, input.botId), isNull(memories.botId))!,
        );
      const rows = await database
        .select({
          id: memories.id,
          content: memories.content,
          scope: memories.scope,
          importance: memories.importance,
          tags: memories.tags,
          category: memories.category,
          // Projected so consolidation can arbitrate on where a fact came from. It was left off
          // while the caller hard-coded `null` for it, which meant the authority rule the
          // consolidation prompt spells out had nothing to read.
          source: memories.source,
        })
        .from(memories)
        .where(and(...conditions))
        .orderBy(desc(memories.importance))
        .limit(Math.min(input.limit ?? 10, 50));
      return rows.filter((row) => {
        if (
          input.minImportance !== undefined &&
          row.importance < input.minImportance
        )
          return false;
        if (input.category && row.category !== input.category) return false;
        if (input.tags?.length) {
          const tags = new Set(row.tags ?? []);
          if (!input.tags.every((tag) => tags.has(tag))) return false;
        }
        return true;
      });
    },

    /**
     * Hybrid recall: full-text plus vector, fused by reciprocal rank, with a keyword
     * fallback when neither fires (embedding outage, model switch, thinly-worded query).
     */
    async searchMemories(input: {
      userId: string;
      botId?: string;
      query: string;
      scope?: string;
      taskId?: string;
      tags?: string[];
      category?: string;
      minImportance?: number;
      limit?: number;
    }): Promise<{
      found: boolean;
      memories: Array<{ id: string; content: string; relevance: number }>;
    }> {
      const limit = Math.min(input.limit ?? 10, 25);
      const vector = await embed(input.query);
      const literal = vectorLiteral(vector);
      /*
       * Ask which embedder is live BEFORE embedding, so the floor and the query string come from the same
       * decision. Reading them separately would let a request that started on one and finished on the
       * other pair a real-model vector with a hash threshold, which is the mismatch that silently emptied
       * recall.
       */
      const floor = await similarityFloor();
      const keywords = input.query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2)
        .slice(0, 8);
      // One explicit sandbox predicate — never a nullable gate that opens
      // to everything when the caller passes taskId without scope. A task
      // read sees its own episode plus the user layer, never another task's
      // episode and never another Bot's chat scope.
      const scopeCondition = input.scope
        ? sql`scope = ${input.scope}`
        : input.taskId
          ? sql`(scope = 'task' AND task_id = ${input.taskId}) OR scope IN ('global', 'persona')`
          : input.botId
            ? sql`(scope = 'chat' AND bot_id = ${input.botId}) OR scope IN ('global', 'persona')`
            : sql`scope IN ('global', 'persona')`;
      const rows = (await database.execute(sql`
        WITH fts AS (
          SELECT id, ts_rank(to_tsvector('english', content), websearch_to_tsquery('english', ${input.query})) AS rank
          FROM memories
          WHERE user_id = ${input.userId} AND deleted_at IS NULL
            AND superseded_by IS NULL
            AND (expires_at IS NULL OR expires_at > now())
            AND (${scopeCondition})
            AND to_tsvector('english', content) @@ websearch_to_tsquery('english', ${input.query})
          ORDER BY rank DESC, importance DESC LIMIT 50
        ), vec AS (
          SELECT id, (1 - (embedding <=> ${literal}::vector)) AS sim
          FROM memories
          WHERE user_id = ${input.userId} AND deleted_at IS NULL
            AND superseded_by IS NULL
            AND (expires_at IS NULL OR expires_at > now())
            AND (${scopeCondition})
            AND embedding IS NOT NULL
            AND (1 - (embedding <=> ${literal}::vector)) > ${floor}
          ORDER BY embedding <=> ${literal}::vector LIMIT 50
        )
        SELECT m.id, m.content, m.importance, m.category, m.tags,
          COALESCE(1.0 / (60 + f.rank_row), 0) * 2 + COALESCE(1.0 / (60 + v.rank_row), 0) AS score
        FROM memories m
        LEFT JOIN (SELECT id, row_number() OVER () AS rank_row FROM fts) f ON f.id = m.id
        LEFT JOIN (SELECT id, row_number() OVER () AS rank_row FROM vec) v ON v.id = m.id
        WHERE f.id IS NOT NULL OR v.id IS NOT NULL
        ORDER BY score DESC LIMIT ${limit * 3}
      `)) as unknown as Array<{
        id: string;
        content: string;
        importance: number;
        category: string | null;
        tags: string[];
        score: number;
      }>;
      let ranked = rows;
      if (ranked.length === 0 && keywords.length > 0) {
        // Same sandbox as the main read: the fallback must not surface
        // another task's episode or another Bot's chat rows.
        const fallbackScope = input.scope
          ? eq(memories.scope, input.scope)
          : input.taskId
            ? or(
                and(
                  eq(memories.scope, "task"),
                  eq(memories.taskId, input.taskId),
                ),
                eq(memories.scope, "global"),
                eq(memories.scope, "persona"),
              )!
            : input.botId
              ? or(
                  and(
                    eq(memories.scope, "chat"),
                    eq(memories.botId, input.botId),
                  ),
                  eq(memories.scope, "global"),
                  eq(memories.scope, "persona"),
                )!
              : or(
                  eq(memories.scope, "global"),
                  eq(memories.scope, "persona"),
                )!;
        const fallback = await database
          .select({ id: memories.id, content: memories.content })
          .from(memories)
          .where(
            and(
              eq(memories.userId, input.userId),
              isNull(memories.deletedAt),
              isNull(memories.supersededBy),
              fallbackScope,
              /*
               * ANY KEYWORD, NOT ONLY THE FIRST.
               *
               * The first keyword of a recall-gate query is a poor key on its own. Those queries are
               * written as noun phrases naming a subject — "manager name", "invoice dispute preference" —
               * so their first word is often the most generic thing in them, and a stored sentence about
               * somebody's manager may simply not contain the word "manager". Matching one word out of
               * several meant the fallback could miss a memory that plainly had the answer, which is how a
               * search with a working vector path behind it still returned nothing.
               *
               * OR rather than AND: this is a rescue path for "the ranked search found nothing", so it
               * should err towards returning too much. The ranking that follows still orders what comes
               * back, and the caller's own `limit` bounds it.
               */
              or(
                ...keywords
                  .slice(0, 6)
                  .map((word) => sql`${memories.content} ILIKE ${`%${word}%`}`),
              )!,
            ),
          )
          .limit(limit);
        ranked = fallback.map((row) => ({
          ...row,
          importance: 5,
          category: null,
          tags: [],
          score: 0.01,
        }));
      }
      const out = ranked
        .filter((row) => {
          if (
            input.minImportance !== undefined &&
            row.importance < input.minImportance
          )
            return false;
          if (input.category && row.category !== input.category) return false;
          if (input.tags?.length) {
            const tags = new Set(row.tags ?? []);
            if (!input.tags.every((tag) => tags.has(tag))) return false;
          }
          return true;
        })
        .slice(0, limit)
        .map((row) => ({
          id: row.id,
          content: row.content,
          relevance: Math.round(Number(row.score) * 100) / 100,
        }));
      return { found: out.length > 0, memories: out };
    },

    /**
     * The observability trail: which memory, for whose turn, and what came of
     * it. `saved` on write, `recalled` on every search hit served, `cited`
     * when the model visibly used it, `ignored` when it was served but the
     * answer shows no trace of it. Best-effort and never fatal: a lost event
     * is a gap in statistics, not a broken turn.
     */
    async recordMemoryEvent(input: {
      memoryId: string;
      userId: string;
      botId?: string;
      kind: "saved" | "recalled" | "cited" | "ignored";
      turnId?: string;
    }): Promise<void> {
      await database
        .insert(memoryEvents)
        .values({
          id: randomUUID(),
          memoryId: input.memoryId,
          userId: input.userId,
          botId: input.botId ?? null,
          kind: input.kind,
          turnId: input.turnId ?? null,
        })
        .catch(() => undefined);
      // A cited memory earned reinforcement right away: importance climbs
      // and the recall stamp moves, so used knowledge outlives wallpaper.
      if (input.kind === "cited") {
        await this.reinforceMemory({
          id: input.memoryId,
          userId: input.userId,
        }).catch(() => undefined);
      }
    },

    /**
     * Recall hit-rate per memory: served vs visibly used. The forgetting
     * curve (Phase 4) reinforces on this, and the Memory page reads it.
     */
    async recallStats(input: {
      userId: string;
      memoryIds: string[];
    }): Promise<Record<string, { recalled: number; cited: number }>> {
      if (input.memoryIds.length === 0) return {};
      const rows = await database
        .select({ memoryId: memoryEvents.memoryId, kind: memoryEvents.kind })
        .from(memoryEvents)
        .where(
          and(
            eq(memoryEvents.userId, input.userId),
            inArray(memoryEvents.memoryId, input.memoryIds),
          ),
        )
        .catch(() => []);
      const out: Record<string, { recalled: number; cited: number }> = {};
      for (const row of rows as Array<{ memoryId: string; kind: string }>) {
        const entry = out[row.memoryId] ?? { recalled: 0, cited: 0 };
        out[row.memoryId] = entry;
        if (row.kind === "recalled" || row.kind === "cited")
          entry.recalled += 1;
        if (row.kind === "cited") entry.cited += 1;
      }
      return out;
    },

    /**
     * Link a memory to entities, creating them (Phase 5).
     *
     * Entities are per-user and matched case-insensitively: "Acme" and
     * "acme inc" resolve to one row when either names or aliases it. New
     * aliases merge into the row so recall by any spelling finds the same
     * memories.
     */
    async linkMemoryEntities(input: {
      memoryId: string;
      userId: string;
      entities: Array<{ type?: string; name: string; aliases?: string[] }>;
    }): Promise<number> {
      let linked = 0;
      for (const entity of input.entities.slice(0, 10)) {
        const name = entity.name.trim().slice(0, 200);
        if (name.length < 2) continue;
        const aliases = (entity.aliases ?? [])
          .map((alias) => alias.trim().slice(0, 200))
          .filter((alias) => alias.length > 1)
          .slice(0, 10);
        try {
          const [row] = await database
            .insert(memoryEntities)
            .values({
              id: randomUUID(),
              userId: input.userId,
              type: (entity.type ?? "topic").trim().slice(0, 40) || "topic",
              name,
              aliases,
            })
            .onConflictDoUpdate({
              target: [memoryEntities.userId, memoryEntities.name],
              set: { updatedAt: new Date() },
            })
            .returning({ id: memoryEntities.id })
            .catch(() => []);
          // Case-insensitive match when the exact-name insert raced or the
          // name differs only by case: resolve to the existing row.
          const entityId =
            row?.id ??
            (
              await database
                .select({ id: memoryEntities.id })
                .from(memoryEntities)
                .where(
                  and(
                    eq(memoryEntities.userId, input.userId),
                    sql`lower(${memoryEntities.name}) = lower(${name})`,
                  ),
                )
                .limit(1)
                .catch(() => [])
            )[0]?.id;
          if (!entityId) continue;
          await database
            .insert(memoryEntityLinks)
            .values({ memoryId: input.memoryId, entityId })
            .onConflictDoNothing()
            .catch(() => undefined);
          linked += 1;
        } catch {
          // One unlinkable entity must not stop the rest.
        }
      }
      return linked;
    },

    /**
     * Which of this person's entities a text mentions (Phase 5 recall).
     *
     * Pure name/alias matching in the database — no model call, so the
     * recall gate can afford it on every substantive turn. Returns entity
     * name and id for linked-memory lookup.
     */
    async matchEntities(input: {
      userId: string;
      text: string;
    }): Promise<Array<{ id: string; name: string }>> {
      const lowered = input.text.toLowerCase();
      if (lowered.length < 3) return [];
      const rows = await database
        .select({
          id: memoryEntities.id,
          name: memoryEntities.name,
          aliases: memoryEntities.aliases,
        })
        .from(memoryEntities)
        .where(eq(memoryEntities.userId, input.userId))
        .limit(500)
        .catch(() => []);
      return rows
        .filter((row) => {
          const needles = [row.name, ...(row.aliases ?? [])].map((needle) =>
            needle.toLowerCase(),
          );
          return needles.some(
            (needle) => needle.length > 2 && lowered.includes(needle),
          );
        })
        .slice(0, 5)
        .map((row) => ({ id: row.id, name: row.name }));
    },

    /**
     * Memories linked to one entity, honouring the same sandbox as search
     * (Phase 5): own chat scope or global/persona/task-episode visibility,
     * never another task's episode or another Bot's chat rows.
     */
    async recallByEntity(input: {
      userId: string;
      botId?: string;
      taskId?: string;
      entityId: string;
      limit?: number;
    }): Promise<Array<{ id: string; content: string }>> {
      const limit = Math.min(input.limit ?? 10, 25);
      const scopeCondition = input.taskId
        ? or(
            and(eq(memories.scope, "task"), eq(memories.taskId, input.taskId)),
            eq(memories.scope, "global"),
            eq(memories.scope, "persona"),
          )!
        : input.botId
          ? or(
              and(eq(memories.scope, "chat"), eq(memories.botId, input.botId)),
              eq(memories.scope, "global"),
              eq(memories.scope, "persona"),
            )!
          : or(eq(memories.scope, "global"), eq(memories.scope, "persona"))!;
      const rows = await database
        .select({ id: memories.id, content: memories.content })
        .from(memoryEntityLinks)
        .innerJoin(memories, eq(memories.id, memoryEntityLinks.memoryId))
        .where(
          and(
            eq(memoryEntityLinks.entityId, input.entityId),
            eq(memories.userId, input.userId),
            isNull(memories.deletedAt),
            isNull(memories.supersededBy),
            scopeCondition,
          ),
        )
        .limit(limit)
        .catch(() => []);
      return rows;
    },

    /**
     * Task episodes gone quiet (Phase 2 close): distinct task ids with
     * episode rows but nothing written recently. Closing them compresses to
     * conclusions and expires the trivia, so finished jobs fade instead of
     * lingering in recall.
     */
    async staleTaskIds(input: {
      userId?: string;
      idleDays?: number;
      limit?: number;
    }): Promise<string[]> {
      const idleDays = input.idleDays ?? 14;
      const limit = Math.min(input.limit ?? 50, 200);
      const cutoff = new Date(Date.now() - idleDays * 86_400_000);
      const conditions = [
        eq(memories.scope, "task"),
        isNull(memories.deletedAt),
        isNull(memories.supersededBy),
      ];
      if (input.userId) conditions.push(eq(memories.userId, input.userId));
      const rows = await database
        .select({ taskId: memories.taskId })
        .from(memories)
        .where(and(...conditions))
        .groupBy(memories.userId, memories.taskId)
        .having(sql`max(${memories.updatedAt}) < ${cutoff}`)
        .limit(limit)
        .catch(() => []);
      return rows
        .map((row) => row.taskId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    },

    /**
     * Expire a closed task's episode trivia (Phase 2 close): rows stay
     * readable for a few days, then leave recall on their own. Promoted
     * conclusions are separate global rows and are untouched.
     */
    async expireTaskEpisode(input: {
      userId: string;
      taskId: string;
      inDays?: number;
    }): Promise<number> {
      const inDays = input.inDays ?? 7;
      const updated = await database
        .update(memories)
        .set({
          expiresAt: new Date(Date.now() + inDays * 86_400_000),
        })
        .where(
          and(
            eq(memories.userId, input.userId),
            eq(memories.scope, "task"),
            eq(memories.taskId, input.taskId),
            isNull(memories.deletedAt),
          ),
        )
        .returning({ id: memories.id })
        .catch(() => []);
      return updated.length;
    },

    /**
     * Whether this person's task episodes moved recently (Phase 6): the
     * nightly brief is worth its model call only when something is open or
     * fresh. Cheap existence check, no content read.
     */
    async hasRecentTaskActivity(input: {
      userId: string;
      sinceDays?: number;
    }): Promise<boolean> {
      const since = new Date(Date.now() - (input.sinceDays ?? 2) * 86_400_000);
      const rows = await database
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.userId, input.userId),
            eq(memories.scope, "task"),
            isNull(memories.deletedAt),
            sql`${memories.updatedAt} > ${since}`,
          ),
        )
        .limit(1)
        .catch(() => []);
      return rows.length > 0;
    },

    /** Artifacts: metadata CRUD. Bytes live beside the row (see tools layer). */
    artifacts: {
      async create(input: {
        userId: string;
        botId?: string;
        name: string;
        url: string;
        /**
         * The storage key the bytes were written under, when a driver wrote them.
         *
         * Null means the bytes are where `url` says, which is how every row written before the
         * storage driver existed is read. The two are told apart on read rather than guessed at, so
         * a row cannot be handed a path to a driver that wanted a key.
         */
        storageKey?: string | null;
        mimeType?: string;
        size?: number;
        extractedText?: string | null;
        source?: string;
      }) {
        const [row] = await database
          .insert(artifacts)
          .values({
            id: randomUUID(),
            userId: input.userId,
            botId: input.botId ?? null,
            name: input.name,
            url: input.url,
            storageKey: input.storageKey ?? null,
            mimeType: input.mimeType ?? null,
            size: input.size ?? null,
            extractedText: input.extractedText ?? null,
            source: input.source ?? "agent",
          })
          .returning({ id: artifacts.id });
        return row?.id ?? null;
      },
      async list(userId: string, limit = 10) {
        return (
          database
            .select({
              id: artifacts.id,
              name: artifacts.name,
              mimeType: artifacts.mimeType,
              size: artifacts.size,
            })
            .from(artifacts)
            .where(eq(artifacts.userId, userId))
            .orderBy(desc(artifacts.createdAt))
            /*
             * The caller's limit, bounded rather than replaced.
             *
             * This was a flat 50 under a route that asks for 100, so the Files page quietly stopped
             * at the oldest-fifty cut-off with nothing on screen saying a list had ended: a person with
             * 60 saved reports was shown 50 of them and no indication that 10 existed. The bound is
             * still here — a page has no business asking for a whole table — but it is above what the
             * page asks for, so what it asks for is what it gets.
             */
            .limit(Math.min(limit, 200))
        );
      },
      /**
       * Record where a row's bytes went, once they have been written.
       *
       * A separate call rather than part of `create` because the key is derived from the id, and the
       * id is what `create` returns. Writing the row first and the key second is the order that
       * leaves a visible failure rather than an invisible one — see the note on `remove`.
       *
       * Scoped by user, like every write here, so a caller cannot attach a key to somebody else's
       * artifact by guessing an id.
       */
      async setStorageKey(
        userId: string,
        id: string,
        storageKey: string,
      ): Promise<boolean> {
        const updated = await database
          .update(artifacts)
          .set({ storageKey })
          .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId)))
          .returning({ id: artifacts.id });
        return updated.length > 0;
      },
      async byIdOrName(userId: string, idOrName: string) {
        const rows = await database
          .select()
          .from(artifacts)
          .where(
            and(
              eq(artifacts.userId, userId),
              or(eq(artifacts.id, idOrName), eq(artifacts.name, idOrName))!,
            ),
          )
          .limit(1);
        return rows[0] ?? null;
      },
      async remove(userId: string, id: string): Promise<boolean> {
        const [row] = await database
          .select({
            id: artifacts.id,
            url: artifacts.url,
            storageKey: artifacts.storageKey,
          })
          .from(artifacts)
          .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId)))
          .limit(1);
        if (!row) return false;
        /*
         * THE BYTES GO BEFORE THE ROW, AND A ROW THAT CANNOT BE DELETED IS NOT DELETED.
         *
         * This order is deliberate. Deleting the bytes first means a crash between the two leaves a
         * row pointing at nothing, which is visible and recoverable — the row is a list entry that
         * will not open, and nothing has been silently lost. The other order leaves bytes nothing
         * points at, which is invisible, and a storage driver with no `list` (see `BlobStore`) has
         * no way to find them again. Orphaned bytes are a disk problem somebody can solve with a
         * sweep; orphaned metadata is a file a person cannot find.
         *
         * The `unlink` path is the pre-driver one, kept for rows with no key. It tolerates ENOENT
         * because the row is about to go regardless, and a file somebody deleted by hand should not
         * stop them deleting the row too.
         */
        if (row.storageKey) {
          if (blobs) {
            await blobs.delete(row.storageKey);
          }
        } else if (row.url) {
          await unlink(row.url).catch((error: unknown) => {
            if ((error as { code?: string }).code !== "ENOENT") throw error;
          });
        }
        const deleted = await database
          .delete(artifacts)
          .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId)))
          .returning({ id: artifacts.id });
        return deleted.length > 0;
      },
    },

    /** Todos: triage list, status moves, dismissals with sender verdicts. */
    todos: {
      async add(input: {
        userId: string;
        title: string;
        rawSnippet?: string;
        sourceApp?: string;
        sourceAccount?: string;
        senderKey?: string;
        sourceRef: string;
        importance?: "HIGH" | "MEDIUM" | "LOW";
        createdVia?: string;
        tags?: string[];
      }) {
        const [row] = await database
          .insert(tasks)
          .values({
            id: randomUUID(),
            userId: input.userId,
            title: input.title,
            rawSnippet: input.rawSnippet ?? null,
            sourceApp: input.sourceApp ?? null,
            sourceAccount: input.sourceAccount ?? null,
            senderKey: input.senderKey ?? null,
            sourceRef: input.sourceRef,
            importance: input.importance ?? "MEDIUM",
            urgencyScore: input.importance === "HIGH" ? 3 : 1,
            createdVia: input.createdVia ?? "MANUAL",
            tags: input.tags ?? [],
          })
          .onConflictDoUpdate({
            target: [tasks.userId, tasks.sourceRef],
            set: {
              title: input.title,
              rawSnippet: input.rawSnippet ?? null,
              lastSeenAt: new Date(),
            },
          })
          .returning({ id: tasks.id });
        return row?.id ?? null;
      },
      async list(input: {
        userId: string;
        status?: string[];
        sourceApp?: string;
        limit?: number;
      }) {
        const conditions = [eq(tasks.userId, input.userId)];
        if (input.sourceApp)
          conditions.push(eq(tasks.sourceApp, input.sourceApp));
        const rows = await database
          .select()
          .from(tasks)
          .where(and(...conditions))
          .orderBy(desc(tasks.urgencyScore))
          .limit(Math.min(input.limit ?? 50, 50));
        const want = new Set(
          input.status ?? ["OPEN", "IN_PROGRESS", "NEEDS_REVIEW"],
        );
        return rows.filter((row) => want.has(row.status));
      },
      async update(
        userId: string,
        taskId: string,
        patch: {
          status?:
            | "OPEN"
            | "IN_PROGRESS"
            | "NEEDS_REVIEW"
            | "DONE"
            | "DISMISSED";
          importance?: "HIGH" | "MEDIUM" | "LOW";
          resultSummary?: string;
        },
      ): Promise<boolean> {
        const set: Record<string, unknown> = {};
        if (patch.status) {
          set.status = patch.status;
          if (patch.status === "DONE") set.completedAt = new Date();
        }
        if (patch.importance) {
          set.importance = patch.importance;
          set.urgencyScore = patch.importance === "HIGH" ? 3 : 1;
        }
        if (patch.resultSummary !== undefined)
          set.resultSummary = patch.resultSummary;
        if (Object.keys(set).length === 0) return false;
        const updated = await database
          .update(tasks)
          .set(set)
          .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
          .returning({ id: tasks.id });
        if (updated.length === 0) return false;
        if (patch.status === "DISMISSED") {
          const [row] = await database
            .select({ senderKey: tasks.senderKey, sourceApp: tasks.sourceApp })
            .from(tasks)
            .where(eq(tasks.id, taskId))
            .limit(1);
          if (row?.senderKey && row.sourceApp) {
            await database
              .insert(senderVerdicts)
              .values({
                id: randomUUID(),
                userId,
                sourceApp: row.sourceApp,
                senderKey: row.senderKey,
                verdict: "LOW",
              })
              .onConflictDoUpdate({
                target: [
                  senderVerdicts.userId,
                  senderVerdicts.sourceApp,
                  senderVerdicts.senderKey,
                ],
                set: { verdict: "LOW" },
              });
          }
        }
        return true;
      },
      async remove(userId: string, taskId: string): Promise<boolean> {
        const deleted = await database
          .delete(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
          .returning({ id: tasks.id });
        return deleted.length > 0;
      },
    },

    /** Cron jobs: claim-dispatch-release is owned by the worker ticker. */
    cron: {
      async create(input: {
        userId: string;
        botId?: string;
        name: string;
        expression: string;
        timezone?: string;
        triggerConfig?: unknown;
        nextRunAt: Date;
      }) {
        const [row] = await database
          .insert(cronJobs)
          .values({
            id: randomUUID(),
            userId: input.userId,
            botId: input.botId ?? null,
            name: input.name,
            expression: input.expression,
            timezone: input.timezone ?? "UTC",
            nextRunAt: input.nextRunAt,
            triggerConfig: (input.triggerConfig ?? null) as never,
          })
          .returning({ id: cronJobs.id });
        return row?.id ?? null;
      },
      async list(userId: string) {
        return database
          .select()
          .from(cronJobs)
          .where(eq(cronJobs.userId, userId))
          .orderBy(desc(cronJobs.createdAt));
      },
      async update(
        userId: string,
        jobId: string,
        patch: {
          name?: string;
          expression?: string;
          timezone?: string;
          enabled?: boolean;
          nextRunAt?: Date;
        },
      ): Promise<boolean> {
        const set: Record<string, unknown> = {};
        if (patch.name !== undefined) set.name = patch.name;
        if (patch.expression !== undefined) set.expression = patch.expression;
        if (patch.timezone !== undefined) set.timezone = patch.timezone;
        if (patch.enabled !== undefined) set.enabled = patch.enabled;
        if (patch.nextRunAt !== undefined) set.nextRunAt = patch.nextRunAt;
        if (Object.keys(set).length === 0) return false;
        const updated = await database
          .update(cronJobs)
          .set(set)
          .where(and(eq(cronJobs.id, jobId), eq(cronJobs.userId, userId)))
          .returning({ id: cronJobs.id });
        return updated.length > 0;
      },
      async remove(userId: string, jobId: string): Promise<boolean> {
        const deleted = await database
          .delete(cronJobs)
          .where(and(eq(cronJobs.id, jobId), eq(cronJobs.userId, userId)))
          .returning({ id: cronJobs.id });
        return deleted.length > 0;
      },
    },

    /** Event automations: fired by Composio trigger webhooks, managed by the automations tool. */
    automations: {
      async create(input: {
        userId: string;
        botId?: string;
        name: string;
        apps?: string[];
        prompt: string;
      }): Promise<string | null> {
        const [row] = await database
          .insert(automations)
          .values({
            id: randomUUID(),
            userId: input.userId,
            botId: input.botId ?? null,
            name: input.name,
            apps: (input.apps ?? []).map((app) => app.toLowerCase()),
            prompt: input.prompt,
          })
          .returning({ id: automations.id });
        return row?.id ?? null;
      },
      async list(userId: string) {
        return database
          .select()
          .from(automations)
          .where(eq(automations.userId, userId))
          .orderBy(desc(automations.createdAt));
      },
      async update(
        userId: string,
        id: string,
        patch: {
          name?: string;
          apps?: string[];
          prompt?: string;
          enabled?: boolean;
        },
      ): Promise<boolean> {
        const set: Record<string, unknown> = {};
        if (patch.name !== undefined) set.name = patch.name;
        if (patch.apps !== undefined) {
          set.apps = patch.apps.map((app) => app.toLowerCase());
        }
        if (patch.prompt !== undefined) set.prompt = patch.prompt;
        if (patch.enabled !== undefined) set.enabled = patch.enabled;
        if (Object.keys(set).length === 0) return false;
        const updated = await database
          .update(automations)
          .set(set)
          .where(and(eq(automations.id, id), eq(automations.userId, userId)))
          .returning({ id: automations.id });
        return updated.length > 0;
      },
      async remove(userId: string, id: string): Promise<boolean> {
        const deleted = await database
          .delete(automations)
          .where(and(eq(automations.id, id), eq(automations.userId, userId)))
          .returning({ id: automations.id });
        return deleted.length > 0;
      },
    },
  };
}

export type RemiStore = ReturnType<typeof createRemiStore>;
