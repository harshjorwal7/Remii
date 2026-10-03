import DodoPayments from "dodopayments";

export type SubscriptionTier = "free" | "starter" | "pro" | "power" | "byok";

export type DodoConfig = {
  apiKey?: string;
  webhookSecret?: string;
  environment: "test_mode" | "live_mode";
  productIds: Record<SubscriptionTier, string>;
};

export function getDodoConfig(): DodoConfig {
  const environment =
    process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode"
      ? "live_mode"
      : "test_mode";

  return {
    apiKey: process.env.DODO_PAYMENTS_API_KEY,
    webhookSecret: process.env.DODO_PAYMENTS_WEBHOOK_SECRET,
    environment,
    productIds: {
      free: process.env.DODO_PRODUCT_ID_FREE || "pdt_free",
      starter: process.env.DODO_PRODUCT_ID_STARTER || "pdt_starter",
      pro: process.env.DODO_PRODUCT_ID_PRO || "pdt_pro",
      power: process.env.DODO_PRODUCT_ID_POWER || "pdt_power",
      byok: process.env.DODO_PRODUCT_ID_BYOK || "pdt_byok",
    },
  };
}

export function getDodoClient(): DodoPayments | null {
  const config = getDodoConfig();
  if (!config.apiKey) {
    return null;
  }
  return new DodoPayments({
    bearerToken: config.apiKey,
    webhookKey: config.webhookSecret,
    environment: config.environment,
  });
}

export type CreateCheckoutParams = {
  user: {
    id: string;
    email?: string | null;
    name?: string | null;
    dodoCustomerId?: string | null;
  };
  tier: SubscriptionTier;
  /** One-time credit top-up. When set, checks out a top-up product instead of a subscription. */
  credits?: number;
  returnUrl?: string;
};

export type CheckoutSessionResult = {
  sessionId: string;
  checkoutUrl: string;
};

/**
 * Creates a Dodo Payments Checkout Session for subscription upgrade.
 * Passes the user.id in metadata to link webhook events to the local user.
 */
export async function createCheckoutSession(
  params: CreateCheckoutParams,
): Promise<CheckoutSessionResult> {
  const config = getDodoConfig();
  const client = getDodoClient();

  const customerId =
    params.user.dodoCustomerId || `cus_remii_${params.user.id}`;
  const returnUrl =
    params.returnUrl ||
    `${process.env.APP_URL || "http://localhost:3010"}/settings/billing?status=success`;

  /*
   * One-time top-up packs check out a top-up product, not a subscription.
   * The credit amount travels in metadata so payment.succeeded can grant it;
   * the amount is re-validated there, because checkout metadata is exactly
   * as trustworthy as the person who paid.
   */
  const isTopUp =
    params.credits !== undefined && Number.isSafeInteger(params.credits);
  const topUpProductId = process.env.DODO_PRODUCT_ID_TOPUP;
  if (isTopUp && !topUpProductId) {
    throw new Error(
      "DODO_PRODUCT_ID_TOPUP is not set, so credit top-ups are unavailable. " +
        "Create a one-time top-up product in Dodo and set it.",
    );
  }
  const productId = isTopUp
    ? (topUpProductId as string)
    : config.productIds[params.tier];

  if (!client) {
    // No credentials, no checkout. A fake payment URL would take a person's
    // money nowhere and record nothing; in development credits come from the
    // metering a run produces instead.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "DODO_PAYMENTS_API_KEY is not set, so checkout is unavailable.",
      );
    }
    // Development / mock fallback when running without live API credentials
    const mockSessionId = `dodo_cs_mock_${Date.now()}_${params.user.id}`;
    const mockUrl = `https://test.dodopayments.com/buy/${productId}?client_reference_id=${encodeURIComponent(
      params.user.id,
    )}&customer_id=${encodeURIComponent(customerId)}&return_url=${encodeURIComponent(
      returnUrl,
    )}`;
    return {
      sessionId: mockSessionId,
      checkoutUrl: mockUrl,
    };
  }

  const session = await client.checkoutSessions.create({
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: {
      customer_id: customerId,
      email: params.user.email ?? undefined,
      name: params.user.name ?? undefined,
    },
    metadata: {
      userId: params.user.id,
      tier: params.tier,
      ...(isTopUp ? { credits: String(params.credits) } : {}),
    },
    return_url: returnUrl,
  });

  return {
    sessionId: session.session_id,
    checkoutUrl:
      session.checkout_url ||
      `https://test.dodopayments.com/session/${session.session_id}`,
  };
}

export type CustomerPortalResult = {
  portalUrl: string;
};

/**
 * Creates a one-time Dodo Payments Customer Portal session for the customer.
 * Allows users to update payment methods, cancel subscriptions, and download PDF tax invoices.
 */
export async function createCustomerPortalSession(params: {
  customerId: string;
  returnUrl?: string;
}): Promise<CustomerPortalResult> {
  const client = getDodoClient();
  const returnUrl =
    params.returnUrl ||
    `${process.env.APP_URL || "http://localhost:3010"}/settings/billing`;

  if (!client) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "DODO_PAYMENTS_API_KEY is not set, so the customer portal is unavailable.",
      );
    }
    return {
      portalUrl: `https://test.customer.dodopayments.com/login?customer_id=${encodeURIComponent(
        params.customerId,
      )}&return_url=${encodeURIComponent(returnUrl)}`,
    };
  }

  const portalSession = await client.customers.customerPortal.create(
    params.customerId,
    {
      return_url: returnUrl,
    },
  );

  return {
    portalUrl: portalSession.link,
  };
}

export type DodoWebhookPayload = {
  type: string;
  timestamp: string;
  business_id?: string;
  data: {
    subscription_id?: string;
    payment_id?: string;
    product_id?: string;
    status?: string;
    customer?: {
      customer_id?: string;
      email?: string;
      name?: string;
    };
    metadata?: Record<string, unknown>;
    current_period_start?: string;
    current_period_end?: string;
    next_billing_date?: string;
    [key: string]: unknown;
  };
};

/**
 * Verifies and unwraps incoming Dodo Payments webhook requests.
 */
export function verifyAndUnwrapWebhook(
  rawBody: string,
  headers: Record<string, string | undefined>,
): DodoWebhookPayload {
  const client = getDodoClient();
  const webhookKey = process.env.DODO_PAYMENTS_WEBHOOK_SECRET;

  if (client && webhookKey && headers["webhook-signature"]) {
    const unwrapped = client.webhooks.unwrap(rawBody, {
      headers: {
        "webhook-id": headers["webhook-id"] || "",
        "webhook-signature": headers["webhook-signature"] || "",
        "webhook-timestamp": headers["webhook-timestamp"] || "",
      },
    }) as unknown;
    return unwrapped as DodoWebhookPayload;
  }

  // Fallback for tests / dev without signature key. Unsigned webhooks are
  // never trusted in production: the route refuses them there (see
  // webhook-routes.ts), so this path only serves local development.
  return JSON.parse(rawBody) as DodoWebhookPayload;
}
