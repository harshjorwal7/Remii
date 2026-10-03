import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * "Delete this?"
 *
 * A plain `Dialog` with a heavier backdrop, which is the pattern `agent-dialog.tsx` and
 * `routines-list.tsx` already use for destroying something. There is no `AlertDialog` in this codebase
 * and no `ConfirmDialog` component either, so this copies the three that exist rather than
 * introducing a fourth shape — the point of a shared confirmation is that it looks like the others.
 *
 * THE HEAVIER BACKDROP IS NOT DECORATION. `DialogContent` only forces a backdrop into existence when
 * `overlayClassName` is passed, because Base UI skips it on a nested dialog, and a dialog stacked over
 * another is exactly the caller that asks for one. Without it the dialog underneath reads as a
 * competing surface rather than as background.
 *
 * THE TITLE NAMES THE ITEM. A menu opened over the wrong row is the ordinary way the wrong thing gets
 * destroyed, so the question carries the name rather than asking a bare "are you sure" about whatever
 * happens to be underneath.
 */
export function VaultDeleteDialog({
  open,
  title,
  description,
  deleteLabel,
  deleting,
  error,
  onConfirm,
  onOpenChange,
}: {
  open: boolean;
  title: string;
  description: string;
  /** "login" / "card" / "item" — what is being destroyed. */
  deleteLabel: string;
  deleting: boolean;
  error?: string | null;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-w-sm"
        overlayClassName="bg-black/20 supports-backdrop-filter:backdrop-blur-sm"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter className="mt-4">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={deleting}
            onClick={onConfirm}
            size="sm"
            variant="destructive"
          >
            {deleting ? "Deleting…" : deleteLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
