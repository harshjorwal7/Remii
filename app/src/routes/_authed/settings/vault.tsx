import {
  IconCopy,
  IconCreditCard,
  IconId,
  IconKey,
  IconLock,
  IconPlus,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { VaultAgentItemDialog } from "@/components/vault/agent-item-dialog";
import { VaultCardDialog } from "@/components/vault/card-dialog";
import { VaultLoginDialog } from "@/components/vault/login-dialog";
import { VaultPersonalInfoDialog } from "@/components/vault/personal-info-dialog";
import { VaultDeleteDialog } from "@/components/vault/vault-delete-dialog";
import { VaultItemMenu } from "@/components/vault/vault-item-menu";
import { relativeTime } from "@/lib/relative-time";
import { VAULT_AGENT_ITEM_KIND_LABELS } from "@/lib/vault/form";
import {
  deleteVaultAgentItemMutationOptions,
  deleteVaultCardMutationOptions,
  deleteVaultLoginMutationOptions,
} from "@/lib/vault/mutations";
import type {
  VaultAgentItem,
  VaultCard,
  VaultLogin,
  VaultPersonalInfo,
} from "@/lib/vault/queries";
import { vaultQueryOptions } from "@/lib/vault/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/vault")({
  component: RouteComponent,
});

/**
 * Your vault: what your coworker may use while working for you.
 *
 * FOUR SECTIONS AND NOTHING ELSE, each with its own add button in its heading, which is the shape the
 * screen is asked for and the shape these settings pages use for everything else — a heading, an
 * action on its baseline, and a card of rows or a sentence saying there is nothing yet.
 *
 * NO SECRET IS EVER DRAWN ON THIS PAGE. Every row shows a mask, the copy actions fetch the value for
 * one clipboard write and let it go, and the edit dialogs open their secret boxes empty because the
 * stored value is not sent to the browser at all. That is not a styling decision — it is the reason
 * this page can be left open.
 */
