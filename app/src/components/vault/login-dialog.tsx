import { useMutation } from "@tanstack/react-query";
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  emptyVaultLoginForm,
  type VaultLoginFormValues,
  vaultLoginFormSchema,
  vaultLoginInputFrom,
} from "@/lib/vault/form";
import {
  createVaultLoginMutationOptions,
  updateVaultLoginMutationOptions,
} from "@/lib/vault/mutations";
import type { VaultLogin } from "@/lib/vault/queries";
import { queryClient } from "@/query-client";
import { useVaultForm, VaultDialogShell } from "./vault-dialog";
import { firstIssues, VaultField } from "./vault-field";
import { VaultPasswordField } from "./vault-secret-field";

/**
 * One dialog for adding a login and for editing one.
 *
 * THE SAME COMPONENT FOR BOTH, which is the whole point of `useVaultForm`: `login` null means add and
 * a row means edit, and the only differences are the title and which boxes are seeded. Two dialogs
 * would be two lists of fields to keep in step, and the moment somebody added a field to one the
 * other would quietly be wrong.
 *
 * MOUNTED ONLY WHILE IT IS OPEN. The page renders this when a row or the add button was clicked and
 * stops rendering it when the dialog closes, so the box is seeded once from the row and thrown away
 * on close rather than being kept in state and re-seeded by an effect. That is also what makes the
 * unsaved-changes guard honest: nothing to go stale between opening and typing.
 *
 * NOTHING COMES BACK TO SEED THE PASSWORD. An edit opens with the password box EMPTY and the note
 * under it saying so, because the stored password is never sent to this page and there is nothing to
 * pre-fill. Leaving the box alone therefore means "keep it", which `vaultLoginInputFrom` arranges by
 * omitting the field from the save entirely — sending an empty string would be how an edit silently
 * deletes somebody's password.
 */
export function VaultLoginDialog({
  login,
  onClose,
}: {
  /** Null opens it for adding. A row opens it for editing. */
  login: VaultLogin | null;
  onClose: () => void;
}) {
  const isEdit = login !== null;
  /*
   * Seeded once, from the row, on mount. `useState`'s argument is only read on the first render,
   * which is what makes this correct: the page unmounts this dialog rather than re-seeding it.
   */
  const [seed] = React.useState<VaultLoginFormValues>(() =>
    login
      ? {
          label: login.label,
          username: login.username,
          password: "",
          websiteUrl: login.websiteUrl ?? "",
          notes: login.notes ?? "",
        }
      : emptyVaultLoginForm,
  );

  const form = useVaultForm<VaultLoginFormValues>(seed);
  const create = useMutation(createVaultLoginMutationOptions(queryClient));
  const update = useMutation(updateVaultLoginMutationOptions(queryClient));
  const saving = create.isPending || update.isPending;

  /* One parse per render, so four fields cannot disagree about one verdict. */
  const issues = firstIssues(vaultLoginFormSchema, form.values);

  const done = () => onClose();

  const submit = () => {
    const names = Object.keys(issues);
    if (names.length) {
      form.markSubmitted();
      form.setError(issues[names[0]]);
      return;
    }
    form.setError(null);

    const input = vaultLoginInputFrom(form.values, isEdit);
    if (isEdit && login) {
      update.mutate(
        { loginId: login.id, input },
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
      description="Your coworker asks for this when it needs to sign in somewhere as you. It is stored encrypted, and the list never shows it."
      error={form.error}
      onOpenChange={(next) => form.requestClose(next, onClose)}
      onSubmit={submit}
      open
      saving={saving}
      submitLabel="Save login"
      title={isEdit ? "Edit login" : "Add login"}
    >
      <VaultField
        error={form.showError("label") ? issues.label : undefined}
        htmlFor="vault-login-label"
        label="Website or app"
      >
        <Input
          autoFocus
          id="vault-login-label"
          onChange={(event) => form.set("label", event.target.value)}
          placeholder="Google"
          value={form.values.label}
        />
      </VaultField>
      <VaultField
        error={form.showError("username") ? issues.username : undefined}
        htmlFor="vault-login-username"
        label="Username or email"
      >
        <Input
          autoComplete="off"
          id="vault-login-username"
          onChange={(event) => form.set("username", event.target.value)}
          placeholder="user@example.com"
          value={form.values.username}
        />
      </VaultField>
      <VaultPasswordField
        error={form.showError("password") ? issues.password : undefined}
        id="vault-login-password"
        isEdit={isEdit}
        label="Password"
        onChange={(value) => form.set("password", value)}
        value={form.values.password}
      />
      <VaultField
        error={form.showError("websiteUrl") ? issues.websiteUrl : undefined}
        htmlFor="vault-login-url"
        label="Website URL"
      >
        <Input
          id="vault-login-url"
          onChange={(event) => form.set("websiteUrl", event.target.value)}
          placeholder="https://mail.google.com"
          value={form.values.websiteUrl}
        />
      </VaultField>
      <VaultField
        error={form.showError("notes") ? issues.notes : undefined}
        htmlFor="vault-login-notes"
        label="Notes"
      >
        <Textarea
          id="vault-login-notes"
          onChange={(event) => form.set("notes", event.target.value)}
          placeholder="The account with the recovery codes in the safe."
          rows={3}
          value={form.values.notes}
        />
      </VaultField>
    </VaultDialogShell>
  );
}
