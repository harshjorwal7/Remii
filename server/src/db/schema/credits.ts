import {
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(), // e.g. -2 for a turn, +500 for monthly renew
    balanceAfter: integer("balance_after").notNull(),
    reason: text("reason").notNull(), // "monthly_allowance", "turn_charge", "top_up"
    channelId: text("channel_id"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  /*
   * A unique INDEX, not `.unique()` on the column.
   *
   * Migration 0060 created `CREATE UNIQUE INDEX credit_ledger_idempotency_key_unique`, and that is
   * what every database holding this column already has. Declaring the uniqueness as a column
   * constraint instead describes a different schema, so the next `generate` diffs against a shape
   * no database is in and emits an `ADD CONSTRAINT ... UNIQUE` for a uniqueness that is already
   * there. The journal test reads `indexes` and never `uniqueConstraints`, so the two spellings are
   * not interchangeable to it either. `uniqueIndex(...).on(...)` is what emits the statement 0060
   * wrote, which is what `src/db/schema/plugins.ts` already does for `skills_slug_key`.
   */
  (table) => [
    uniqueIndex("credit_ledger_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
  ],
);
