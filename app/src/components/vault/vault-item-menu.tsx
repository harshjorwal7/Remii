import { IconDots } from "@tabler/icons-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { revealVaultSecret } from "@/lib/vault/queries";

/**
 * The "…" menu on every vault row, and the one place a secret is fetched.
 *
 * WHY COPY LIVES HERE AND NOT ON THE ROW. A row showing a password, a card number or an API key would
 * be a row holding it in the DOM, and a vault list is a list somebody might read over somebody's
 * shoulder. Behind a menu, the value exists for the length of one clipboard write and nowhere else:
 * it is never in the query cache, never in component state that outlives the click, and never in a
 * prop a test could snapshot. That is the whole security argument for this component's shape.
 *
 * THE SENTENCE GOES BACK OUT. A refusal — "that card has no CVV saved", or a browser that would not
 * hand over the clipboard — is reported through `onStatus` rather than swallowed. There is no toast in
 * this app (`app-sidebar/channel.tsx` records why), so the section this menu sits in owns one line of
 * text and the menu writes to it. The alternative, swapping the item's own label for the error, puts
 * an error where the next action used to be and leaves three other actions looking broken.
 */
export type VaultMenuAction = {
  label: string;
  /** Which field to read, for the three actions that can read more than one thing. */
  field?: "number" | "expiry" | "cvv";
  icon?: React.ComponentType<{ className?: string }>;
};

export function VaultItemMenu({
  section,
  itemId,
  itemLabel,
  editLabel,
  onEdit,
  onDelete,
  onStatus,
  actions = [],
}: {
  section: "logins" | "cards" | "agent-items";
  itemId: string;
  /** Named in the destructive label, because a menu opened over the wrong row is the usual way this goes wrong. */
  itemLabel: string;
  editLabel: string;
  onEdit: () => void;
  onDelete: () => void;
  /** Where a refusal goes. Called with null when the copy worked. */
  onStatus: (message: string | null) => void;
  actions?: VaultMenuAction[];
}) {
  const [copied, setCopied] = React.useState<string | null>(null);

  const copy = async (action: VaultMenuAction) => {
    try {
      const value = await revealVaultSecret(section, itemId, action.field);
      await navigator.clipboard.writeText(value);
      setCopied(action.label);
      /*
       * Two seconds, then the label goes back. A menu that keeps saying "Copied!" for ever is a menu
       * lying about a value nobody can verify any more.
       */
      window.setTimeout(
        () =>
          setCopied((current) => (current === action.label ? null : current)),
        2000,
      );
      onStatus(null);
    } catch (error) {
      /*
       * The server's sentence where there is one — "no CVV saved" is the answer and "could not copy"
       * is not — and a sentence of our own only when the clipboard itself refused, which is the one
       * failure the person can fix by hand.
       */
      onStatus(
        error instanceof Error
          ? error.message
          : "Your browser would not let this page reach the clipboard.",
      );
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`${itemLabel} options`}
            size="icon-sm"
            variant="ghost"
          >
            <IconDots />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-auto min-w-40">
        <DropdownMenuItem onClick={onEdit}>{editLabel}</DropdownMenuItem>
        {actions.length ? (
          <>
            <DropdownMenuSeparator />
            {actions.map((action) => (
              <DropdownMenuItem
                key={action.label}
                onClick={() => void copy(action)}
              >
                {action.icon ? <action.icon /> : null}
                {copied === action.label ? "Copied!" : action.label}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        {/*
         * Named, and destructive. A menu item that said only "Delete" would act on whichever row the
         * menu was opened over, which is the single most common way the wrong thing gets destroyed on
         * these screens.
         */}
        <DropdownMenuItem onClick={onDelete} variant="destructive">
          Delete {itemLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
