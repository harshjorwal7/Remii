import { IconChevronRight, IconSearch } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { useEffect, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import {
  AppMark,
  COMPOSIO_LOGO,
  MARKS,
  markFor,
} from "@/components/plugins/app-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { enableComposioAppMutationOptions } from "@/lib/plugins/mutations";
import {
  composioAppsQueryOptions,
  connectionsQueryOptions,
  type PluginServer,
  pluginsSlimQueryOptions,
} from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";

/**
 * The services a Bot reads as you.
 *
 * Yours, not the deployment's. An administrator decides which vendors this deployment may reach at
 * all; this is the other half of that decision, and it is one nobody can make for you — there is no
 * endpoint for an administrator to connect an account on somebody's behalf. A Bot calling one of
 * these runs on your own grant, so it sees exactly what you can see and nothing else.
 */
export const Route = createFileRoute("/_authed/settings/connected-accounts/")({
  component: RouteComponent,
  /*
   * `?connected=` is how the OAuth callback reports back, carrying a server key on success and
   * `failed` otherwise. It is the only channel available: the callback is a redirect from another
   * company's server, so there is no response body to read.
   *
   * The key is omitted rather than set to undefined. Present-but-undefined makes `search` a required
   * prop on every Link to this route, which is a lot of ripple for a parameter only the callback sets.
   */
  validateSearch: (search: Record<string, unknown>): { connected?: string } =>
    typeof search.connected === "string" ? { connected: search.connected } : {},
});

export { MARKS, markFor };

export type ConnectedAccountCategory =
  | "all"
  | "productivity"
  | "ops"
  | "google"
  | "dev"
  | "marketing"
  | "hr";

export const CONNECTED_ACCOUNT_CATEGORIES: {
  id: ConnectedAccountCategory;
  label: string;
}[] = [
  { id: "all", label: "All" },
  { id: "productivity", label: "Productivity" },
  { id: "ops", label: "Ops" },
  { id: "google", label: "Google" },
  { id: "dev", label: "Dev & Engineering" },
  { id: "marketing", label: "Marketing" },
  { id: "hr", label: "HR" },
];

/** How many apps paint immediately; the rest follow on an idle callback. */
const FIRST_PAINT_APPS = 50;

/**
 * Sorts accounts so connected accounts appear on top, preserving relative order within groups.
 */
export function sortConnectedFirst<T>(
  items: T[],
  isConnectedFn: (item: T) => boolean,
): T[] {
  return [...items].sort((a, b) => {
    const aConn = isConnectedFn(a);
    const bConn = isConnectedFn(b);
    if (aConn && !bConn) return -1;
    if (!aConn && bConn) return 1;
    return 0;
  });
}

/**
 * Filter rule deciding if an app (OAuth catalogue entry or brokered server) matches a chosen category filter.
 */
export function appMatchesCategory(
  category: ConnectedAccountCategory,
  title: string,
  idOrKey: string,
  description?: string | null,
  vendor?: string | null,
  rawCategories?: string[] | null,
): boolean {
  if (category === "all") return true;

  const text =
    `${title} ${idOrKey} ${description ?? ""} ${vendor ?? ""}`.toLowerCase();
  const cats = (rawCategories ?? []).map((c) => c.toLowerCase());

  const check = (keywords: string[]) =>
    cats.some((c) => keywords.some((k) => c.includes(k))) ||
    keywords.some((k) => text.includes(k));

  switch (category) {
    case "productivity":
      return check([
        "productivity",
        "collaboration",
        "office",
        "documents",
        "document",
        "notes",
        "workspace",
        "communication",
        "calendar",
        "task",
        "project",
        "notion",
        "drive",
        "docs",
        "sheets",
        "slides",
        "slack",
        "trello",
        "asana",
        "clickup",
        "todoist",
        "jira",
        "confluence",
        "linear",
        "zoom",
        "dropbox",
        "airtable",
        "coda",
        "routine",
      ]);
    case "ops":
      return check([
        "ops",
        "operations",
        "devops",
        "monitoring",
        "cloud",
        "infrastructure",
        "security",
        "analytics",
        "database",
        "pagerduty",
        "datadog",
        "sentry",
        "aws",
        "gcp",
        "azure",
        "docker",
        "kubernetes",
        "grafana",
        "prometheus",
        "splunk",
        "cloudflare",
        "terraform",
        "vault",
        "1password",
        "21risk",
        "statuspage",
        "newrelic",
        "incident",
        "log",
        "metrics",
      ]);
    case "google":
      return check([
        "google",
        "gmail",
        "gdrive",
        "gsuite",
        "youtube",
        "google-drive",
      ]);
    case "dev":
      return check([
        "developer-tools",
        "developer",
        "engineering",
        "dev",
        "code",
        "api",
        "git",
        "ci-cd",
        "github",
        "gitlab",
        "bitbucket",
        "postman",
        "sentry",
        "vercel",
        "netlify",
        "supabase",
        "firebase",
        "docker",
        "npm",
        "linear",
        "jira",
        "0codekit",
        "2chat",
        "terminal",
        "console",
        "repository",
        "bug",
        "tracking",
      ]);
    case "marketing":
      return check([
        "marketing",
        "crm",
        "email-marketing",
        "social-media",
        "seo",
        "analytics",
        "sales",
        "hubspot",
        "mailchimp",
        "intercom",
        "salesforce",
        "klaviyo",
        "buffer",
        "hootsuite",
        "google analytics",
        "segment",
        "mixpanel",
        "activecampaign",
        "semrush",
        "campaign",
        "leads",
      ]);
    case "hr":
      return check([
        "hr",
        "human-resources",
        "recruiting",
        "people",
        "payroll",
        "hiring",
        "bamboohr",
        "rippling",
        "gusto",
        "workday",
        "greenhouse",
        "lever",
        "personio",
        "justworks",
        "hibob",
        "employee",
        "staff",
        "talent",
      ]);
    default:
      return true;
  }
}

/**
 * The brokered apps this page lists, which is not every brokered row.
 *
 * Exported as a function rather than left inline in the render, for the reason `matchingApps` on the
 * Composio picker is: the rule is the thing worth pinning and pinning it needs no DOM, no router and
 * no query client. See its one clause below.
 */
export function brokeredAccountsListedOn(
  servers: PluginServer[],
): PluginServer[] {
  return servers.filter(
    (server) =>
      server.provenance === "composio" && server.authScheme !== "NO_AUTH",
  );
}

function RouteComponent() {
  const { connected: outcome } = Route.useSearch();
  const plugins = useQuery(pluginsSlimQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] =
    useState<ConnectedAccountCategory>("all");

  const connected = new Set(
    (connections.data?.connections ?? []).flatMap((row) => [
      row.serverId,
      row.serverId.replace(/^composio-/, ""),
    ]),
  );
  const added = new Set((plugins.data?.servers ?? []).map((s) => s.id));

  const isConnected = (id: string) =>
    connected.has(id) || connected.has(id.replace(/^composio-/, ""));

  /*
   * Only vendors reached as a person, and only ones an administrator has enabled.
   *
   * A vendor with a shared token has nothing for you to decide: it answers the same for everybody,
   * so listing it here would offer a choice you do not have. And a vendor nobody has enabled cannot
   * be connected at all, because there is no OAuth client to consent against.
   */
  const yours = (plugins.data?.catalogue ?? []).filter(
    (entry) => entry.auth === "user-oauth" && added.has(entry.key),
  );

  /*
   * Brokered apps belong here for the same reason the OAuth ones do: they answer as you.
   *
   * The filter above names the catalogue's `user-oauth` kind, which a brokered row cannot have
   * because it has no catalogue entry at all — so the one connector that is nothing but per-person
   * accounts was the one this page never listed.
   *
   * EXCEPT THE ONES THAT NEED NO ACCOUNT, WHICH IS THE SAME RULE THE `user-oauth` FILTER ABOVE IS.
   * That one keeps out a vendor with a shared token because it "has nothing for you to decide"; a
   * Composio `NO_AUTH` app has exactly as little, one layer further in. There is no account to make:
   * `/servers/:id/connect` refuses to create one and the call gate lets it through with no row, so
   * a row for it here can never turn green. What an admin enabling Hacker News put on every
   * person's page was a permanently grey "Not connected" that reads as an unfinished task, opening
   * a page that says the app needs no account and draws no button — the list and the page it opens
   * contradicting each other, with the list the more believable of the two.
   *
   * ASKED OF THE RECORDED SCHEME, which this read already carries and the detail route already
   * consumes. Anything that is not the vendor's `NO_AUTH` is an app somebody connects, an
   * unrecorded scheme included: a row whose column was never written is far likelier to be a key or
   * consent app, and dropping it here would hide a connection somebody does have.
   */
  const brokered = brokeredAccountsListedOn(plugins.data?.servers ?? []);

  /*
   * With the whole catalogue enabled this list is over a thousand rows, so
   * it filters as you type — on title, id and the vendor's own description.
   * The match runs here rather than on the server because the rows are
   * already on the page for the connected dots, and a second fetch per
   * keystroke would race them.
   */
  const term = search.trim().toLowerCase();
  const matches = (title: string, id: string, description?: string | null) =>
    term.length === 0 ||
    [title, id, description ?? ""].some((field) =>
      field.toLowerCase().includes(term),
    );
  const visibleYours = yours.filter(
    (entry) =>
      matches(entry.title, entry.key, entry.summary) &&
      appMatchesCategory(
        selectedCategory,
        entry.title,
        entry.key,
        entry.summary,
        entry.vendor,
        null,
      ),
  );
  const visibleBrokered = brokered.filter(
    (server) =>
      matches(server.title, server.id, server.broker?.description) &&
      appMatchesCategory(
        selectedCategory,
        server.title,
        server.id,
        server.broker?.description,
        server.vendor,
        server.broker?.categories,
      ),
  );
  const totalAppsCount = yours.length + brokered.length;

  type ListedAccount =
    | { kind: "yours"; entry: (typeof visibleYours)[number] }
    | { kind: "brokered"; server: (typeof visibleBrokered)[number] };

  const rawVisibleAccounts: ListedAccount[] = [
    ...visibleYours.map((entry): ListedAccount => ({ kind: "yours", entry })),
    ...visibleBrokered.map(
      (server): ListedAccount => ({ kind: "brokered", server }),
    ),
  ];

  const visibleAccounts = sortConnectedFirst(rawVisibleAccounts, (item) =>
    item.kind === "yours"
      ? isConnected(item.entry.key)
      : isConnected(item.server.id),
  );

  /*
   * Paint the first screen fast, fill in the rest in the background.
   *
   * With the whole catalogue enabled this list is over a thousand rows with
   * vendor logos, and drawing them all blocks the first paint for seconds.
   * So the first 50 go up immediately and the remainder follows on an idle
   * callback — the page feels instant and search still covers everything a
   * beat later. Typing or changing the category restarts the window, so a
   * filtered list never waits behind the previous one's background fill.
   */
  const [expanded, setExpanded] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-running on filter changes is the point.
  useEffect(() => {
    setExpanded(false);
    const fill = () => setExpanded(true);
    const w = window as Window & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof w.requestIdleCallback === "function") {
      const id = w.requestIdleCallback(fill, { timeout: 1500 });
      return () => w.cancelIdleCallback?.(id);
    }
    const timer = w.setTimeout(fill, 600);
    return () => w.clearTimeout(timer);
  }, [term, selectedCategory, totalAppsCount]);
  const shownAccounts = expanded
    ? visibleAccounts
    : visibleAccounts.slice(0, FIRST_PAINT_APPS);

  return (
    <PageShell
      description="Services a Bot reads as you, so it only ever sees what you can see. Connecting is yours to grant, and nobody can grant it for you."
      title="Connected accounts"
    >
      {/*
       * Only the failure is worth saying. A success needs no sentence: the row it came back to now
       * reads "Connected", which is the same news told by the thing it is news about.
       */}
      {outcome === "failed" ? (
        <p className="text-destructive text-sm" role="alert">
          That account could not be connected. Nothing was saved — try again.
        </p>
      ) : null}
      {/*
       * BOTH READS DECIDE THIS, AND ONLY ONE OF THEM USED TO. The waits were already paired here;
       * the errors were not — this branch tested `plugins.error` alone, so a `/api/plugins` that
       * succeeded beside a `/api/plugins/connections` that failed left the `connected` set empty and
       * every row below asserting "Not connected", with no error text anywhere on the page. Somebody
       * holding Gmail through Composio and Drive through OAuth was shown both as unconnected and
       * clicked through to reconnect accounts they already had. The brokered rows make it worse than
       * it was before they existed, because a brokered row's entire content is the connection state.
       *
       * ONE SENTENCE FOR BOTH, because the two failures are one fact from where the reader stands:
       * this page could not be loaded, and what it would otherwise draw is not shown rather than
       * drawn wrong.
       */}
      {plugins.isPending || connections.isPending ? null : plugins.error ||
        connections.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          Your connected accounts could not be loaded, so nothing is listed here
          rather than a list that may be wrong. Reload the page and try again.
        </p>
      ) : (
        <PageSection>
          {totalAppsCount > 0 && (
            <div className="mt-4 mb-3 flex flex-col gap-3">
              <div className="relative">
                <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Search connected apps"
                  className="pl-9"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={`Search ${totalAppsCount.toLocaleString()} apps…`}
                  value={search}
                />
              </div>

              <fieldset className="flex flex-wrap items-center gap-1.5">
                <legend className="sr-only">Filter apps by category</legend>
                {CONNECTED_ACCOUNT_CATEGORIES.map((cat) => {
                  const isSelected = selectedCategory === cat.id;
                  return (
                    <Button
                      aria-pressed={isSelected}
                      className={cn(
                        "rounded-full px-3 text-xs transition-colors",
                        isSelected
                          ? "bg-primary text-primary-foreground hover:bg-primary/90"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                      key={cat.id}
                      onClick={() => setSelectedCategory(cat.id)}
                      size="sm"
                      variant={isSelected ? "default" : "outline"}
                    >
                      {cat.label}
                    </Button>
                  );
                })}
              </fieldset>
            </div>
          )}
          {visibleYours.length === 0 && visibleBrokered.length === 0 ? (
            /*
             * Says whose move it is, and says what to do about it.
             *
             * The empty state used to blame an administrator for a connector nobody could enable:
             * Composio apps appear here only once enabled, enabling is a POST with no screen behind
             * it, and a person with a working Composio key was told to wait for somebody else over a
             * list they were the only one who could have filled. The button below is that POST.
             */
            <PageEmpty>
              {term.length > 0 || selectedCategory !== "all" ? (
                `No apps match your filter criteria.`
              ) : totalAppsCount === 0 ? (
                <span className="flex flex-col items-center gap-3">
                  Nothing to connect yet. Add an app from Composio&apos;s
                  directory below.
                </span>
              ) : (
                "Nothing matches this filter."
              )}
            </PageEmpty>
          ) : (
            <PageRows>
              {shownAccounts.map((item, index) => {
                if (item.kind === "yours") {
                  const entry = item.entry;
                  const connectedAcc = isConnected(entry.key);
                  return (
                    <React.Fragment key={entry.key}>
                      {/* A real link with no children: children passed to `render` replace the row's own. */}
                      <Item
                        data-testid={`account-${entry.key}`}
                        render={
                          <Link
                            params={{ key: entry.key }}
                            to="/settings/connected-accounts/$key"
                          />
                        }
                        size="sm"
                      >
                        <RowMark>
                          <AppMark serverId={entry.key} className="size-4" />
                        </RowMark>
                        <ItemContent>
                          <ItemTitle>{entry.title}</ItemTitle>
                          <ItemDescription>{entry.summary}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <span
                            aria-hidden="true"
                            className={cn(
                              "size-1.5 rounded-full",
                              connectedAcc
                                ? "bg-emerald-500"
                                : "bg-muted-foreground/40",
                            )}
                          />
                          <span className="text-muted-foreground text-xs">
                            {connectedAcc ? "Connected" : "Not connected"}
                          </span>
                          <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </ItemActions>
                      </Item>
                      {index !== shownAccounts.length - 1 && <Separator />}
                    </React.Fragment>
                  );
                }

                const server = item.server;
                const description =
                  server.broker?.description ||
                  "Reached through Composio, which holds the account, so a Bot sees only what you can see.";
                const actionCount = server.broker?.actionCount;
                const connectedAcc = isConnected(server.id);
                return (
                  <React.Fragment key={server.id}>
                    <Item
                      data-testid={`account-${server.id}`}
                      render={
                        <Link
                          params={{ key: server.id }}
                          to="/settings/connected-accounts/$key"
                        />
                      }
                      size="sm"
                    >
                      <RowMark>
                        <AppMark
                          serverId={server.id}
                          logo={server.broker?.logo}
                          className="size-4"
                        />
                      </RowMark>
                      <ItemContent>
                        <ItemTitle>
                          {server.title}
                          {typeof actionCount === "number" &&
                          actionCount > 0 ? (
                            <span className="ml-2 rounded-full border border-border bg-muted/40 px-1.5 py-px align-middle text-[10px] font-medium text-muted-foreground">
                              {actionCount} tools
                            </span>
                          ) : null}
                        </ItemTitle>
                        <ItemDescription>{description}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-1.5 rounded-full",
                            connectedAcc
                              ? "bg-emerald-500"
                              : "bg-muted-foreground/40",
                          )}
                        />
                        <span className="text-muted-foreground text-xs">
                          {connectedAcc ? "Connected" : "Not connected"}
                        </span>
                        <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </ItemActions>
                    </Item>
                    {index !== shownAccounts.length - 1 && <Separator />}
                  </React.Fragment>
                );
              })}
            </PageRows>
          )}
          {!expanded && visibleAccounts.length > FIRST_PAINT_APPS ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-xs text-muted-foreground">
                Showing {FIRST_PAINT_APPS} of{" "}
                {visibleAccounts.length.toLocaleString()} apps — the rest are
                loading in the background.
              </p>
              <Button
                onClick={() => setExpanded(true)}
                size="xs"
                type="button"
                variant="outline"
              >
                Show all now
              </Button>
            </div>
          ) : null}
        </PageSection>
      )}

      {/*
       * THE WORKBENCH, and why it is here rather than among the accounts above.
       *
       * It is not an app and cannot become one: there is no account to consent to and no connector
       * to call, so it has no row in the app table and nothing for the list above to draw. It is a
       * per-person Composio session the server prepares before a run and hands to Bots as the
       * sandbox tools. That makes it genuinely always-on and genuinely yours — and completely
       * invisible, which is the worst of both: a person who has just used it sees no trace of it, and
       * concludes from an empty list that Composio is not connected. So it is stated here, plainly,
       * in the one place somebody looks to answer that question.
       */}
      {plugins.data?.composioConfigured ? (
        <PageSection title="Composio">
          <PageRows>
            <Item size="sm">
              <RowMark>
                <AppMark
                  logo={COMPOSIO_LOGO}
                  alt="Composio"
                  className="size-4"
                />
              </RowMark>
              <ItemContent>
                <ItemTitle>Composio sandbox &amp; workbench</ItemTitle>
                <ItemDescription>
                  A private Composio sandbox prepared for you and shared with
                  your Bots automatically. It needs no account and cannot be
                  disconnected.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-emerald-500"
                />
                <span className="text-muted-foreground text-xs">Always on</span>
              </ItemActions>
            </Item>
          </PageRows>

          {/*
           * THE MISSING SCREEN.
           *
           * Enabling a Composio app is a POST that has existed the whole time with nothing in the
           * browser calling it, so the directory was reachable only by hand and this list could only
           * ever be as long as whatever somebody had added out of band. It is the same directory
           * endpoint the Bot-facing `connect_app` reads, so an app added here and an app a Bot asks
           * for come from one answer.
           */}
          <ComposioAppBrowser />
        </PageSection>
      ) : null}
    </PageShell>
  );
}

