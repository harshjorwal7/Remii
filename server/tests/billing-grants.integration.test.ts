import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { grantCredits } from "../src/billing/metering";
import { createDatabase } from "../src/db/client";
import { creditLedger, users } from "../src/db/schema";
import { TEST_POOL, testDatabase, testDatabaseUrl } from "./support/database";

const database = testDatabase();
const userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});

describe("credit grants", () => {
  test("an idempotency key prevents a retried grant from minting twice", async () => {
    const userId = `grant-${crypto.randomUUID()}`;
    userIds.push(userId);
    await database.insert(users).values({
      id: userId,
      email: `${userId}@remii.test`,
    });

    const first = await grantCredits(database, {
      userId,
      credits: 25,
      reason: "top_up",
      idempotencyKey: `payment:${userId}`,
    });
    const second = await grantCredits(database, {
      userId,
      credits: 25,
      reason: "top_up",
      idempotencyKey: `payment:${userId}`,
    });

    const [user] = await database
      .select({ balance: users.creditBalance })
      .from(users)
      .where(eq(users.id, userId));
    const ledger = await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, userId));

    expect(user?.balance).toBe(75);
    expect(ledger).toHaveLength(1);
    expect(second.ledgerId).toBe(first.ledgerId);
    expect(second.balanceAfter).toBe(first.balanceAfter);
  });
});
