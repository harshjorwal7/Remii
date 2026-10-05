import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./core";

/**
 * Remi's brain, stored in Remii's database.
 *
 * Ported from remi.in (Prisma models Memory/Artifact/Task/SenderVerdict/CronJob + Better Auth
 * username columns). Keyed on Remii user ids rather than Remi instance ids: one Remi instance
 * was one person, and one Remii user is one person, so `instanceId` becomes `userId` and
 * per-chat scoping becomes per-Bot (`botId`), matching how Remii addresses coworkers.
 */

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * One person's Remi instance: how their engine is tuned.
 *
 * remi.in carries one ComposioClawInstance per user (model choice, telegram chat, plan);
 * Remii carries the same facts on the user row here, because one Remi instance was one
 * person and one Remii user is one person. Absence means deployment defaults everywhere:
 * the model is the deployment's, and Telegram notifies the linked chat if there is one.
 */
export const remiInstances = pgTable("remi_instances", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Model slug this person's turns answer on, e.g. "deepseek-chat". Null inherits. */
  modelSlug: text("model_slug"),
  /** Provider the slug belongs to: openai-compatible or anthropic-compatible. */
  modelProvider: text("model_provider"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A 1024-dimensional embedding for vector similarity (`<=>` cosine distance).
 *
 * Drizzle has no pgvector column type, so this is a custom type over the `vector(1024)`
 * SQL type (see the `bytea` pattern in core.ts). Values travel as `[x1,x2,...]` strings;
 * all similarity SQL is handwritten (see server/src/remi/memory.ts), the way Remi did it
 * with Prisma `$queryRaw`. Requires the `vector` extension (created in migration 0048).
 */
export const vector1024 = customType<{ data: string; driverData: string }>({
  dataType: () => "vector(1024)",
});

/** Durable facts the Bot remembers across conversations. */
export const memories = pgTable(
  "memories",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null means global (visible in every conversation); set means one Bot's. */
    botId: text("bot_id"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: vector1024("embedding"),
    scope: text("scope").notNull().default("chat"),
    tags: text("tags").array().notNull().default([]),
    category: text("category"),
    importance: integer("importance").notNull().default(5),
    source: text("source").notNull().default("explicit"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    messageId: text("message_id"),
    /**
     * The task episode this memory belongs to (thread/task id). Null means it
     * is not task-bound: user-layer (global/persona) or agent-layer (chat)
     * rows. Phase 2 (multi-agent brief/debrief) reads and writes these; until
     * then the column rides along unused.
     */
    taskId: text("task_id"),
    /**
     * Supersession link for contradiction resolution (Phase 3). Set when a
     * newer memory replaces this one: the row is kept for audit but excluded
     * from every recall path. Null means current.
     */
    supersededBy: text("superseded_by"),
    /** Until when this fact is (was) true. Null means no known end. */
    validUntil: timestamp("valid_until", { withTimezone: true }),
    /**
     * Dynamic importance signals (Phase 4 forgetting curve). Reinforced when
     * a recall is visibly used in an answer, decayed with time and disuse.
     * `pinned` rows (safety facts, user-pinned) are never swept.
     */
    recallCount: integer("recall_count").notNull().default(0),
    lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true }),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("memories_user_bot_hash_idx").on(
      table.userId,
      table.botId,
      table.contentHash,
    ),
    index("memories_user_idx").on(table.userId),
    index("memories_user_task_idx").on(table.userId, table.taskId),
    /*
     * The nearest-neighbour index, on `embedding` alone and with no way to scope it by person.
     *
     * HNSW cannot be partitioned by a column. `CREATE INDEX ... USING hnsw (user_id, embedding
     * vector_cosine_ops)` is refused outright by pgvector — `access method "hnsw" does not support
     * multicolumn indexes` — and the same is true of ivfflat. So the tempting one-line fix for "every
     * read here filters `user_id`" does not exist, and the honest options are a partial index per
     * person (which cannot be generated ahead of the people arriving) or a partitioned table.
     *
     * Which leaves one index across every person's rows, ordered within it by cosine distance, and
     * a `user_id` filter applied afterwards. That is the shape pgvector documents as lossy, and the
     * loss was measured rather than quoted: at 20,000 rows across 5 users the planner chose this
     * index and threw away 205 rows to apply `user_id`; at 50,000 rows across 50 users it abandoned
     * the index entirely and sorted a sequential scan instead. Past roughly that many people per
     * table this stops being a fallback and becomes dead weight, and the answer is partitioning
     * `memories` on `user_id` with a per-partition index — a migration nobody can write until the
     * data shape that needs it exists.
     *
     * `SET hnsw.iterative_scan = strict_order` (pgvector 0.8.0+) is the other lever: it re-enters the
     * graph until the LIMIT is filled. Deliberately not applied to the connection — it is a session
     * setting, the pool shares sessions, and setting it there rather than on the one query that wants
     * it would change results for every other HNSW scan in the process.
     *
     * At the eight rows this table holds today the planner ignores the index and scans exactly, which
     * is correct and nothing here changes it.
     *
     * Only `searchMemories`'s vector arm can use it, and not `saveMemory`'s duplicate check: an
     * approximate index serves an `ORDER BY <distance>`, and that duplicate check filters on
     * similarity and takes `LIMIT 1` with no distance ORDER BY at all. The scan on the memory-save
     * write path is therefore NOT fixed by this index and needs a different answer.
     *
     * `vector_cosine_ops` because `<=>` is cosine distance everywhere it is written. The default op
     * class is `vector_l2_ops`, which an `<=>` ORDER BY cannot use at all — the index would sit
     * there unused and the planner would say so, which is the honest failure.
     *
     * `.using("hnsw")` so drizzle-kit emits `USING hnsw` rather than guessing btree from the name.
     * The build parameters are pgvector's defaults (`m = 16`, `ef_construction = 64`), chosen here
     * rather than tuned: a deployment that has grown enough to care should set `hnsw.ef_search` per
     * workload instead of assuming these are right for its row counts.
     */
    index("memories_embedding_hnsw_idx").using(
      "hnsw",
      sql`${table.embedding} vector_cosine_ops`,
    ),
  ],
);

/**
 * The memory observability trail (Phase 0).
 *
 * Every save and every recall hit lands here: which memory, for whose turn,
 * and whether the model visibly used it (`cited`) or ignored it. This is the
 * signal the forgetting curve (Phase 4) reinforces on and the dashboard
 * reads recall hit-rate from. High-volume by design; retention-swept like
 * audit rows, never joined into recall itself.
 */
export const memoryEvents = pgTable(
  "memory_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    memoryId: text("memory_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id"),
    kind: text("kind").notNull(),
    turnId: text("turn_id"),
    createdAt: createdAt(),
  },
  (table) => [
    index("memory_events_memory_idx").on(table.memoryId, table.createdAt),
    index("memory_events_user_created_idx").on(table.userId, table.createdAt),
  ],
);

