import {
  IconArrowUpRight,
  IconChevronDown,
  IconPencil,
  IconTag,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { AppMark } from "@/components/plugins/app-mark";
import {
  BrokeredAccountRow,
  useBrokeredAccount,
} from "@/components/plugins/brokered-account-row";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  connectAccountMutationOptions,
  disconnectBrokeredAccountMutationOptions,
  setAccountGrantMutationOptions,
  updateAccountLabelMutationOptions,
} from "@/lib/plugins/mutations";
import {
  type ConnectedAccountDetail,
  connectionsQueryOptions,
  pluginsSlimQueryOptions,
  serverAccountsQueryOptions,
} from "@/lib/plugins/queries";

export const Route = createFileRoute("/_authed/_app/apps/$key")({
  component: RouteComponent,
});

function RouteComponent() {
  const queryClient = useQueryClient();
  const { key } = useParams({
    from: "/_authed/_app/apps/$key",
  });
  const plugins = useQuery(pluginsSlimQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const [notice, setNotice] = useState<string | null>(null);
  const [editingAccount, setEditingAccount] = useState<{
    id: string;
    label: string | null;
  } | null>(null);
  const [tagInput, setTagInput] = useState("");

  const entry = plugins.data?.catalogue.find(
    (item) => item.key === key || `composio-${item.key}` === key,
  );
  const server = (plugins.data?.servers ?? []).find(
    (s) => s.id === key || s.id === `composio-${key}`,
  );
  const realServerId = server?.id ?? key;
  const enabled = server !== undefined;
  const connection = (connections.data?.connections ?? []).find(
    (row) => row.serverId === key || row.serverId === realServerId,
  );
  const brokered = server?.provenance === "composio";

  const accountsQuery = useQuery(serverAccountsQueryOptions(realServerId));
  const agentsQuery = useQuery(agentListQueryOptions());
  const userAgents = (agentsQuery.data ?? []).filter(
    (agent) => !agent.isSystemTemplate,
  );
  const disconnectAccount = useMutation(
    disconnectBrokeredAccountMutationOptions(queryClient),
  );
  const setAccountGrant = useMutation(
    setAccountGrantMutationOptions(queryClient),
  );
  const updateAccountLabel = useMutation(
    updateAccountLabelMutationOptions(queryClient),
  );

  const handleOpenEditTag = (acc: ConnectedAccountDetail) => {
    setEditingAccount({
      id: acc.id,
      label: acc.label,
    });
    setTagInput(acc.label ?? "");
  };

  const handleSaveTag = () => {
    if (!editingAccount) return;
    updateAccountLabel.mutate(
      {
        serverId: realServerId,
        connectionId: editingAccount.id,
        label: tagInput.trim(),
      },
      {
        onSuccess: () => {
          setEditingAccount(null);
        },
      },
    );
  };

  const connect = useMutation({
    ...connectAccountMutationOptions(),
    onError: (thrown: Error) => setNotice(thrown.message),
    onSuccess: (authorizationUrl) => {
      if (authorizationUrl === null) {
        setNotice(
          "The system answered without a consent link, so there was nowhere to send you and nothing was connected. Try again later.",
        );
        return;
      }
      window.location.href = authorizationUrl;
    },
  });

  const brokeredAccount = useBrokeredAccount({
    authScheme: server?.authScheme ?? null,
    brokered,
    configured: plugins.data?.composioConfigured ?? false,
    recorded: connection !== undefined,
    report: setNotice,
    returnTo: "settings",
    serverId: key,
    verified: connection?.verified ?? false,
    verifiedAt: connection?.verifiedAt ?? null,
    probe: connection?.probe,
    checkable: connection?.checkable ?? false,
  });

  if (plugins.isPending || connections.isPending) {
    return <PageShell title="Account">{null}</PageShell>;
  }

  const back = {
    label: "Apps",
    linkProps: { to: "/apps" as const },
  };

  if (connections.error) {
    return (
      <PageShell backButton={back} title={server?.title ?? key}>
        <p className="mt-12 text-destructive text-sm" role="alert">
          Whether you have connected this account could not be loaded. Reload
          the page or try again later.
        </p>
      </PageShell>
    );
  }

  if (accountsQuery.error) {
    return (
      <PageShell backButton={back} title={server?.title ?? key}>
        <p className="mt-12 text-destructive text-sm" role="alert">
          Connected accounts could not be loaded. Reload the page or try again
          later.
        </p>
      </PageShell>
    );
  }

  if (brokered && server) {
    const reassurance = "No Bot can read this as you.";
    const accounts = accountsQuery.data?.accounts ?? [];

    return (
      <PageShell
        backButton={back}
        description={
          server.broker?.description ||
          "Reached through Composio, which holds the account, so a Bot sees only what you can see."
        }
        icon={
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/60">
            <AppMark
              serverId={key}
              logo={server.broker?.logo}
              className="size-5 text-primary"
            />
          </div>
        }
        title={server.title}
      >
        {notice ? (
          <p className="text-destructive text-sm" role="alert">
            {notice}
          </p>
        ) : null}

        {accounts.length > 0 ? (
          <PageSection>
            <div className="flex items-center justify-between gap-4 pb-2">
              <div>
                <h2 className="text-base font-medium text-foreground">
                  Connected Accounts ({accounts.length})
                </h2>
                <p className="text-xs text-muted-foreground">
                  Manage your connected accounts for {server.title} and assign
                  coworker permissions.
                </p>
              </div>
              <Button
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => brokeredAccount.connect()}
              >
                + Connect another account
              </Button>
            </div>

            <div className="flex flex-col gap-3 pt-2">
              {accounts.map((acc) => {
                const displayLabel =
                  acc.label ||
                  (acc.accountId
                    ? `Account (${acc.accountId.slice(0, 8)})`
                    : `Account (${acc.id.slice(0, 8)})`);
                const isDisconnecting =
                  disconnectAccount.isPending &&
                  disconnectAccount.variables?.connectionId === acc.id;

                return (
                  <div
                    key={acc.id}
                    className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-xs shadow-xs"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/60">
                          <AppMark
                            serverId={key}
                            logo={server.broker?.logo}
                            className="size-5 text-primary"
                          />
                        </div>
                        <div className="flex flex-col gap-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            {acc.label ? (
                              <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
                                <IconTag className="size-3 shrink-0" />
                                <span className="truncate max-w-[200px]">
                                  {acc.label}
                                </span>
                              </span>
                            ) : (
                              <span className="text-sm font-medium text-foreground">
                                {acc.accountId
                                  ? `Account (${acc.accountId.slice(0, 8)})`
                                  : `Account (${acc.id.slice(0, 8)})`}
                              </span>
                            )}
                            <Button
                              size="xs"
                              variant="ghost"
                              className="px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                              onClick={() => handleOpenEditTag(acc)}
                            >
                              <IconPencil data-icon="inline-start" />
                              {acc.label ? "Edit tag" : "+ Add tag"}
                            </Button>
                          </div>

                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            {acc.label && (
                              <span>
                                ID:{" "}
                                {acc.accountId
                                  ? acc.accountId.slice(0, 8)
                                  : acc.id.slice(0, 8)}{" "}
                                •
                              </span>
                            )}
                            <span>
                              Connected{" "}
                              {acc.connectedAt
                                ? new Date(acc.connectedAt).toLocaleDateString()
                                : ""}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {acc.verified ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                            <span className="size-1.5 rounded-full bg-emerald-500" />
                            Verified
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                            Connected
                          </span>
                        )}

                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs text-destructive hover:bg-destructive/10"
                          disabled={isDisconnecting}
                          onClick={() => {
                            if (confirm(`Disconnect ${displayLabel}?`)) {
                              disconnectAccount.mutate({
                                serverId: realServerId,
                                connectionId: acc.id,
                              });
                            }
                          }}
                        >
                          {isDisconnecting ? "Disconnecting…" : "Disconnect"}
                        </Button>
                      </div>
                    </div>

                    <Separator />

                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                          Coworker access ({acc.grantedAgents.length})
                        </span>

                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                size="xs"
                                variant="ghost"
                                className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                              >
                                + Grant coworker
                                <IconChevronDown data-icon="inline-end" />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="end" className="w-56">
                            {userAgents.length === 0 ? (
                              <p className="p-2 text-center text-xs text-muted-foreground">
                                No coworkers found
                              </p>
                            ) : (
                              userAgents.map((agent) => {
                                const hasAccess = acc.grantedAgents.some(
                                  (g) => g.id === agent.id,
                                );
                                return (
                                  <DropdownMenuItem
                                    key={agent.id}
                                    className="flex items-center justify-between text-xs cursor-pointer"
                                    onClick={() => {
                                      setAccountGrant.mutate({
                                        serverId: realServerId,
                                        connectionId: acc.id,
                                        agentId: agent.id,
                                        granted: !hasAccess,
                                      });
                                    }}
                                  >
                                    <span className="truncate">
                                      {agent.name}
                                    </span>
                                    {hasAccess ? (
                                      <span className="text-emerald-600 font-medium text-[11px]">
                                        Granted
                                      </span>
                                    ) : (
                                      <span className="text-muted-foreground text-[11px]">
                                        Add
                                      </span>
                                    )}
                                  </DropdownMenuItem>
                                );
                              })
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>

                      {acc.grantedAgents.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground">
                          No coworkers have been granted access to this account
                          yet. Click "+ Grant coworker" to allow bots to use
                          this account.
                        </p>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {acc.grantedAgents.map((bot) => (
                            <span
                              key={bot.id}
                              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-1 text-xs text-foreground"
                            >
                              <span>{bot.name}</span>
                              {/* The primitive, not a bare `<button>`: a raw button here gets no focus ring, no
                                disabled treatment and no hit-area padding, and a 12px glyph in a
                                padded <span> chip left it barely clickable. */}
                              <Button
                                aria-label={`Revoke ${bot.name}'s access to this account`}
                                className="-mr-1 text-muted-foreground hover:text-destructive"
                                onClick={() => {
                                  setAccountGrant.mutate({
                                    serverId: realServerId,
                                    connectionId: acc.id,
                                    agentId: bot.id,
                                    granted: false,
                                  });
                                }}
                                size="icon-xs"
                                title={`Revoke ${bot.name}'s access to this account`}
                                type="button"
                                variant="ghost"
                              >
                                <IconX />
                              </Button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </PageSection>
        ) : (
          <PageSection>
            <PageRows className="mt-0">
              <BrokeredAccountRow
                account={brokeredAccount}
                connectedDescription={`A Bot granted its tools reads your ${server.title} as you. Disconnecting ends the account at Composio, not just here.`}
                disconnectedDescription={`${reassurance} Connecting takes you to Composio and then to the vendor to consent.`}
                disconnectedReassurance={reassurance}
                title={server.title}
              />
            </PageRows>
          </PageSection>
        )}

        <Dialog
          open={editingAccount !== null}
          onOpenChange={(open) => {
            if (!open) setEditingAccount(null);
          }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Tag Connected Account</DialogTitle>
              <p className="text-xs text-muted-foreground">
                Set a custom tag (e.g. Work Email, Personal, Support) to easily
                identify which account is what for and grant permissions to bots
                accordingly.
              </p>
            </DialogHeader>

            <DialogBody className="gap-3 py-1">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor={`account-tag-${editingAccount?.id ?? "new"}`}
                  className="text-xs font-medium text-foreground"
                >
                  Account Tag / Label
                </label>
                <Input
                  id={`account-tag-${editingAccount?.id ?? "new"}`}
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  placeholder="e.g. Work Email, Personal Gmail, Support Inbox"
                  maxLength={50}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSaveTag();
                    }
                  }}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] text-muted-foreground">
                  Quick suggestions:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    "Work",
                    "Personal",
                    "Support",
                    "Marketing",
                    "Primary",
                    "Testing",
                  ].map((suggestion) => (
                    <Button
                      key={suggestion}
                      type="button"
                      onClick={() => setTagInput(suggestion)}
                      className="rounded-full border-border bg-muted/50 px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                      size="xs"
                      variant="outline"
                    >
                      {suggestion}
                    </Button>
                  ))}
                </div>
              </div>
            </DialogBody>

            <DialogFooter className="gap-2 sm:justify-end">
              <DialogClose
                render={
                  <Button variant="outline" size="sm">
                    Cancel
                  </Button>
                }
              />
              <Button
                size="sm"
                disabled={updateAccountLabel.isPending}
                onClick={handleSaveTag}
              >
                {updateAccountLabel.isPending ? "Saving…" : "Save Tag"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </PageShell>
    );
  }

  if (entry?.auth !== "user-oauth") {
    return (
      <PageShell
        backButton={back}
        description="This is not a service you connect for yourself."
        title={entry?.title ?? key}
      >
        <PageEmpty>
          {entry
            ? "A Bot reaches this one with a credential the deployment holds, the same for everybody."
            : "This deployment has no connector by that name."}
        </PageEmpty>
      </PageShell>
    );
  }

  return (
    <PageShell
      backButton={back}
      description={entry.summary}
      icon={
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/60">
          <AppMark serverId={key} className="size-5 text-primary" />
        </div>
      }
      title={entry.title}
    >
      {notice ? (
        <p className="text-destructive text-sm" role="alert">
          {notice}
        </p>
      ) : null}

      <PageSection>
        <PageRows className="mt-0">
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Your account</ItemTitle>
              <ItemDescription>
                {!enabled
                  ? "This connector is not enabled, so there is nothing to connect to yet."
                  : connection
                    ? "A Bot granted its tools reads this as you, and sees only what you can see."
                    : "No Bot can read this as you. Connecting takes you to the vendor to consent."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {connection ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button size="sm" type="button" variant="outline">
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-emerald-500"
                        />
                        Connected
                        <IconChevronDown />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" className="w-auto">
                    <DropdownMenuItem
                      onClick={() =>
                        setNotice(
                          `Disconnecting is not built yet. Until it is, revoke it in your ${entry.vendor} account's third-party access settings — that stops this deployment reading anything immediately.`,
                        )
                      }
                      className="whitespace-nowrap"
                      variant="destructive"
                    >
                      Disconnect your {entry.title} account
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button
                  disabled={!enabled || connect.isPending}
                  onClick={() => {
                    setNotice(null);
                    connect.mutate(key);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Connect
                  <IconArrowUpRight />
                </Button>
              )}
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      {connection ? (
        <PageSection
          description="What you agreed to, as the vendor recorded it — not what was asked for. The two differ when a consent screen is only partly accepted."
          title="Access"
        >
          <PageRows>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Granted</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {connection.scope || "The vendor named no scope."}
                </ItemDescription>
              </ItemContent>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Connected</ItemTitle>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-xs">
                  {new Date(connection.connectedAt).toLocaleString()}
                </span>
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
    </PageShell>
  );
}
