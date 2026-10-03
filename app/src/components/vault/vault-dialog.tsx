import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VaultFieldGroup, VaultFormError } from "./vault-field";

/**
 * The frame all four vault dialogs share, so "Add login" and "Edit login" differ only in their title
 * and their seeded fields.
 *
 * `DialogBody` is a DIRECT CHILD of `DialogContent` and nothing wraps all three sections — that is the
 * layout skill's rule, and breaking it costs the `flex-1 min-h-0` chain, after which the body stops
 * scrolling and a thirteen-field form paints over its own footer on a short laptop screen.
 *
 * `footerExtra` is the slot for a control that belongs beside the submit button rather than in the
 * body — the password generator, which has to be visibly next to the box it fills.
 */
export function VaultDialogShell({
  open,
  onOpenChange,
  title,
  description,
  saving,
  error,
  children,
  submitLabel,
  onSubmit,
  footerExtra,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  saving: boolean;
  error?: string | null;
  children: React.ReactNode;
  submitLabel: string;
  onSubmit: () => void;
  footerExtra?: React.ReactNode;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <VaultFieldGroup>{children}</VaultFieldGroup>
          <VaultFormError message={error} />
        </DialogBody>
        {footerExtra ? (
          <DialogFooter className="flex-row items-center justify-between gap-2">
            {footerExtra}
            <VaultDialogFooter
              onSubmit={onSubmit}
              saving={saving}
              submitLabel={submitLabel}
            />
          </DialogFooter>
        ) : (
          <VaultDialogFooter
            onSubmit={onSubmit}
            saving={saving}
            submitLabel={submitLabel}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Cancel and the one primary verb.
 *
 * Cancel is a `DialogClose`, which is what makes Escape and the backdrop work the way they do on
 * every other dialog in this app: one primitive, one behaviour, no second copy of the dismissal
 * logic per form.
 *
 * The pending label is derived from the mutation rather than from state somebody set and forgot to
 * clear — "Saving…" for as long as the request is in flight and not one frame longer.
 */
function VaultDialogFooter({
  submitLabel,
  saving,
  onSubmit,
}: {
  submitLabel: string;
  saving: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="flex flex-row items-center justify-end gap-2">
      <DialogClose
        render={
          <Button size="sm" variant="outline">
            Cancel
          </Button>
        }
      />
      <Button disabled={saving} onClick={onSubmit} size="sm" type="button">
        {saving ? "Saving…" : submitLabel}
      </Button>
    </div>
  );
}

/**
 * The state a vault dialog holds: the box, what it opened with, and whether it may close.
 *
 * UNSAVED CHANGES, which no dialog in this app guards today, and which matters more here than
 * anywhere else. Every other form on these screens is a couple of words somebody can retype; this one
 * can hold a password, a card number and an API key, and losing a typed card number to an Escape
 * pressed out of habit is a worse outcome than an extra question.
 *
 * It RE-ASKS rather than refusing. A dialog that swallowed the escape would leave somebody typing into
 * a form that had already closed, and `confirm` is the one primitive that exists everywhere — with its
 * own buttons, in the browser's own words, rather than a second confirmation dialog invented here.
 *
 * `close()` skips the question. It is for the two cases where there is nothing to lose: a deliberate
 * cancel, and a save that succeeded.
 */
export function useVaultForm<T extends Record<string, unknown>>(empty: T) {
  const [values, setValues] = React.useState<T>(empty);
  const [pristine, _setPristine] = React.useState<T>(empty);
  const [error, setError] = React.useState<string | null>(null);
  const [submitted, setSubmitted] = React.useState(false);
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const set = React.useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    // A refusal is about the last save, and the next keystroke means that save is being revised.
    setError(null);
    setTouched((current) => {
      if (current.has(String(key))) return current;
      const next = new Set(current);
      next.add(String(key));
      return next;
    });
  }, []);

  /**
   * Close, asking first if there is anything to lose.
   *
   * `then` IS THE CLOSER, and that is the fix. This hook used to own an `open` flag and flip it here,
   * which read as though the dialog had closed — but the shell takes `open` from its caller and the
   * page mounts each dialog only while one is open, so nothing consumed the flag. The X, Cancel and
   * Escape all called this, all returned having "closed" a dialog that stayed exactly where it was.
   *
   * The caller passes the unmount it was given, so the one action every way out of the box takes ends
   * in the same place.
   */
  const requestClose = React.useCallback(
    (next: boolean, then: () => void) => {
      if (next) return;
      const dirty = JSON.stringify(values) !== JSON.stringify(pristine);
      if (
        dirty &&
        !window.confirm("You have unsaved changes here. Close and lose them?")
      ) {
        return;
      }
      then();
    },
    [values, pristine],
  );

  return {
    values,
    set,
    requestClose,
    error,
    setError,
    /**
     * Whether a field's own complaint should be on screen.
     *
     * FALSE UNTIL SOMEBODY HAS PUT SOMETHING IN IT, or pressed Save. Every schema in this feature has
     * required fields, and the issues were computed on every render — so opening "Edit card" drew a
     * red line under a Card name, a Cardholder name and an Expiry that were empty because the dialog
     * had just opened and nobody had typed yet. That is a form telling somebody it is wrong before
     * they have done anything, which reads as the vault rejecting them rather than as a form waiting.
     *
     * `submitted` covers the case touching cannot: a field nobody visited can still be the one the
     * server refused, and after a Save the errors belong on screen whatever the cursor has done.
     */
    showError: (field: string) => submitted || touched.has(field),
    /** Called when a submit was refused, so every complaint shows at once rather than one at a time. */
    markSubmitted: () => setSubmitted(true),
  };
}