/**
 * Composio's directory, searchable, with one button that adds an app.
 *
 * Kept out of the accounts list above because adding an app and connecting an account are different
 * acts: the first makes the app available to this deployment at all, the second is the per-person
 * consent that makes it usable. Collapsing them would offer a person a "connect" button for an app
 * with no auth config behind it, and the failure would surface at the first call rather than here.
 */
function ComposioAppBrowser() {
  const queryClient = useQueryClient();
  const [term, setTerm] = useState("");
  const trimmed = term.trim();
  const directory = useQuery(composioAppsQueryOptions(trimmed));
  const enable = useMutation(enableComposioAppMutationOptions(queryClient));
  const [notice, setNotice] = useState<string | null>(null);
  const [dirExpanded, setDirExpanded] = useState(false);
  const shownComposioApps = dirExpanded ? Number.MAX_SAFE_INTEGER : 40;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Add an app from Composio&apos;s directory. Adding it makes it available
        to your Bots; you connect your own account on its page afterwards.
        All apps are listed below; search to narrow them down.
      </p>

      <div className="relative">
        <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search Composio apps"
          className="pl-9"
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search all Composio apps — gmail, slack, linear…"
          value={term}
        />
      </div>

      {notice ? (
        <p className="text-destructive text-sm" role="alert">
          {notice}
        </p>
      ) : null}

      {directory.error ? (
        <p className="text-destructive text-sm" role="alert">
          Composio&apos;s directory could not be read. Check that this
          deployment has a Composio API key set.
        </p>
      ) : directory.isPending ? (
        <p className="text-muted-foreground text-sm">
          {trimmed.length === 0 ? "Loading apps…" : "Searching…"}
        </p>
      ) : (directory.data?.apps ?? []).length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {trimmed.length === 0
            ? "Composio's directory is empty."
            : `No Composio app matches “${trimmed}”.`}
        </p>
      ) : (
        <PageRows>
          {(directory.data?.apps ?? [])
            .slice(0, shownComposioApps)
            .map((app) => (
            <React.Fragment key={app.slug}>
              <Item size="sm">
                <RowMark>
                  <AppMark
                    serverId={`composio-${app.slug}`}
                    logo={app.logo}
                    className="size-4"
                  />
                </RowMark>
                <ItemContent>
                  <ItemTitle>{app.name}</ItemTitle>
                  <ItemDescription>
                    {app.description || app.slug}
                    {app.actionCount > 0 ? ` · ${app.actionCount} actions` : ""}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {app.enabled ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full bg-emerald-500"
                      />
                      <span className="text-muted-foreground text-xs">
                        Added
                      </span>
                    </>
                  ) : (
                    <Button
                      disabled={enable.isPending}
                      onClick={() => {
                        setNotice(null);
                        enable.mutate(
                          { slug: app.slug },
                          {
                            onSuccess: () => setNotice(null),
                            onError: (error: Error) =>
                              setNotice(
                                `${app.name} could not be added: ${error.message}`,
                              ),
                          },
                        );
                      }}
                      size="xs"
                      type="button"
                      variant="outline"
                    >
                      Add
                    </Button>
                  )}
                </ItemActions>
              </Item>
              <Separator />
            </React.Fragment>
          ))}
        </PageRows>
      )}
      {!dirExpanded && (directory.data?.apps ?? []).length > 40 ? (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Showing the first 40 — type above to reach the rest, or{" "}
          <button
            className="font-medium text-foreground underline underline-offset-4"
            onClick={() => setDirExpanded(true)}
            type="button"
          >
            show all {(directory.data?.apps ?? []).length}
          </button>
          .
        </p>
      ) : null}
    </div>
  );
}
