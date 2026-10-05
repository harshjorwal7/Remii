import {
  IconChevronDown,
  IconChevronRight,
  IconSearch,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AppMark } from "@/components/plugins/app-mark";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  setAccountGrantMutationOptions,
  setPluginGrantMutationOptions,
  setServerAppGrantMutationOptions,
} from "@/lib/plugins/mutations";
import {
  agentPluginsQueryOptions,
  connectionsQueryOptions,
  pluginsSlimQueryOptions,
  serverAccountsQueryOptions,
  serverToolsQueryOptions,
} from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";
import {
  appMatchesCategory,
  CONNECTED_ACCOUNT_CATEGORIES,
  type ConnectedAccountCategory,
} from "@/routes/_authed/settings/connected-accounts/index";

/**
 * Details, connected account toggles, and individual action toggles for one specific server.
 */
function ServerToolsDetails({
  serverId,
  agentId,
  isBrokered,
}: {
  serverId: string;
  agentId: string;
  isBrokered?: boolean;
}) {
  const queryClient = useQueryClient();
  const toolsQuery = useQuery(serverToolsQueryOptions(serverId));
  const accountsQuery = useQuery({
    ...serverAccountsQueryOptions(serverId),
    enabled: Boolean(isBrokered),
  });
  const setPluginGrant = useMutation(
    setPluginGrantMutationOptions(queryClient),
  );
  const setAccountGrant = useMutation(
    setAccountGrantMutationOptions(queryClient),
  );

  const tools = toolsQuery.data?.tools ?? [];

  return (
    <div className="flex flex-col gap-3 rounded-b-md border-l-2 border-primary/20 bg-muted/15 p-3 pl-4">
      {/* Brokered accounts section */}
      {isBrokered ? (
        <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/60 p-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Connected Accounts ({accountsQuery.data?.accounts?.length ?? 0})
            </p>
            <span className="text-[10px] text-muted-foreground">
              Choose which account this agent can access
            </span>
          </div>

          {accountsQuery.isPending ? (
            <div className="flex flex-col gap-2 py-1">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-3/4" />
            </div>
          ) : accountsQuery.error ? (
            <p className="text-xs text-destructive">
              Could not load accounts for this app.
            </p>
          ) : (accountsQuery.data?.accounts ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No accounts connected yet. Connect an account in{" "}
              <a
                href="/settings/connected-accounts"
                className="underline hover:text-foreground"
              >
                Connected Accounts
              </a>{" "}
              or ask the bot in chat.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {accountsQuery.data?.accounts.map((acc) => {
                const isAccountGranted = acc.grantedAgents.some(
                  (a) => a.id === agentId,
                );
                const isPending =
                  setAccountGrant.isPending &&
                  setAccountGrant.variables?.connectionId === acc.id;
                const displayLabel =
                  acc.label ||
                  (acc.accountId
                    ? `Account (${acc.accountId.slice(0, 8)})`
                    : `Account (${acc.id.slice(0, 8)})`);

                return (
                  <div
                    key={acc.id}
                    className="flex items-center justify-between gap-3 rounded border border-border/60 bg-background/80 p-2 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate font-medium text-foreground">
                        {displayLabel}
                      </span>
                      {acc.verified ? (
                        <span className="rounded bg-emerald-500/10 px-1 py-0.5 text-[9px] font-medium text-emerald-600 dark:text-emerald-400">
                          verified
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[10px] text-muted-foreground">
                        {isAccountGranted ? "Allowed" : "Dismissed"}
                      </span>
                      <Switch
                        size="sm"
                        checked={isAccountGranted}
                        disabled={isPending}
                        onCheckedChange={(next) => {
                          setAccountGrant.mutate({
                            serverId,
                            connectionId: acc.id,
                            agentId,
                            granted: next,
                          });
                        }}
                        aria-label={`Allow access to ${displayLabel}`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* Tools / Actions section */}
      {toolsQuery.isPending ? (
        <div className="flex flex-col gap-2 py-1">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      ) : toolsQuery.error || !toolsQuery.data ? (
        <p className="text-xs text-destructive">
          Could not load actions for this app.
        </p>
      ) : tools.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This app has no actions available.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Actions ({tools.length})
          </p>
          <div className="flex max-h-[220px] flex-col gap-1.5 overflow-y-auto pr-1">
            {tools.map((tool) => {
              const isToolHeld = tool.grantedTo.includes(agentId);
              const isPending =
                setPluginGrant.isPending &&
                setPluginGrant.variables?.ref === tool.ref;

              return (
                <div
                  key={tool.ref}
                  className="flex items-center justify-between gap-3 rounded border border-border/60 bg-background/80 p-2 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-[11px] font-medium text-foreground">
                        {tool.name}
                      </span>
                      <span
                        className={cn(
                          "rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider",
                          // `dark:` on both, matching the emerald chip above: at 500 on a dark
                          // surface these washed out to near-invisible.
                          tool.effect === "read"
                            ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                            : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                        )}
                      >
                        {tool.effect}
                      </span>
                      {tool.destructive ? (
                        <span className="rounded bg-destructive/10 px-1 py-0.5 text-[9px] font-medium text-destructive">
                          destructive
                        </span>
                      ) : null}
                    </div>
                    {tool.description ? (
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {tool.description}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">
                      {isToolHeld ? "Allowed" : "Dismissed"}
                    </span>
                    <Switch
                      size="sm"
                      checked={isToolHeld}
                      disabled={isPending}
                      onCheckedChange={(next) => {
                        setPluginGrant.mutate({
                          kind: "mcp",
                          ref: tool.ref,
                          agentId,
                          granted: next,
                        });
                      }}
                      aria-label={`Allow ${tool.name}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Manage which apps and services this coworker can access through Composio and connected tools.
 * Users can allow or dismiss access for the bot.
 */
export function ConnectionSection({
  agentId,
}: {
  agentId: string;
  profile: AgentProfile;
}) {
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsSlimQueryOptions());
  const agentPlugins = useQuery(agentPluginsQueryOptions(agentId));
  const connections = useQuery(connectionsQueryOptions());
  /*
   * Any of the three failing is the same failure to the person reading this tab: the list they are
   * looking at is not the list that exists.
   */
  const connectionsFailed =
    plugins.isError || agentPlugins.isError || connections.isError;
  const setAppGrant = useMutation(
    setServerAppGrantMutationOptions(queryClient),
  );

  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] =
    useState<ConnectedAccountCategory>("all");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "allowed" | "dismissed"
  >("all");
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null);
  const [displayLimit, setDisplayLimit] = useState(30);

  const grantedRefs = useMemo(() => {
    return new Set((agentPlugins.data?.tools ?? []).map((t) => t.ref));
  }, [agentPlugins.data?.tools]);

  const connectedServerKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const c of connections.data?.connections ?? []) {
      keys.add(c.serverId);
      keys.add(c.serverId.replace(/^composio-/, ""));
    }
    return keys;
  }, [connections.data?.connections]);

  const allServers = useMemo(() => {
    const servers = plugins.data?.servers ?? [];
    return servers.filter((server) => {
      // Non-composio / custom MCP servers are always kept
      if (server.provenance !== "composio") return true;

      // Keep if the agent already has any tool grants for this server
      const prefix = `${server.id}/`;
      for (const ref of grantedRefs) {
        if (ref.startsWith(prefix)) return true;
      }

      // Only include Composio apps that the user has actually connected
      const rawSlug = server.id.replace(/^composio-/, "");
      return (
        connectedServerKeys.has(server.id) || connectedServerKeys.has(rawSlug)
      );
    });
  }, [plugins.data?.servers, grantedRefs, connectedServerKeys]);

  // Summary counts
  const { allowedCount, totalCount } = useMemo(() => {
    let allowed = 0;
    for (const server of allServers) {
      const prefix = `${server.id}/`;
      for (const ref of grantedRefs) {
        if (ref.startsWith(prefix)) {
          allowed++;
          break;
        }
      }
    }
    return { allowedCount: allowed, totalCount: allServers.length };
  }, [allServers, grantedRefs]);

  // Filtered servers
  const filteredServers = useMemo(() => {
    const term = search.trim().toLowerCase();
    return allServers.filter((server) => {
      const prefix = `${server.id}/`;
      let grantedForServer = 0;
      for (const ref of grantedRefs) {
        if (ref.startsWith(prefix)) grantedForServer++;
      }
      const isAllowed = grantedForServer > 0;

      if (statusFilter === "allowed" && !isAllowed) return false;
      if (statusFilter === "dismissed" && isAllowed) return false;

      const matchesSearch =
        term.length === 0 ||
        [
          server.title,
          server.id,
          server.broker?.description ?? "",
          server.vendor ?? "",
        ].some((field) => field.toLowerCase().includes(term));
      if (!matchesSearch) return false;

      return appMatchesCategory(
        selectedCategory,
        server.title,
        server.id,
        server.broker?.description,
        server.vendor,
        server.broker?.categories,
      );
    });
  }, [allServers, search, selectedCategory, statusFilter, grantedRefs]);

  const visibleServers = useMemo(
    () => filteredServers.slice(0, displayLimit),
    [filteredServers, displayLimit],
  );

  if (plugins.isPending || agentPlugins.isPending || connections.isPending) {
    return (
      <div className="flex flex-col gap-3 py-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  /*
   * A FAILED READ IS NOT "NO CONNECTED APPS".
   *
   * `allServers` is derived from `plugins.data?.servers ?? []`, so any of these three reads failing
   * made the empty state render for a person with Gmail and Slack connected — along with the call
   * to action to go and connect accounts they had already connected. The state below is the truth
   * in that case, and `data === undefined` is what separates "we could not ask" from "we asked and
   * it was empty".
   */
  if (connectionsFailed && plugins.data === undefined) {
    return (
      <p className="text-muted-foreground py-2 text-sm" role="alert">
        Your connected apps could not be loaded. Reload to try again.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm text-muted-foreground">
          Control which connected apps this coworker can access. Allowed apps
          can be used by this agent; dismissed apps are blocked from use. You
          can connect more apps in{" "}
          <Link
            to="/settings/connected-accounts"
            className="text-foreground underline underline-offset-4 hover:text-primary"
          >
            Connected Accounts
          </Link>{" "}
          or directly in chat.
        </p>
      </div>

      {/* Search & Filter Controls (only when there are connected apps) */}
      {allServers.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          <div className="relative">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search apps"
              className="pl-9"
              onChange={(event) => {
                setSearch(event.target.value);
                setDisplayLimit(30);
              }}
              placeholder={`Search ${totalCount.toLocaleString()} connected app${totalCount === 1 ? "" : "s"}…`}
              value={search}
            />
          </div>

          {/* Status filter tabs */}
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant={statusFilter === "all" ? "default" : "outline"}
              className="text-xs"
              onClick={() => {
                setStatusFilter("all");
                setDisplayLimit(30);
              }}
            >
              All ({totalCount})
            </Button>
            <Button
              size="sm"
              variant={statusFilter === "allowed" ? "default" : "outline"}
              className={cn(
                "text-xs",
                statusFilter === "allowed"
                  ? "bg-emerald-600 text-white hover:bg-emerald-700"
                  : "",
              )}
              onClick={() => {
                setStatusFilter("allowed");
                setDisplayLimit(30);
              }}
            >
              Allowed ({allowedCount})
            </Button>
            <Button
              size="sm"
              variant={statusFilter === "dismissed" ? "default" : "outline"}
              className="text-xs"
              onClick={() => {
                setStatusFilter("dismissed");
                setDisplayLimit(30);
              }}
            >
              Dismissed ({totalCount - allowedCount})
            </Button>
          </div>

          {/* Category filter pills */}
          <fieldset className="flex flex-wrap items-center gap-1">
            <legend className="sr-only">Filter by category</legend>
            {CONNECTED_ACCOUNT_CATEGORIES.map((cat) => {
              const isSelected = selectedCategory === cat.id;
              return (
                <Button
                  key={cat.id}
                  aria-pressed={isSelected}
                  size="xs"
                  variant={isSelected ? "secondary" : "ghost"}
                  className={cn(
                    "rounded-full px-2.5 text-[11px]",
                    isSelected
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => {
                    setSelectedCategory(cat.id);
                    setDisplayLimit(30);
                  }}
                >
                  {cat.label}
                </Button>
              );
            })}
          </fieldset>
        </div>
      ) : null}

      {/* App List */}
      {allServers.length === 0 ? (
        <Empty className="h-[200px] border border-dashed">
          <EmptyHeader>
            <EmptyTitle className="text-muted-foreground">
              No connected apps yet
            </EmptyTitle>
            <EmptyDescription>
              Connect your accounts (like Gmail, Slack, GitHub) in Connected
              Accounts or ask this agent in chat to connect an app. Once
              connected, you can allow or dismiss access here.
            </EmptyDescription>
          </EmptyHeader>
          <div className="mt-3 flex justify-center">
            {/* `<Button render={<Link/>}>`, not `buttonVariants()` applied to a raw `Link`: the direct recipe
              call skips the primitive's own wrapper, and with it the `nativeButton` default that
              `button.tsx` documents. Drawing an anchor through `render` is the case that default
              exists for. */}
            <Button
              render={<Link to="/settings/connected-accounts" />}
              size="sm"
              variant="outline"
            >
              Go to Connected Accounts
            </Button>
          </div>
        </Empty>
      ) : filteredServers.length === 0 ? (
        <Empty className="h-[160px] border border-dashed">
          <EmptyHeader>
            <EmptyTitle className="text-muted-foreground">
              No apps found
            </EmptyTitle>
            <EmptyDescription>
              No connected apps match your search or filter criteria.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {visibleServers.map((server) => {
            const prefix = `${server.id}/`;
            let serverGrantCount = 0;
            for (const ref of grantedRefs) {
              if (ref.startsWith(prefix)) serverGrantCount++;
            }
            const isAllowed = serverGrantCount > 0;
            const isPending =
              setAppGrant.isPending &&
              setAppGrant.variables?.serverId === server.id;
            const isExpanded = expandedServerId === server.id;
            const logo = server.broker?.logo;
            const actionCount = server.broker?.actionCount;

            return (
              <div
                key={server.id}
                className={cn(
                  "flex flex-col rounded-lg border transition-colors",
                  isAllowed
                    ? "border-border bg-card/60"
                    : "border-border/60 bg-muted/20 opacity-85",
                )}
              >
                <Item variant="default" size="sm" className="border-0">
                  <ItemMedia variant="icon">
                    {/* No `size-5`: `ItemMedia variant="icon"` already sizes its mark to
                        `size-4`, and this override made it the one media tile in the app a step
                        larger than the rows it sits beside. */}
                    <AppMark
                      serverId={server.id}
                      logo={logo}
                      className="text-muted-foreground"
                    />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle className="gap-2">
                      <span>{server.title}</span>
                      {typeof actionCount === "number" && actionCount > 0 ? (
                        <span className="rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {actionCount} tools
                        </span>
                      ) : null}
                    </ItemTitle>
                    <ItemDescription>
                      {server.broker?.description ||
                        server.summary ||
                        "App integration through Composio."}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions className="gap-2">
                    {/* Allow / Dismiss Button */}
                    <Button
                      size="sm"
                      variant={isAllowed ? "outline" : "default"}
                      className={cn(
                        "px-3 text-xs font-medium transition-colors",
                        isAllowed
                          ? "text-muted-foreground hover:border-destructive/40 hover:text-destructive"
                          : "bg-emerald-600 text-white hover:bg-emerald-700",
                      )}
                      disabled={isPending}
                      onClick={() => {
                        setAppGrant.mutate({
                          serverId: server.id,
                          agentId,
                          granted: !isAllowed,
                        });
                      }}
                    >
                      {isPending
                        ? isAllowed
                          ? "Dismissing…"
                          : "Allowing…"
                        : isAllowed
                          ? "Dismiss"
                          : "Allow"}
                    </Button>

                    {/* Expand/Collapse Chevron */}
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="text-muted-foreground"
                      onClick={() =>
                        setExpandedServerId((prev) =>
                          prev === server.id ? null : server.id,
                        )
                      }
                      aria-label={`Toggle actions for ${server.title}`}
                    >
                      {isExpanded ? <IconChevronDown /> : <IconChevronRight />}
                    </Button>
                  </ItemActions>
                </Item>

                {/* Expanded Action List */}
                {isExpanded ? (
                  <ServerToolsDetails
                    serverId={server.id}
                    agentId={agentId}
                    isBrokered={server.provenance === "composio"}
                  />
                ) : null}
              </div>
            );
          })}

          {/* Pagination limit / show more */}
          {filteredServers.length > displayLimit ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-2 w-full text-xs text-muted-foreground"
              onClick={() => setDisplayLimit((prev) => prev + 30)}
            >
              Show more apps ({filteredServers.length - displayLimit} remaining)
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
