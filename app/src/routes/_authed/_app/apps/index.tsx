import { IconChevronRight, IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
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
import { AppMark } from "@/components/plugins/app-mark";
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
import {
  connectionsQueryOptions,
  pluginsSlimQueryOptions,
} from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";
import {
  appMatchesCategory,
  brokeredAccountsListedOn,
  CONNECTED_ACCOUNT_CATEGORIES,
  type ConnectedAccountCategory,
  sortConnectedFirst,
} from "@/routes/_authed/settings/connected-accounts/index";

export const Route = createFileRoute("/_authed/_app/apps/")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): { connected?: string } =>
    typeof search.connected === "string" ? { connected: search.connected } : {},
});

const FIRST_PAINT_APPS = 50;

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

  const yours = (plugins.data?.catalogue ?? []).filter(
    (entry) => entry.auth === "user-oauth" && added.has(entry.key),
  );

  const brokered = brokeredAccountsListedOn(plugins.data?.servers ?? []);

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
      title="Apps"
    >
      {outcome === "failed" ? (
        <p className="text-destructive text-sm" role="alert">
          That account could not be connected. Nothing was saved — try again.
        </p>
      ) : null}
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

              {/*
               * A `div` with `role="group"` and an `aria-label` is a `fieldset` and a `legend`
               * spelled the long way round. Spelled the short way, the group's name is announced as
               * a caption, so a screen reader reading the filter buttons out one at a time says what
               * each one is rather than what they belong to.
               */}
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
            <PageEmpty>
              {term.length > 0 || selectedCategory !== "all"
                ? `No apps match your filter criteria.`
                : "Nothing to connect yet. Add one from Settings → App connections, and it appears here."}
            </PageEmpty>
          ) : (
            <PageRows>
              {shownAccounts.map((item, index) => {
                if (item.kind === "yours") {
                  const entry = item.entry;
                  const connectedAcc = isConnected(entry.key);
                  return (
                    <React.Fragment key={entry.key}>
                      <Item
                        data-testid={`account-${entry.key}`}
                        render={
                          <Link params={{ key: entry.key }} to="/apps/$key" />
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
                        <Link params={{ key: server.id }} to="/apps/$key" />
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
            <div className="py-2 text-center text-xs text-muted-foreground">
              Loading remaining apps…
            </div>
          ) : null}
        </PageSection>
      )}
    </PageShell>
  );
}
