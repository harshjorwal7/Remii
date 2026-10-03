import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Durable conversation threads, owned by this deployment.
 *
 * Replaces the Intelligence platform's thread store: every conversation a
 * person, routine or hop runs in is a row here, with its messages beside it.
 * Thread ids are minted locally (see threadIdentity) and are unguessable
 * UUIDs; per-person access is enforced by channel membership and the agent
 * roster, not by this table, exactly as it was with platform threads.
 */
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    agentId: text("agent_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("threads_by_user_idx").on(table.userId, table.updatedAt)],
);

/**
 * One message in a thread, stored as the AG-UI message itself.
 *
 * The platform stored its own row shape and every reader converted; here the
 * canonical form is AG-UI, and readers that need the old row shape convert
 * on the way out (see toHistoryRow in threads/local). `messageId` is the
 * AG-UI message id, unique per thread, which is what makes appending
 * idempotent across retries and restarts.
 */
export const threadMessages = pgTable(
  "thread_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    role: text("role").notNull(),
    content: jsonb("content").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("thread_messages_by_thread_idx").on(table.threadId)],
);

/**
 * One run at a time per conversation, enforced locally.
 *
 * Replaces the platform's thread lock: acquiring inserts, renewing bumps the
 * expiry, releasing deletes. An expired row is stealable, so a crashed
 * process stops holding its threads after the TTL rather than forever.
 * Routines, handoffs and the runner all go through this one table, which is
 * what keeps two turns off one thread across replicas.
 */
export const threadLocks = pgTable("thread_locks", {
  threadId: text("thread_id").primaryKey(),
  runId: text("run_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