/**
 * Who and what memories are about (Phase 5).
 *
 * Entities turn vector soup into addressable recall: "everything about
 * Project Y" instead of similarity roulette. Per-user like everything else;
 * names match case-insensitively, aliases catch "Acme" vs "Acme Inc".
 */
export const memoryEntities = pgTable(
  "memory_entities",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("topic"),
    name: text("name").notNull(),
    aliases: text("aliases").array().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("memory_entities_user_name_idx").on(table.userId, table.name),
    index("memory_entities_user_idx").on(table.userId),
  ],
);

export const memoryEntityLinks = pgTable(
  "memory_entity_links",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => memoryEntities.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.memoryId, table.entityId] }),
    index("memory_entity_links_entity_idx").on(table.entityId),
  ],
);

/** Files the Bot or the person saved: uploads, generated documents, fetched sources. */
export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id"),
    name: text("name").notNull(),
    /**
     * Where the bytes are, as an opaque storage key. `BlobStore` decides what a key means.
     *
     * SEPARATE FROM `url` BELOW, AND BECAUSE `url` IS NOT A KEY. `url` was a filesystem path and is
     * kept only so the rows written before this column existed can still be found and read; a key
     * written by a local driver and a key written by an S3 driver are the same shape, and a path is
     * not, so a deployment that moves its files to a bucket has to be able to tell which kind of
     * string it is holding before it hands it to a driver. That is what the null check is for.
     */
    storageKey: text("storage_key"),
    /** Where the bytes live: local workspace path or storage URL. */
    url: text("url").notNull(),
    mimeType: text("mime_type"),
    size: integer("size"),
    /** Parsed text cache, so reads do not re-parse the file every time. */
    extractedText: text("extracted_text"),
    source: text("source").notNull().default("agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("artifacts_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const taskStatus = pgEnum("remi_task_status", [
  "OPEN",
  "IN_PROGRESS",
  "NEEDS_REVIEW",
  "DONE",
  "DISMISSED",
]);

export const taskImportance = pgEnum("remi_task_importance", [
  "HIGH",
  "MEDIUM",
  "LOW",
]);

/** Things to do, triaged and tracked. */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    rawSnippet: text("raw_snippet"),
    sourceApp: text("source_app"),
    sourceAccount: text("source_account"),
    senderKey: text("sender_key"),
    sourceRef: text("source_ref"),
    status: taskStatus("status").notNull().default("OPEN"),
    importance: taskImportance("importance").notNull().default("MEDIUM"),
    urgencyScore: integer("urgency_score").notNull().default(1),
    createdVia: text("created_via"),
    tags: text("tags").array().notNull().default([]),
    resultSummary: text("result_summary"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("tasks_user_source_ref_idx").on(table.userId, table.sourceRef),
    index("tasks_user_status_idx").on(table.userId, table.status),
  ],
);

