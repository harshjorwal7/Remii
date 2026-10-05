import { expect, test } from "bun:test";
import type { PluginServer } from "@/lib/plugins/queries";
import {
  appMatchesCategory,
  brokeredAccountsListedOn,
  sortConnectedFirst,
} from "@/routes/_authed/settings/connected-accounts/index";

/**
 * Which brokered apps the Connected accounts page lists, decided without drawing anything.
 *
 * The page's own rule for the catalogue half is "only vendors reached as a person": a vendor with a
 * shared token is left off because it "has nothing for you to decide". A Composio `NO_AUTH` app has
 * exactly as little, one layer further in — there is no account to make, `/servers/:id/connect`
 * refuses to create one, and the call gate lets such a call through with no connection row at all —
 * and the brokered filter took every `composio` row regardless.
 *
 * WHAT THAT PUT ON EVERY PERSON'S PAGE was a permanently grey "Not connected" row for an app nobody
 * can connect, which reads as an unfinished task and can never turn green. Clicking it lands on a
 * page that says the app needs no account and draws no button, so the list and the page it opens
 * contradict each other — and the list is the more believable of the two.
 *
 * A `.tsx` file because it imports a route module, which is JSX; the precedent is
 * `composio-picker.test.tsx`, which exports its own rule as a function for this same reason.
 */

/** A minimal but complete `PluginServer`, overridable per case. */
function server(overrides: Partial<PluginServer> & { id: string }) {
  return {
    title: "App",
    summary: "",
    vendor: "Composio",
    url: `composio://${overrides.id}`,
    provenance: "composio",
    authScheme: "API_KEY",
    tools: [],
    ...overrides,
  } as PluginServer;
}

test("a brokered app somebody connects is listed", () => {
  expect(
    brokeredAccountsListedOn([
      server({ id: "composio-gmail", authScheme: "OAUTH2" }),
      server({ id: "composio-linear", authScheme: "API_KEY" }),
    ]).map((row) => row.id),
  ).toEqual(["composio-gmail", "composio-linear"]);
});

test("a brokered app that needs no account is not listed", () => {
  expect(
    brokeredAccountsListedOn([
      server({ id: "composio-hackernews", authScheme: "NO_AUTH" }),
      server({ id: "composio-gmail", authScheme: "OAUTH2" }),
    ]).map((row) => row.id),
  ).toEqual(["composio-gmail"]);
});

/**
 * AND A ROW WITH NO RECORDED SCHEME IS STILL LISTED, which is the deliberate direction.
 *
 * A brokered row whose column was never written — restored, or made before the column existed — is
 * far likelier to be a key or consent app than a no-auth one, and dropping it here would hide a
 * connection somebody does have from the only page that offers to disconnect it.
 */
test("a brokered app with no recorded scheme is still listed", () => {
  expect(
    brokeredAccountsListedOn([
      server({ id: "composio-mystery", authScheme: null }),
    ]).map((row) => row.id),
  ).toEqual(["composio-mystery"]);
});

test("a server that is not brokered at all is never listed", () => {
  expect(
    brokeredAccountsListedOn([
      server({
        id: "internal",
        provenance: "custom",
        url: "https://mcp.example.com/mcp",
        authScheme: null,
      }),
    ]),
  ).toEqual([]);
});

test("all category matches any app", () => {
  expect(
    appMatchesCategory("all", "Random App", "random-key", "random description"),
  ).toBe(true);
});

test("productivity category matches productivity tools", () => {
  expect(
    appMatchesCategory(
      "productivity",
      "Notion",
      "notion",
      "Pages and workspace",
    ),
  ).toBe(true);
  expect(
    appMatchesCategory(
      "productivity",
      "Google Drive",
      "google-drive",
      "Files in drive",
    ),
  ).toBe(true);
  expect(
    appMatchesCategory(
      "productivity",
      "Slack",
      "slack",
      "Team messaging",
      "Slack",
      ["communication"],
    ),
  ).toBe(true);
  expect(
    appMatchesCategory("productivity", "BambooHR", "bamboohr", "HR software"),
  ).toBe(false);
});

test("ops category matches operational and security tools", () => {
  expect(
    appMatchesCategory(
      "ops",
      "1password",
      "1password",
      "Password manager and vault",
    ),
  ).toBe(true);
  expect(
    appMatchesCategory("ops", "21risk", "21risk", "Compliance and risk audits"),
  ).toBe(true);
  expect(
    appMatchesCategory("ops", "Datadog", "datadog", "Monitoring service"),
  ).toBe(true);
  expect(
    appMatchesCategory("ops", "Google Drive", "google-drive", "Files in drive"),
  ).toBe(false);
});

test("google category matches Google ecosystem tools", () => {
  expect(
    appMatchesCategory(
      "google",
      "Google Drive",
      "google-drive",
      "Files in drive",
    ),
  ).toBe(true);
  expect(appMatchesCategory("google", "Gmail", "gmail", "Email service")).toBe(
    true,
  );
  expect(appMatchesCategory("google", "Notion", "notion", "Notes")).toBe(false);
});

test("dev category matches developer tools", () => {
  expect(
    appMatchesCategory("dev", "0CodeKit", "0codekit", "Utility APIs for AI"),
  ).toBe(true);
  expect(appMatchesCategory("dev", "GitHub", "github", "Code repository")).toBe(
    true,
  );
  expect(appMatchesCategory("dev", "2chat", "2chat", "WhatsApp API")).toBe(
    true,
  );
  expect(appMatchesCategory("dev", "BambooHR", "bamboohr", "HR app")).toBe(
    false,
  );
});

test("marketing category matches CRM and marketing tools", () => {
  expect(
    appMatchesCategory("marketing", "HubSpot", "hubspot", "CRM and marketing"),
  ).toBe(true);
  expect(
    appMatchesCategory(
      "marketing",
      "Mailchimp",
      "mailchimp",
      "Email campaigns",
    ),
  ).toBe(true);
  expect(appMatchesCategory("marketing", "GitHub", "github", "Code repo")).toBe(
    false,
  );
});

test("hr category matches HR and personnel tools", () => {
  expect(
    appMatchesCategory(
      "hr",
      "BambooHR",
      "bamboohr",
      "HR and employee software",
    ),
  ).toBe(true);
  expect(
    appMatchesCategory(
      "hr",
      "Rippling",
      "rippling",
      "Payroll and human resources",
    ),
  ).toBe(true);
  expect(appMatchesCategory("hr", "1password", "1password", "Vault")).toBe(
    false,
  );
});

test("sortConnectedFirst places connected accounts at the top of the list", () => {
  const apps = [
    { id: "0codekit", connected: false },
    { id: "1password", connected: false },
    { id: "composio-gmail", connected: true },
    { id: "2chat", connected: false },
  ];
  const sorted = sortConnectedFirst(apps, (item) => item.connected);
  expect(sorted.map((a) => a.id)).toEqual([
    "composio-gmail",
    "0codekit",
    "1password",
    "2chat",
  ]);
});
