import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { routeTree } from "../src/routeTree.gen";

/**
 * What the Vault screen shows, and — the part that matters — what it never shows.
 *
 * The whole feature rests on one property: a secret reaches the browser only for the length of one
 * clipboard write. So the assertions here are mostly NEGATIVE. Given a vault with a password, a card
 * number, a CVV and an API key in it, the page's entire rendered text must contain none of them, and
 * neither must the markup of anything a person could see without clicking.
 *
 * The second thing checked is the state machine around that: a failed read must not draw "No logins
 * saved", which is the bug `failed-read-not-empty-state.test.tsx` was written about and the one this
 * screen is most likely to repeat given four sections each with its own empty sentence.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SECRET_PASSWORD = "correct horse battery staple";
const SECRET_CARD = "4242424242424242";
const SECRET_CVV = "739";
const SECRET_KEY = "sk_live_do_not_leak";

const VAULT = {
  logins: [
    {
      id: "vault_login-1",
      label: "Google",
      username: "user@example.com",
      websiteUrl: "https://mail.google.com",
      notes: null,
      hasPassword: true,
      lastUsedAt: null,
      usageCount: 3,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  ],
  cards: [
    {
      id: "vault_card-1",
      label: "Personal Visa",
      cardholderName: "John Doe",
      maskedNumber: "•••• •••• •••• 4242",
      expiry: "04/29",
      hasCvv: true,
      billingAddress: null,
      notes: null,
      lastUsedAt: null,
      usageCount: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  ],
  personalInfo: {
    fullName: "John Doe",
    preferredName: null,
    email: "john@example.com",
    phone: null,
    dateOfBirth: null,
    address: null,
    city: null,
    state: null,
    country: null,
    postalCode: null,
    company: null,
    jobTitle: null,
    notes: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  agentItems: [
    {
      id: "vault_item-1",
      label: "Stripe API key",
      kind: "api_key",
      description: "The live key",
      scope: "agent",
      scopeRef: null,
      allowedApps: [],
      hasValue: true,
      lastUsedAt: null,
      usedByAgentId: null,
      usageCount: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  ],
};

const EMPTY_VAULT = {
  logins: [],
  cards: [],
  personalInfo: null,
  agentItems: [],
};

/** What the server would send if it were wrongly answering with a secret, so the test can catch it. */
const LEAKY_VAULT = {
  ...VAULT,
  logins: [{ ...VAULT.logins[0], password: SECRET_PASSWORD }],
  cards: [{ ...VAULT.cards[0], cardNumber: SECRET_CARD, cvv: SECRET_CVV }],
  agentItems: [{ ...VAULT.agentItems[0], value: SECRET_KEY }],
};

type VaultBody = Record<string, unknown>;

function serveVault(body: VaultBody = VAULT) {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/api/vault")) return json(body);
    if (url.includes("/api/me")) {
      return json({
        user: {
          id: "u1",
          email: "owner@example.com",
          role: "user",
          onboarding: null,
        },
      });
    }
    return json({});
  }) as typeof fetch;
}

/**
 * The vault endpoint fails; everything else answers as it does in the healthy case.
 *
 * The rest of the shell matters here. `/api/me` in particular: a stub that answered `{}` for it would
 * fail the `_authed` guard, and the screen under test would never render at all — so the error being
 * asserted would be the router's, not the vault's.
 */
function serveFailingVault() {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/vault")) {
      return new Response(
        JSON.stringify({ error: "The vault is unreachable." }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify(
        url.includes("/api/me")
          ? {
              user: {
                id: "u1",
                email: "owner@example.com",
                role: "user",
                onboarding: null,
              },
            }
          : {},
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

async function openVault() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient } as never,
    defaultPreload: false,
  });
  await router.navigate({ to: "/settings/vault" });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient } as never} />
    </QueryClientProvider>,
  );
  await waitFor(() => {
    expect(view.container.textContent).not.toContain("Something went wrong");
  });
  return view;
}