function RouteComponent() {
  const vault = useQuery(vaultQueryOptions());
  const [adding, setAdding] = React.useState<
    "login" | "card" | "agent-item" | "personal-info" | null
  >(null);
  const [editing, setEditing] = React.useState<
    | { kind: "login"; item: VaultLogin }
    | { kind: "card"; item: VaultCard }
    | { kind: "agent-item"; item: VaultAgentItem }
    | { kind: "personal-info"; item: VaultPersonalInfo }
    | null
  >(null);
  const [removing, setRemoving] = React.useState<
    | { kind: "login"; item: VaultLogin }
    | { kind: "card"; item: VaultCard }
    | { kind: "agent-item"; item: VaultAgentItem }
    | null
  >(null);
  /**
   * ONE LINE OF TEXT for a refused copy, and which section it belongs under.
   *
   * There is no toast in this app (`app-sidebar/channel.tsx` records why), so a refusal with nowhere to
   * go either disappears or blocks the screen. This is the somewhere, and it carries its section
   * because a failure to copy a card is not a message about the Login section. Never a success
   * message: a copy that works says so on the menu item that was clicked.
   */
  const [status, setStatus] = React.useState<{
    section: "logins" | "cards" | "agent-items";
    message: string;
  } | null>(null);

  const removeLogin = useMutation(deleteVaultLoginMutationOptions(queryClient));
  const removeCard = useMutation(deleteVaultCardMutationOptions(queryClient));
  const removeItem = useMutation(
    deleteVaultAgentItemMutationOptions(queryClient),
  );

  /**
   * The mutation the delete dialog's button is waiting on.
   *
   * Derived from `removing` rather than tracked separately, so the button can never be showing
   * "Deleting…" for one row while the dialog is open over another.
   */
  const deleting = removing
    ? removing.kind === "login"
      ? removeLogin
      : removing.kind === "card"
        ? removeCard
        : removeItem
    : null;

  const deleteError =
    deleting?.error instanceof Error ? deleting.error.message : null;

  const confirmRemove = () => {
    if (!removing) return;
    /* Left open on a failure so the server's sentence has somewhere to be read. */
    const done = {
      onSuccess: () => setRemoving(null),
      onError: () => undefined,
    };
    if (removing.kind === "login") removeLogin.mutate(removing.item.id, done);
    else if (removing.kind === "card")
      removeCard.mutate(removing.item.id, done);
    else removeItem.mutate(removing.item.id, done);
  };

  /* The four-way branching the data-access skill asks for, in the order it asks for it. */
  const state = vault.isPending
    ? null
    : vault.error
      ? { error: vault.error.message }
      : {
          logins: vault.data?.logins ?? [],
          cards: vault.data?.cards ?? [],
          personalInfo: vault.data?.personalInfo ?? null,
          agentItems: vault.data?.agentItems ?? [],
        };

  return (
    <PageShell
      description="Saved information your coworker can use while working for you. It stays in your vault, and it is only handed over when a task calls for it."
      title="Vault"
    >
      {state === null ? null : "error" in state ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          {state.error}
        </p>
      ) : (
        <>
          {/* Logins. --------------------------------------------------------------------- */}
          <PageSection
            action={
              <Button
                aria-label="Add login"
                onClick={() => {
                  setStatus(null);
                  setAdding("login");
                }}
                size="sm"
                variant="outline"
              >
                <IconPlus />
                Add
              </Button>
            }
            title="Logins"
          >
            {status?.section === "logins" ? (
              <StatusLine message={status.message} />
            ) : null}
            {state.logins.length === 0 ? (
              <PageEmpty>No logins saved.</PageEmpty>
            ) : (
              <PageRows>
                {state.logins.map((login, index, all) => (
                  <React.Fragment key={login.id}>
                    <Item size="sm">
                      <ItemMedia variant="icon">
                        <IconLock className="text-muted-foreground" />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle className="font-normal">
                          {login.label}
                        </ItemTitle>
                        <ItemDescription>
                          {login.username}
                          {login.websiteUrl ? ` · ${login.websiteUrl}` : ""}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <VaultItemMenu
                          actions={[
                            { label: "Copy username", icon: IconCopy },
                            { label: "Copy password", icon: IconCopy },
                          ]}
                          editLabel="Edit"
                          itemId={login.id}
                          itemLabel={login.label}
                          onDelete={() =>
                            setRemoving({ kind: "login", item: login })
                          }
                          onEdit={() =>
                            setEditing({ kind: "login", item: login })
                          }
                          onStatus={(message) =>
                            setStatus(
                              message ? { section: "logins", message } : null,
                            )
                          }
                          section="logins"
                        />
                      </ItemActions>
                    </Item>
                    {index !== all.length - 1 ? <Separator /> : null}
                  </React.Fragment>
                ))}
              </PageRows>
            )}
          </PageSection>

          {/* Cards. ---------------------------------------------------------------------- */}
          <PageSection
            action={
              <Button
                aria-label="Add card"
                onClick={() => setAdding("card")}
                size="sm"
                variant="outline"
              >
                <IconPlus />
                Add
              </Button>
            }
            title="Cards"
          >
            {status?.section === "cards" ? (
              <StatusLine message={status.message} />
            ) : null}
            {state.cards.length === 0 ? (
              <PageEmpty>No cards saved.</PageEmpty>
            ) : (
              <PageRows>
                {state.cards.map((card, index, all) => (
                  <React.Fragment key={card.id}>
                    <Item size="sm">
                      <ItemMedia variant="icon">
                        <IconCreditCard className="text-muted-foreground" />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle className="font-normal">
                          {card.label}
                        </ItemTitle>
                        <ItemDescription>
                          {card.maskedNumber}
                          {card.expiry ? ` · ${card.expiry}` : ""}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <VaultItemMenu
                          actions={[
                            {
                              label: "Copy card number",
                              icon: IconCopy,
                              field: "number",
                            },
                            {
                              label: "Copy expiry",
                              icon: IconCopy,
                              field: "expiry",
                            },
                            { label: "Copy CVV", icon: IconCopy, field: "cvv" },
                          ]}
                          editLabel="Edit"
                          itemId={card.id}
                          itemLabel={card.label}
                          onDelete={() =>
                            setRemoving({ kind: "card", item: card })
                          }
                          onEdit={() =>
                            setEditing({ kind: "card", item: card })
                          }
                          onStatus={(message) =>
                            setStatus(
                              message ? { section: "cards", message } : null,
                            )
                          }
                          section="cards"
                        />
                      </ItemActions>
                    </Item>
                    {index !== all.length - 1 ? <Separator /> : null}
                  </React.Fragment>
                ))}
              </PageRows>
            )}
          </PageSection>

          {/* Personal info. ---------------------------------------------------------------- */}
          <PageSection
            action={
              state.personalInfo ? (
                <Button
                  onClick={() =>
                    setEditing({
                      kind: "personal-info",
                      item: state.personalInfo as VaultPersonalInfo,
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  Edit
                </Button>
              ) : (
                <Button
                  aria-label="Add personal info"
                  onClick={() => setAdding("personal-info")}
                  size="sm"
                  variant="outline"
                >
                  <IconPlus />
                  Add
                </Button>
              )
            }
            title="Personal info"
          >
            {state.personalInfo === null ? (
              <PageEmpty>No personal info saved.</PageEmpty>
            ) : (
              <PageRows className="mt-4">
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconId className="text-muted-foreground" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle className="font-normal">
                      {state.personalInfo.fullName ??
                        state.personalInfo.preferredName ??
                        "Personal information"}
                    </ItemTitle>
                    <ItemDescription>
                      {[
                        state.personalInfo.preferredName
                          ? state.personalInfo.fullName
                            ? `goes by ${state.personalInfo.preferredName}`
                            : undefined
                          : undefined,
                        state.personalInfo.email,
                        state.personalInfo.phone,
                        state.personalInfo.company,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Nothing filled in yet."}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              </PageRows>
            )}
          </PageSection>

          {/* Agent items. ----------------------------------------------------------------- */}
          <PageSection
            action={
              <Button
                aria-label="Add agent item"
                onClick={() => setAdding("agent-item")}
                size="sm"
                variant="outline"
              >
                <IconPlus />
                Add item
              </Button>
            }
            description="Accounts and other items used by your coworker. They stay in your vault and remain under your control."
            title="Agent items"
          >
            {status?.section === "agent-items" ? (
              <StatusLine message={status.message} />
            ) : null}
            {state.agentItems.length === 0 ? (
              <PageEmpty>
                No agent items saved. Add an API key, a token or a secret here
                and your coworker can ask for it by name when a task needs it.
              </PageEmpty>
            ) : (
              <PageRows>
                {state.agentItems.map((item, index, all) => (
                  <React.Fragment key={item.id}>
                    <Item size="sm">
                      <ItemMedia variant="icon">
                        <IconKey className="text-muted-foreground" />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle className="font-normal">
                          {item.label}
                        </ItemTitle>
                        <ItemDescription>
                          {VAULT_AGENT_ITEM_KIND_LABELS[item.kind] ?? item.kind}
                          {item.lastUsedAt
                            ? ` · used ${relativeTime(item.lastUsedAt)}`
                            : ""}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <VaultItemMenu
                          actions={[{ label: "Copy value", icon: IconCopy }]}
                          editLabel="Edit"
                          itemId={item.id}
                          itemLabel={item.label}
                          onDelete={() =>
                            setRemoving({ kind: "agent-item", item })
                          }
                          onEdit={() =>
                            setEditing({ kind: "agent-item", item })
                          }
                          onStatus={(message) =>
                            setStatus(
                              message
                                ? { section: "agent-items", message }
                                : null,
                            )
                          }
                          section="agent-items"
                        />
                      </ItemActions>
                    </Item>
                    {index !== all.length - 1 ? <Separator /> : null}
                  </React.Fragment>
                ))}
              </PageRows>
            )}
          </PageSection>
        </>
      )}

      {/* The four dialogs, mounted only while one is open, so each seeds once and is discarded. */}
      {adding === "login" ? (
        <VaultLoginDialog login={null} onClose={() => setAdding(null)} />
      ) : null}
      {editing?.kind === "login" ? (
        <VaultLoginDialog
          login={editing.item}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {adding === "card" ? (
        <VaultCardDialog card={null} onClose={() => setAdding(null)} />
      ) : null}
      {editing?.kind === "card" ? (
        <VaultCardDialog card={editing.item} onClose={() => setEditing(null)} />
      ) : null}
      {adding === "personal-info" ? (
        <VaultPersonalInfoDialog info={null} onClose={() => setAdding(null)} />
      ) : null}
      {editing?.kind === "personal-info" ? (
        <VaultPersonalInfoDialog
          info={editing.item}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {adding === "agent-item" ? (
        <VaultAgentItemDialog item={null} onClose={() => setAdding(null)} />
      ) : null}
      {editing?.kind === "agent-item" ? (
        <VaultAgentItemDialog
          item={editing.item}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {removing ? (
        <VaultDeleteDialog
          deleteLabel="Delete"
          deleting={deleting?.isPending ?? false}
          description={REMOVE_COPY[removing.kind]}
          error={deleteError}
          onConfirm={confirmRemove}
          onOpenChange={(open) => !open && setRemoving(null)}
          open
          title={`Delete ${removing.item.label}?`}
        />
      ) : null}
    </PageShell>
  );
}

/**
 * What each kind says it is losing.
 *
 * An object rather than three inline ternaries because the three sentences differ only in the noun and
 * the agent-item one says something the other two do not — that the coworker loses access too, which
 * is the part somebody saving an API key actually needs to be told before they press the button.
 */
const REMOVE_COPY = {
  login: "This will permanently remove this saved login from your vault.",
  card: "This will permanently remove this saved card from your vault.",
  "agent-item":
    "This will permanently remove this item from your vault, and your coworker will no longer be able to use it.",
} as const;

/** One sentence of news, in the muted size every other status line on these screens uses. */
function StatusLine({ message }: { message: string }) {
  return (
    <p className="text-destructive text-xs" role="alert">
      {message}
    </p>
  );
}
