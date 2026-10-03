import { desc, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { creditLedger, subscriptions, usageRecords, users } from "../db/schema";
import { createComputerMeter } from "./computer-meter";
import {
  createCheckoutSession,
  createCustomerPortalSession,
} from "./dodo-client";
import { readMeters } from "./meters";

const TIER_CREDITS: Record<
  "free" | "starter" | "pro" | "power" | "byok",
  number
> = {
  free: 50,
  starter: 500,
  pro: 600,
  power: 2500,
  byok: 0,
};

export function createBillingRoutes(
  database: Database,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/subscription", requireUser, async (context) => {
    const actor = context.var.actor;

    const [userRow] = await database
      .select({
        creditBalance: users.creditBalance,
        stripeCustomerId: users.stripeCustomerId,
        dodoCustomerId: users.dodoCustomerId,
        isBanned: users.isBanned,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, actor.id))
      .limit(1);

    const [subRow] = await database
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, actor.id))
      .limit(1);

    if (subRow) {
      /*
       * No trial, no credit balance, no window bars here any more.
       *
       * All three described a free period that does not exist, or a currency the person cannot see the
       * conversion for. What is left in this response is the subscription itself; what they have bought
       * with it is `GET /meters`, which is where the two readings live.
       */
      return context.json({
        subscription: subRow,
      });
    }

    /*
     * Persist the free row on first read rather than synthesizing it.
     * Webhooks look subscriptions up by user, and a row that only exists in
     * a GET response is a subscription the webhook cannot find — so the
     * first renewal after signup would warn "not found" instead of crediting.
     */
    const [inserted] = await database
      .insert(subscriptions)
      .values({
        id: `sub_free_${actor.id}`,
        userId: actor.id,
        stripeCustomerId: userRow?.stripeCustomerId ?? undefined,
        dodoCustomerId: userRow?.dodoCustomerId ?? undefined,
        tier: "free",
        status: "active",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        monthlyCreditsIncluded: TIER_CREDITS.free,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    const subscription =
      inserted ??
      (
        await database
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.userId, actor.id))
          .limit(1)
      )[0];

    // Same shape as the subscribed branch above, and for the same reason: the subscription and
    // nothing else. `GET /meters` is where what they have bought is read.
    return context.json({ subscription });
  });

  routes.post("/checkout", requireUser, async (context) => {
    const actor = context.var.actor;
    const body = (await context.req.json().catch(() => ({}))) as {
      tier?: string;
      credits?: number;
      returnUrl?: string;
    };

    const tier = (body.tier || "pro") as
      | "free"
      | "starter"
      | "pro"
      | "power"
      | "byok";
    if (!["free", "starter", "pro", "power", "byok"].includes(tier)) {
      return context.json({ error: "Invalid subscription tier." }, 400);
    }
    const credits =
      body.credits === undefined ? undefined : Number(body.credits);
    if (
      credits !== undefined &&
      (!Number.isSafeInteger(credits) || credits <= 0)
    ) {
      return context.json(
        { error: "Top-up credits must be a positive integer." },
        400,
      );
    }

    const [userRow] = await database
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        dodoCustomerId: users.dodoCustomerId,
      })
      .from(users)
      .where(eq(users.id, actor.id))
      .limit(1);

    let session: { sessionId: string; checkoutUrl: string };
    try {
      session = await createCheckoutSession({
        user: {
          id: actor.id,
          email: userRow?.email,
          name: userRow?.name,
          dodoCustomerId: userRow?.dodoCustomerId,
        },
        tier,
        ...(credits !== undefined ? { credits } : {}),
        returnUrl: body.returnUrl,
      });
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error ? error.message : "Checkout is unavailable.",
        },
        503,
      );
    }

    return context.json(session);
  });

  routes.post("/portal", requireUser, async (context) => {
    const actor = context.var.actor;
    const body = (await context.req.json().catch(() => ({}))) as {
      returnUrl?: string;
    };

    const [userRow] = await database
      .select({
        dodoCustomerId: users.dodoCustomerId,
        stripeCustomerId: users.stripeCustomerId,
      })
      .from(users)
      .where(eq(users.id, actor.id))
      .limit(1);

    const [subRow] = await database
      .select({
        dodoCustomerId: subscriptions.dodoCustomerId,
        stripeCustomerId: subscriptions.stripeCustomerId,
      })
      .from(subscriptions)
      .where(eq(subscriptions.userId, actor.id))
      .limit(1);

    const customerId =
      subRow?.dodoCustomerId ||
      userRow?.dodoCustomerId ||
      subRow?.stripeCustomerId ||
      userRow?.stripeCustomerId ||
      `cus_remii_${actor.id}`;

    let portal: { portalUrl: string };
    try {
      portal = await createCustomerPortalSession({
        customerId,
        returnUrl: body.returnUrl,
      });
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Customer portal is unavailable.",
        },
        503,
      );
    }

    return context.json(portal);
  });

  routes.get("/credits/ledger", requireUser, async (context) => {
    const actor = context.var.actor;

    const [userRow] = await database
      .select({ creditBalance: users.creditBalance })
      .from(users)
      .where(eq(users.id, actor.id))
      .limit(1);

    const rows = await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, actor.id))
      .orderBy(desc(creditLedger.createdAt))
      .limit(50);

    return context.json({
      creditBalance: userRow?.creditBalance ?? 50,
      ledger: rows,
    });
  });

  routes.get("/usage", requireUser, async (context) => {
    const actor = context.var.actor;

    const rows = await database
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.userId, actor.id))
      .orderBy(desc(usageRecords.createdAt))
      .limit(50);

    return context.json({
      usage: rows,
    });
  });

  /*
   * THE TWO METERS, which is what this deployment actually sells.
   *
   * Credits are gone from what a person sees, and so is the trial: there is no free period and there is
   * no balance to read. What there is instead is a percentage of what was bought, per period, with the
   * instant it resets — for the model and for the computer separately, because running out of one and
   * running out of the other are different problems with different remedies.
   */
  routes.get("/meters", requireUser, async (context) => {
    const actor = context.var.actor;

    const [subscription] = await database
      .select({ tier: subscriptions.tier })
      .from(subscriptions)
      .where(eq(subscriptions.userId, actor.id))
      .limit(1);

    const meters = await readMeters(
      database,
      createComputerMeter(database),
      actor.id,
      subscription?.tier,
    ).catch(() => null);

    if (!meters) {
      return context.json(
        { error: "Your usage could not be read just now." },
        503,
      );
    }
    return context.json(meters);
  });

  return routes;
}