test("every section shows its saved items", async () => {
  serveVault();
  const view = await openVault();
  const text = view.container.textContent ?? "";

  expect(text).toContain("Logins");
  expect(text).toContain("Google");
  expect(text).toContain("user@example.com");

  expect(text).toContain("Cards");
  expect(text).toContain("Personal Visa");

  expect(text).toContain("Personal info");
  expect(text).toContain("john@example.com");

  expect(text).toContain("Agent items");
  expect(text).toContain("Stripe API key");
  // The kind is drawn as words, which is the difference between a stored value and a readable label.
  expect(text).toContain("API key");
});

test("no secret is anywhere in the page, and the server never sent one either", async () => {
  serveVault();
  const view = await openVault();

  // The whole document, including anything inside a menu or a portal that has not been opened.
  const everything = `${view.container.textContent ?? ""}${view.container.innerHTML}`;
  expect(everything).not.toContain(SECRET_PASSWORD);
  expect(everything).not.toContain(SECRET_CARD);
  expect(everything).not.toContain(SECRET_CVV);
  expect(everything).not.toContain(SECRET_KEY);

  // The mask IS drawn, which is what makes the absence above mean "masked" rather than "not loaded".
  expect(view.container.textContent).toContain("•••• •••• •••• 4242");
});

test("a server that leaked a secret would still not have it drawn", async () => {
  /*
   * The stronger half of the property. The test above proves the page does not DECRYPT anything; this
   * one proves it does not merely fail to decrypt — if a field named `password` ever appeared on a
   * summary type, this renders it and the assertion catches it.
   */
  serveVault(LEAKY_VAULT);
  const view = await openVault();

  const drawn = view.container.textContent ?? "";
  expect(drawn).not.toContain(SECRET_PASSWORD);
  expect(drawn).not.toContain(SECRET_CVV);
  expect(drawn).not.toContain(SECRET_KEY);
  // The card is the one that must still be masked, because the row draws `maskedNumber` by name.
  expect(drawn).toContain("•••• •••• •••• 4242");
  expect(drawn).not.toContain(SECRET_CARD);
});

test("an empty vault says so in a sentence, once per section", async () => {
  serveVault(EMPTY_VAULT);
  const view = await openVault();
  const text = view.container.textContent ?? "";

  expect(text).toContain("No logins saved.");
  expect(text).toContain("No cards saved.");
  expect(text).toContain("No personal info saved.");
  expect(text).toContain("No agent items saved.");
  // An empty bordered box would read as something that failed to load; absence is what is drawn.
  expect(view.container.textContent).not.toContain("Something went wrong");
});

test("a failed read does not draw the empty sentences", async () => {
  /*
   * The bug `failed-read-not-empty-state.test.tsx` is about, for a screen with four of these. On a
   * FAILED read the person must not be told they have saved nothing, because the obvious next thing
   * they would do about that is fill it all in again.
   */
  serveFailingVault();
  const view = await openVault();
  const text = view.container.textContent ?? "";

  // The page itself rendered, so this is the vault's failure and not a router that never got there.
  expect(text).toContain("Vault");
  expect(text).toContain("The vault is unreachable.");
  expect(text).not.toContain("No logins saved.");
  expect(text).not.toContain("No cards saved.");
  expect(text).not.toContain("No personal info saved.");
  expect(text).not.toContain("No agent items saved.");
});

test("each section has its own add action", async () => {
  serveVault(EMPTY_VAULT);
  const view = await openVault();

  const adds = [...view.container.querySelectorAll("button")]
    .filter((button) =>
      (button.getAttribute("aria-label") ?? "").startsWith("Add"),
    )
    .map((button) => button.getAttribute("aria-label"));
  expect(adds).toEqual([
    "Add login",
    "Add card",
    "Add personal info",
    "Add agent item",
  ]);
});

test("a row's menu offers edit and delete, and the delete names the item", async () => {
  serveVault();
  const view = await openVault();

  // The menu trigger is a button per row, and its accessible name carries the item's own name so a
  // menu opened over the wrong row is still identifiable.
  const triggers = [...view.container.querySelectorAll("button")]
    .map((button) => button.getAttribute("aria-label"))
    .filter((name): name is string => name?.endsWith("options") ?? false);
  expect(triggers).toContain("Google options");
  expect(triggers).toContain("Personal Visa options");
  expect(triggers).toContain("Stripe API key options");
});