/** Standing verdicts about senders (e.g. always low-priority), learned from dismissals. */
export const senderVerdicts = pgTable(
  "sender_verdicts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceApp: text("source_app").notNull(),
    senderKey: text("sender_key").notNull(),
    verdict: text("verdict").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("sender_verdicts_user_app_sender_idx").on(
      table.userId,
      table.sourceApp,
      table.senderKey,
    ),
  ],
);

/**
 * Event automations: when something happens in a connected app, do this.
 *
 * A Composio trigger webhook resolves to a person and an app; an enabled automation whose
 * `apps` name that app (or names none, meaning every app) fires its prompt as a turn run as
 * the owner, before the todo pipeline is even considered. Created and managed through the
 * `automations` tool and the Remii conversation — never hand-edited — because the prompt is
 * what runs unattended and deserves the same audit surface as everything else that does.
 */
export const automations = pgTable(
  "automations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id"),
    name: text("name").notNull(),
    /** App slugs this fires for, lower case; empty means every app. */
    apps: jsonb("apps").$type<string[]>().notNull().default([]),
    /** What the Bot should do with the event, run as the owner. */
    prompt: text("prompt").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("automations_user_idx").on(table.userId)],
);

/** Scheduled jobs: a cron expression, a prompt, and lease columns for exactly-once dispatch. */
export const cronJobs = pgTable(
  "cron_jobs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id"),
    name: text("name").notNull(),
    expression: text("expression").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    /** Consecutive failed firings; ten in a row switches the job off. */
    failures: integer("failures").notNull().default(0),
    triggerConfig: jsonb("trigger_config"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("cron_jobs_next_run_idx").on(table.nextRunAt)],
);

/**
 * One person's Telegram link: which chat is them, plus the single-use linking token.
 *
 * The link flow: the app mints `linkToken`, shows `t.me/<bot>?start=<token>`; `/start <token>`
 * arriving from Telegram binds `chatId` to the person who minted it. Afterwards every message
 * from that chat id runs as that person.
 */
export const telegramLinks = pgTable(
  "telegram_links",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chatId: text("chat_id").unique(),
    linkToken: text("link_token").unique(),
    linkTokenExpiresAt: timestamp("link_token_expires_at", {
      withTimezone: true,
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("telegram_links_user_idx").on(table.userId)],
);
