import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./core";

export const subscriptionTier = pgEnum("subscription_tier", [
  "free",
  "starter",
  "pro",
  "power",
  "byok",
]);

export const subscriptionStatus = pgEnum("subscription_status", [
  "active",
  "trialing",
  "past_due",
  "canceled",
  "unpaid",
]);

export const subscriptions = pgTable("subscriptions", {
  id: text("id").primaryKey(), // sub_xxx
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id"),
  dodoCustomerId: text("dodo_customer_id"),
  dodoSubscriptionId: text("dodo_subscription_id"),
  tier: subscriptionTier("tier").notNull().default("free"),
  status: subscriptionStatus("status").notNull().default("active"),
  currentPeriodStart: timestamp("current_period_start", {
    withTimezone: true,
  }).notNull(),
  currentPeriodEnd: timestamp("current_period_end", {
    withTimezone: true,
  }).notNull(),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  monthlyCreditsIncluded: integer("monthly_credits_included")
    .notNull()
    .default(100),
  /** $7 BYOK add-on: the subscriber pays model spend directly; the plan covers computers. */
  byokAddon: boolean("byok_addon").notNull().default(false),
  gracePeriodEndsAt: timestamp("grace_period_ends_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
