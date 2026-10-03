import { useMutation } from "@tanstack/react-query";
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  emptyVaultCardForm,
  formatCardNumber,
  type VaultCardFormValues,
  vaultCardFormSchema,
  vaultCardInputFrom,
} from "@/lib/vault/form";
import {
  createVaultCardMutationOptions,
  updateVaultCardMutationOptions,
} from "@/lib/vault/mutations";
import type { VaultCard } from "@/lib/vault/queries";
import { queryClient } from "@/query-client";
import { useVaultForm, VaultDialogShell } from "./vault-dialog";
import { firstIssues, VaultField } from "./vault-field";
import { VaultPasswordField } from "./vault-secret-field";

/**
 * One dialog for adding and editing a card.
 *
 * The number is GROUPED AS IT IS TYPED and shown in full, because this is the one place somebody has
 * to see what they pasted: a card number split into blocks of four is checkable at a glance and a
 * run-together one is not. The stored copy is never in this page, so an edit opens the box EMPTY with
 * the note saying so, and `formatCardNumber` means an edit cannot show the last four either — the mask
 * on the row is built from the server's clear last-four column, not from anything here.
 *
 * THE CVV IS MASKED while typing and revealed on the same hold-to-show control as a password, because
 * unlike the number it is three digits nobody recognises and nobody needs to read aloud.
 */
export function VaultCardDialog({
  card,
  onClose,
}: {
  /** Null opens it for adding. A row opens it for editing. */
  card: VaultCard | null;
  onClose: () => void;
}) {
  const isEdit = card !== null;
  const [seed] = React.useState<VaultCardFormValues>(() =>
    card
      ? {
          label: card.label,
          cardholderName: card.cardholderName ?? "",
          // Empty, not the last four: what is stored is never sent here, and pre-filling four digits
          // would invite a save that writes four digits back.
          cardNumber: "",
          expiry: card.expiry ?? "",
          cvv: "",
          billingAddress: card.billingAddress ?? "",
          notes: card.notes ?? "",
        }
      : emptyVaultCardForm,
  );

  const form = useVaultForm<VaultCardFormValues>(seed);
  const create = useMutation(createVaultCardMutationOptions(queryClient));
  const update = useMutation(updateVaultCardMutationOptions(queryClient));
  const saving = create.isPending || update.isPending;
  const issues = firstIssues(vaultCardFormSchema, form.values);

  const done = () => onClose();

  const submit = () => {
    const names = Object.keys(issues);
    if (names.length) {
      form.markSubmitted();
      form.setError(issues[names[0]]);
      return;
    }
    form.setError(null);

    const input = vaultCardInputFrom(form.values, isEdit);
    if (isEdit && card) {
      update.mutate(
        { cardId: card.id, input },
        {
          onSuccess: done,
          onError: (error: Error) => form.setError(error.message),
        },
      );
      return;
    }
    create.mutate(input, {
      onSuccess: done,
      onError: (error: Error) => form.setError(error.message),
    });
  };

  return (
    <VaultDialogShell
      description="Your coworker asks for this when it needs to pay for something. It is stored encrypted, and the list shows only the last four digits."
      error={form.error}
      onOpenChange={(next) => form.requestClose(next, onClose)}
      onSubmit={submit}
      open
      saving={saving}
      submitLabel="Save card"
      title={isEdit ? "Edit card" : "Add card"}
    >
      <VaultField
        error={form.showError("label") ? issues.label : undefined}
        htmlFor="vault-card-label"
        label="Card name"
      >
        <Input
          autoFocus
          id="vault-card-label"
          onChange={(event) => form.set("label", event.target.value)}
          placeholder="Personal Visa"
          value={form.values.label}
        />
      </VaultField>
      <VaultField
        error={
          form.showError("cardholderName") ? issues.cardholderName : undefined
        }
        htmlFor="vault-card-holder"
        label="Cardholder name"
      >
        <Input
          autoComplete="off"
          id="vault-card-holder"
          onChange={(event) => form.set("cardholderName", event.target.value)}
          placeholder="John Doe"
          value={form.values.cardholderName}
        />
      </VaultField>
      <VaultField
        error={form.showError("cardNumber") ? issues.cardNumber : undefined}
        htmlFor="vault-card-number"
        label="Card number"
      >
        <Input
          autoComplete="off"
          inputMode="numeric"
          onChange={(event) =>
            form.set("cardNumber", formatCardNumber(event.target.value))
          }
          placeholder="4242 4242 4242 4242"
          value={form.values.cardNumber}
        />
      </VaultField>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <VaultField
          error={form.showError("expiry") ? issues.expiry : undefined}
          htmlFor="vault-card-expiry"
          label="Expiry date"
        >
          <Input
            autoComplete="off"
            id="vault-card-expiry"
            inputMode="numeric"
            onChange={(event) => form.set("expiry", event.target.value)}
            placeholder="04/29"
            value={form.values.expiry}
          />
        </VaultField>
        <VaultPasswordField
          error={form.showError("cvv") ? issues.cvv : undefined}
          generate={false}
          id="vault-card-cvv"
          isEdit={isEdit}
          label="CVV"
          onChange={(value) => form.set("cvv", value)}
          value={form.values.cvv}
        />
      </div>
      <VaultField
        error={
          form.showError("billingAddress") ? issues.billingAddress : undefined
        }
        htmlFor="vault-card-address"
        label="Billing address"
      >
        <Textarea
          id="vault-card-address"
          onChange={(event) => form.set("billingAddress", event.target.value)}
          placeholder={"1 Example Street\nLondon\nSW1A 1AA"}
          rows={3}
          value={form.values.billingAddress}
        />
      </VaultField>
      <VaultField
        error={form.showError("notes") ? issues.notes : undefined}
        htmlFor="vault-card-notes"
        label="Notes"
      >
        <Textarea
          id="vault-card-notes"
          onChange={(event) => form.set("notes", event.target.value)}
          placeholder="The card for subscriptions, not for travel."
          rows={2}
          value={form.values.notes}
        />
      </VaultField>
    </VaultDialogShell>
  );
}
