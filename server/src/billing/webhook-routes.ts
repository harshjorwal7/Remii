import { eq, or } from "drizzle-orm";
import { Hono } from "hono";
import type { Database } from "../db/client";
import { subscriptions, users } from "../db/schema";
import {
  type DodoWebhookPayload,
  type SubscriptionTier,
  verifyAndUnwrapWebhook,
} from "./dodo-client";
import { grantCredits } from "./metering";

const TIER_CREDITS: Record<SubscriptionTier, number> = {
  free: 50,
  starter: 500,
  pro: 600,
  power: 2500,
  byok: 0,
};

export function createDodoWebhookRoutes(database: Database) {
  const routes = new Hono();

  routes.post("/dodo", async (context) => {
    const rawBody = await context.req.text();
    const headers: Record<string, string | undefined> = {
      "webhook-id": context.req.header("webhook-id"),
      "webhook-signature": context.req.header("webhook-signature"),
      "webhook-timestamp": context.req.header("webhook-timestamp"),
    };

    let payload: DodoWebhookPayload;
    try {
      /*
       * An UNCONFIGURED webhook is refused in production, and this is the same reasoning the
       * worker boundary uses: a deployment with no signing secret must not answer a guess any
       * differently from one that has a secret and was given the wrong signature.
       *
       * The header check alone was not enough. `verifyAndUnwrapWebhook` only unwraps when the
       * client AND `DODO_PAYMENTS_WEBHOOK_SECRET` AND a signature are all present, and otherwise
       * falls through to `JSON.parse(rawBody)`. So a production deployment that had never been given
       * its secret refused a request with no signature header and accepted the very next one that
       * carried any header at all — with the body taken on trust, and the handler then writing
       * whatever tier and credit balance `metadata.userId` in that body asked for. The secret being
       * absent was the condition under which the boundary was widest.
       *
       * The response is byte-identical across all three causes — unconfigured, absent signature,
       * bad signature — so this boundary leaks nothing about which one it was.
       */
      if (process.env.NODE_ENV === "production") {
        if (!process.env.DODO_PAYMENTS_WEBHOOK_SECRET) {
          console.error(
            "[Dodo Webhook] Refused: DODO_PAYMENTS_WEBHOOK_SECRET is not set. Webhooks are unauthenticated without it.",
          );
          return context.json({ error: "Invalid webhook signature" }, 400);
        }
        if (!headers["webhook-signature"]) {
          return context.json({ error: "Invalid webhook signature" }, 400);
        }
      }
      payload = verifyAndUnwrapWebhook(rawBody, headers);
    } catch (err) {
      console.error("[Dodo Webhook] Signature verification failed:", err);
      return context.json({ error: "Invalid webhook signature" }, 400);
    }

    const eventType = payload.type;
    const data = payload.data;
    console.log(`[Dodo Webhook] Processing event: ${eventType}`, {
      subscriptionId: data.subscription_id,
      paymentId: data.payment_id,
    });

    try {
      switch (eventType) {
        case "subscription.active": {
          const subId = data.subscription_id || `sub_dodo_${Date.now()}`;
          const customerId = data.customer?.customer_id;
          const metadataUserId =
            (data.metadata?.userId as string) ||
            (data.metadata?.user_id as string);
          const rawTier = (data.metadata?.tier as string) || "pro";
          const tier: SubscriptionTier = [
            "free",
            "starter",
            "pro",
            "power",
            "byok",
          ].includes(rawTier)
            ? (rawTier as SubscriptionTier)
            : "pro";

          // Resolve target user:
          // 1. By metadata userId
          // 2. By existing dodoCustomerId
          // 3. By customer email
          let targetUserId = metadataUserId;
          if (!targetUserId && customerId) {
            const [userByCustomer] = await database
              .select({ id: users.id })
              .from(users)
              .where(eq(users.dodoCustomerId, customerId))
              .limit(1);
            if (userByCustomer) targetUserId = userByCustomer.id;
          }

          if (!targetUserId && data.customer?.email) {
            const [userByEmail] = await database
              .select({ id: users.id })
              .from(users)
              .where(eq(users.email, data.customer.email))
              .limit(1);
            if (userByEmail) targetUserId = userByEmail.id;
          }

          if (!targetUserId) {
            console.warn(
              "[Dodo Webhook] Could not associate subscription with a user",
              data,
            );
            return context.json({ received: true, warning: "User not found" });
          }

          const creditsIncluded = TIER_CREDITS[tier];
          const periodStart = data.current_period_start
            ? new Date(data.current_period_start)
            : new Date();
          const periodEnd = data.current_period_end
            ? new Date(data.current_period_end)
            : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

          // Update user record: attach dodoCustomerId & grant credits.
          // Atomic under a row lock: a retried webhook must not double-grant.
          await database
            .update(users)
            .set({
              dodoCustomerId: customerId,
              updatedAt: new Date(),
            })
            .where(eq(users.id, targetUserId));

          /*
           * The $7 BYOK add-on rides the same activation event with
           * metadata tier "byok". It is a flag, not a tier: a Pro subscriber
           * keeps Pro and gains the add-on; without a paid plan it stands
           * alone as the byok tier. Either way no credits are granted — the
           * subscriber pays model spend directly.
           */
          if (tier === "byok") {
            const [existingSub] = await database
              .select({ id: subscriptions.id, tier: subscriptions.tier })
              .from(subscriptions)
              .where(eq(subscriptions.userId, targetUserId))
              .limit(1);
            if (existingSub && existingSub.tier !== "free") {
              await database
                .update(subscriptions)
                .set({
                  byokAddon: true,
                  dodoCustomerId: customerId,
                  updatedAt: new Date(),
                })
                .where(eq(subscriptions.id, existingSub.id));
              return context.json({
                received: true,
                action: "byok_addon_activated",
              });
            }
          }

          const granted = await grantCredits(database, {
            userId: targetUserId,
            credits: creditsIncluded,
            reason: "monthly_allowance",
            idempotencyKey: `subscription.active:${subId}`,
          });

          // Upsert subscription
          const [existingSub] = await database
            .select({ id: subscriptions.id })
            .from(subscriptions)
            .where(eq(subscriptions.userId, targetUserId))
            .limit(1);

          if (existingSub) {
            await database
              .update(subscriptions)
              .set({
                id: subId,
                dodoCustomerId: customerId,
                dodoSubscriptionId: subId,
                tier,
                status: "active",
                currentPeriodStart: periodStart,
                currentPeriodEnd: periodEnd,
                cancelAtPeriodEnd: false,
                monthlyCreditsIncluded: creditsIncluded,
                gracePeriodEndsAt: null,
                updatedAt: new Date(),
              })
              .where(eq(subscriptions.userId, targetUserId));
          } else {
            await database.insert(subscriptions).values({
              id: subId,
              userId: targetUserId,
              dodoCustomerId: customerId,
              dodoSubscriptionId: subId,
              tier,
              status: "active",
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
              cancelAtPeriodEnd: false,
              monthlyCreditsIncluded: creditsIncluded,
              gracePeriodEndsAt: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }

          // Insert credit ledger transaction
          return context.json({
            received: true,
            action: "subscription_activated",
            balanceAfter: granted.balanceAfter,
          });
        }

        case "subscription.renewed": {
          const subId = data.subscription_id;
          if (!subId) {
            return context.json({
              received: true,
              warning: "Missing subscription_id",
            });
          }

          const [subRow] = await database
            .select()
            .from(subscriptions)
            .where(
              or(
                eq(subscriptions.dodoSubscriptionId, subId),
                eq(subscriptions.id, subId),
              ),
            )
            .limit(1);

          if (!subRow) {
            console.warn(
              `[Dodo Webhook] Subscription ${subId} not found for renewal`,
            );
            return context.json({
              received: true,
              warning: "Subscription not found",
            });
          }

          const periodStart = data.current_period_start
            ? new Date(data.current_period_start)
            : new Date();
          const periodEnd = data.current_period_end
            ? new Date(data.current_period_end)
            : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

          await database
            .update(subscriptions)
            .set({
              status: "active",
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
              gracePeriodEndsAt: null,
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.id, subRow.id));

          // Reset/grant monthly credits allowance on renewal anchor
          const allowance =
            subRow.monthlyCreditsIncluded ||
            TIER_CREDITS[subRow.tier as SubscriptionTier] ||
            600;
          const granted = await grantCredits(database, {
            userId: subRow.userId,
            credits: allowance,
            reason: "monthly_allowance",
            idempotencyKey: `subscription.renewed:${subId}:${data.current_period_start ?? periodStart.toISOString()}`,
          });

          return context.json({
            received: true,
            action: "subscription_renewed",
            balanceAfter: granted.balanceAfter,
          });
        }

        case "subscription.cancelled": {
          const subId = data.subscription_id;
          if (!subId) {
            return context.json({
              received: true,
              warning: "Missing subscription_id",
            });
          }

          const [subRow] = await database
            .select()
            .from(subscriptions)
            .where(
              or(
                eq(subscriptions.dodoSubscriptionId, subId),
                eq(subscriptions.id, subId),
              ),
            )
            .limit(1);

          if (!subRow) {
            return context.json({
              received: true,
              warning: "Subscription not found",
            });
          }

          // Downgrade user to free tier; conversation history and records stay preserved
          await database
            .update(subscriptions)
            .set({
              tier: "free",
              status: "canceled",
              monthlyCreditsIncluded: TIER_CREDITS.free,
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.id, subRow.id));

          console.log(
            `[Dodo Webhook] Subscription ${subId} cancelled; user ${subRow.userId} downgraded to free tier.`,
          );
          return context.json({
            received: true,
            action: "subscription_cancelled",
          });
        }

        case "subscription.past_due":
        case "payment.failed": {
          const subId = data.subscription_id;
          if (!subId) {
            return context.json({
              received: true,
              warning: "Missing subscription_id",
            });
          }

          const [subRow] = await database
            .select()
            .from(subscriptions)
            .where(
              or(
                eq(subscriptions.dodoSubscriptionId, subId),
                eq(subscriptions.id, subId),
              ),
            )
            .limit(1);

          if (!subRow) {
            return context.json({
              received: true,
              warning: "Subscription not found",
            });
          }

          // 3-day grace period before access suspension
          const gracePeriodEndsAt = new Date(
            Date.now() + 3 * 24 * 60 * 60 * 1000,
          );

          await database
            .update(subscriptions)
            .set({
              status: "past_due",
              gracePeriodEndsAt,
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.id, subRow.id));

          // Log dunning action (or trigger email in production)
          console.warn(
            `[Dodo Webhook] Payment failed for sub ${subId}. Account in 3-day grace period until ${gracePeriodEndsAt.toISOString()}`,
          );

          return context.json({
            received: true,
            action: "grace_period_started",
          });
        }

        case "subscription.updated": {
          const subId = data.subscription_id;
          if (!subId) {
            return context.json({
              received: true,
              warning: "Missing subscription_id",
            });
          }

          const [subRow] = await database
            .select()
            .from(subscriptions)
            .where(
              or(
                eq(subscriptions.dodoSubscriptionId, subId),
                eq(subscriptions.id, subId),
              ),
            )
            .limit(1);

          if (!subRow) {
            return context.json({
              received: true,
              warning: "Subscription not found",
            });
          }

          // Plan changes and period moves, but no grant: credits move only on
          // activation and renewal anchors. A tier change takes effect as the
          // next anchor's allowance.
          const rawTier = (data.metadata?.tier as string) ?? data.status;
          const tier: SubscriptionTier | undefined = [
            "free",
            "starter",
            "pro",
            "power",
            "byok",
          ].includes(typeof rawTier === "string" ? rawTier : "")
            ? (rawTier as SubscriptionTier)
            : undefined;

          await database
            .update(subscriptions)
            .set({
              ...(tier
                ? {
                    tier,
                    monthlyCreditsIncluded: TIER_CREDITS[tier],
                  }
                : {}),
              ...(data.status === "cancelled"
                ? { status: "canceled" as const, cancelAtPeriodEnd: true }
                : {}),
              ...(typeof data.current_period_start === "string"
                ? { currentPeriodStart: new Date(data.current_period_start) }
                : {}),
              ...(typeof data.current_period_end === "string"
                ? { currentPeriodEnd: new Date(data.current_period_end) }
                : {}),
              gracePeriodEndsAt: null,
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.id, subRow.id));

          return context.json({
            received: true,
            action: "subscription_updated",
          });
        }

        case "payment.succeeded": {
          /*
           * One-time top-up packs (the "Buy More Credits" modal). The pack's
           * credit amount travels in checkout metadata as `credits`; anything
           * without a parsable amount warns rather than guessing, because a
           * wrong guess mints money.
           */
          if (!data.payment_id) {
            return context.json({
              received: true,
              warning: "Missing payment_id",
            });
          }
          const credits = Number(
            (data.metadata?.credits as string | number | undefined) ??
              (data.metadata?.credit_amount as string | number | undefined),
          );
          if (!Number.isSafeInteger(credits) || credits <= 0) {
            console.warn(
              "[Dodo Webhook] payment.succeeded without usable metadata.credits",
              {
                paymentId: data.payment_id,
              },
            );
            return context.json({
              received: true,
              warning: "No credit amount in metadata",
            });
          }

          const customerId = data.customer?.customer_id;
          const metadataUserId =
            (data.metadata?.userId as string) ||
            (data.metadata?.user_id as string);
          let targetUserId = metadataUserId;
          if (!targetUserId && customerId) {
            const [userByCustomer] = await database
              .select({ id: users.id })
              .from(users)
              .where(eq(users.dodoCustomerId, customerId))
              .limit(1);
            if (userByCustomer) targetUserId = userByCustomer.id;
          }
          if (!targetUserId && data.customer?.email) {
            const [userByEmail] = await database
              .select({ id: users.id })
              .from(users)
              .where(eq(users.email, data.customer.email))
              .limit(1);
            if (userByEmail) targetUserId = userByEmail.id;
          }
          if (!targetUserId) {
            console.warn(
              "[Dodo Webhook] Could not associate payment with a user",
              {
                paymentId: data.payment_id,
              },
            );
            return context.json({ received: true, warning: "User not found" });
          }

          const granted = await grantCredits(database, {
            userId: targetUserId,
            credits,
            reason: "top_up",
            idempotencyKey: data.payment_id
              ? `payment.succeeded:${data.payment_id}`
              : undefined,
          });
          return context.json({
            received: true,
            action: "top_up_credited",
            balanceAfter: granted.balanceAfter,
          });
        }

        default: {
          console.warn(`[Dodo Webhook] Unhandled event type: ${eventType}`, {
            subscriptionId: data.subscription_id,
            paymentId: data.payment_id,
          });
          return context.json({
            received: true,
            message: `Ignored event ${eventType}`,
          });
        }
      }
    } catch (err) {
      console.error("[Dodo Webhook] Error processing event:", err);
      return context.json({ error: "Internal processing error" }, 500);
    }
  });

  return routes;
}
