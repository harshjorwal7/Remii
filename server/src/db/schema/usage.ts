import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./core";

export const usageRecords = pgTable("usage_records", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull(),
  agentId: text("agent_id").notNull(),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  browserDurationSeconds: integer("browser_duration_seconds")
    .notNull()
    .default(0),
  creditsDeducted: integer("credits_deducted").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
