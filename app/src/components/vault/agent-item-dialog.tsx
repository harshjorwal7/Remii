import { useMutation } from "@tanstack/react-query";
import * as React from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  emptyVaultAgentItemForm,
  VAULT_AGENT_ITEM_KINDS,
  VAULT_AGENT_ITEM_SCOPES,
  type VaultAgentItemFormValues,
  vaultAgentItemFormSchema,
  vaultAgentItemInputFrom,
} from "@/lib/vault/form";
import {
  createVaultAgentItemMutationOptions,
  updateVaultAgentItemMutationOptions,
} from "@/lib/vault/mutations";
import type { VaultAgentItem } from "@/lib/vault/queries";
import { queryClient } from "@/query-client";
import { useVaultForm, VaultDialogShell } from "./vault-dialog";
import { firstIssues, VaultField } from "./vault-field";
import { VaultSecretField } from "./vault-secret-field";

/**
 * One dialog for adding and editing an item meant for the coworker's own use.
 *
 * SCOPE IS OFFERED NOW BECAUSE THE DATA MODEL ALREADY CARRIES IT, and offering it early is cheaper
 * than offering it later: somebody who saves a Stripe key and leaves the scope at "any task" has made
 * a decision, and one who narrows it has made a different one. What is NOT here is the per-item
 * permission a model would want to ask for — "ask me first", "only Remii may use this" — because
 * there is nothing behind those yet, and a switch wired to nothing is worse than its absence. See the
 * note on `vaultAgentItemScope` in the schema.
 *
 * THE ALLOWED-APPS BOX IS ONE PER LINE rather than a repeatable field, for the reason given on the
 * schema in `lib/vault/form.ts`: the list is short, nobody types twenty entries, and a line-per-item
 * control would be a second form system inside this dialog.
 */
export function VaultAgentItemDialog({
  item,
  onClose,
}: {
  /** Null opens it for adding. A row opens it for editing. */
  item: VaultAgentItem | null;
  onClose: () => void;
}) {
  const isEdit = item !== null;
  const [seed] = React.useState<VaultAgentItemFormValues>(() =>
    item
      ? {
          label: item.label,
          kind: item.kind,
          // Empty: the stored value is never sent to this page.
          value: "",
          description: item.description ?? "",
          scope: item.scope,
          scopeRef: item.scopeRef ?? "",
          allowedApps: item.allowedApps.join("\n"),
        }
      : emptyVaultAgentItemForm,
  );

  const form = useVaultForm<VaultAgentItemFormValues>(seed);
  const create = useMutation(createVaultAgentItemMutationOptions(queryClient));
  const update = useMutation(updateVaultAgentItemMutationOptions(queryClient));
  const saving = create.isPending || update.isPending;
  const issues = firstIssues(vaultAgentItemFormSchema, form.values);

  const scopeDescription = VAULT_AGENT_ITEM_SCOPES.find(
    (scope) => scope.value === form.values.scope,
  )?.description;

  const done = () => onClose();

  const submit = () => {
    const names = Object.keys(issues);
    if (names.length) {
      form.markSubmitted();
      form.setError(issues[names[0]]);
      return;
    }
    form.setError(null);

    const input = vaultAgentItemInputFrom(form.values, isEdit);
    if (isEdit && item) {
      update.mutate(
        { itemId: item.id, input },
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
      description="A key, a token or a secret your coworker may use while working for you. It stays in your vault, and your coworker asks for it by name when a task needs it."
      error={form.error}
      onOpenChange={(next) => form.requestClose(next, onClose)}
      onSubmit={submit}
      open
      saving={saving}
      submitLabel="Save item"
      title={isEdit ? "Edit agent item" : "Add agent item"}
    >
      <VaultField
        error={form.showError("label") ? issues.label : undefined}
        htmlFor="vault-item-label"
        label="Name"
      >
        <Input
          autoFocus
          id="vault-item-label"
          onChange={(event) => form.set("label", event.target.value)}
          placeholder="Stripe API key"
          value={form.values.label}
        />
      </VaultField>

      <VaultField
        error={form.showError("kind") ? issues.kind : undefined}
        htmlFor="vault-item-kind"
        label="Type"
      >
        <Select
          onValueChange={(value) => {
            if (typeof value === "string") {
              form.set("kind", value as VaultAgentItemFormValues["kind"]);
            }
          }}
          value={form.values.kind}
        >
          <SelectTrigger
            className="w-full justify-between"
            id="vault-item-kind"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VAULT_AGENT_ITEM_KINDS.map((kind) => (
              <SelectItem key={kind.value} value={kind.value}>
                {kind.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </VaultField>

      <VaultSecretField
        error={form.showError("value") ? issues.value : undefined}
        id="vault-item-value"
        isEdit={isEdit}
        label="Value"
        onChange={(value) => form.set("value", value)}
        value={form.values.value}
      />

      <VaultField
        error={form.showError("description") ? issues.description : undefined}
        htmlFor="vault-item-description"
        label="Description"
      >
        <Textarea
          id="vault-item-description"
          onChange={(event) => form.set("description", event.target.value)}
          placeholder="The live key, not the test one."
          rows={2}
          value={form.values.description}
        />
      </VaultField>

      <VaultField
        description={scopeDescription}
        error={form.showError("scope") ? issues.scope : undefined}
        htmlFor="vault-item-scope"
        label="Scope"
      >
        <Select
          onValueChange={(value) => {
            if (typeof value === "string") {
              form.set("scope", value as VaultAgentItemFormValues["scope"]);
            }
          }}
          value={form.values.scope}
        >
          <SelectTrigger
            className="w-full justify-between"
            id="vault-item-scope"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VAULT_AGENT_ITEM_SCOPES.map((scope) => (
              <SelectItem key={scope.value} value={scope.value}>
                {scope.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </VaultField>

      {form.values.scope === "agent" ? null : (
        <VaultField
          description={
            form.values.scope === "integration"
              ? "An app or domain, e.g. stripe.com or api.stripe.com."
              : "A task you name. Your coworker can only use this inside that task."
          }
          error={form.showError("scopeRef") ? issues.scopeRef : undefined}
          htmlFor="vault-item-scope-ref"
          label={form.values.scope === "integration" ? "Integration" : "Task"}
        >
          <Input
            id="vault-item-scope-ref"
            onChange={(event) => form.set("scopeRef", event.target.value)}
            placeholder={
              form.values.scope === "integration"
                ? "api.stripe.com"
                : "Monthly invoice run"
            }
            value={form.values.scopeRef}
          />
        </VaultField>
      )}

      <VaultField
        description="One app or domain per line, e.g. api.stripe.com. Leave empty for no restriction."
        error={form.showError("allowedApps") ? issues.allowedApps : undefined}
        htmlFor="vault-item-apps"
        label="Allowed apps"
      >
        <Textarea
          id="vault-item-apps"
          onChange={(event) => form.set("allowedApps", event.target.value)}
          placeholder={"api.stripe.com\ndashboard.stripe.com"}
          rows={2}
          value={form.values.allowedApps}
        />
      </VaultField>
    </VaultDialogShell>
  );
}
