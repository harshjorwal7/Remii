import { useMutation } from "@tanstack/react-query";
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  emptyVaultPersonalInfoForm,
  type VaultPersonalInfoFormValues,
  vaultPersonalInfoFormSchema,
  vaultPersonalInfoInputFrom,
} from "@/lib/vault/form";
import { saveVaultPersonalInfoMutationOptions } from "@/lib/vault/mutations";
import type { VaultPersonalInfo } from "@/lib/vault/queries";
import { queryClient } from "@/query-client";
import { useVaultForm, VaultDialogShell } from "./vault-dialog";
import { firstIssues, VaultField } from "./vault-field";

/**
 * One dialog for the person's own details.
 *
 * EVERY FIELD IS OPTIONAL, and there is no required one. This is a form a coworker fills in on their
 * behalf, and a mandatory "job title" would be a form that refuses to save for somebody who does not
 * have one — which is most people on most of these thirteen.
 *
 * TWO COLUMNS ON A WIDE ENOUGH SCREEN, because thirteen fields in one column is a dialog that scrolls
 * for longer than its own footer stays put. Address, city, state, country and postal code are the ones
 * grouped: they are filled in together and read together, and splitting them across two columns
 * invents a relationship between them that does not exist.
 *
 * THE DATE OF BIRTH IS TEXT, NOT `<input type="date">`. The native picker opens its own dialog, cannot
 * be described, and on a phone covers the field; a `YYYY-MM-DD` box with the format in its placeholder
 * is one control that behaves the same everywhere and is checkable by the schema.
 */
export function VaultPersonalInfoDialog({
  info,
  onClose,
}: {
  /** Null opens it on an empty box — which is the ordinary first time. */
  info: VaultPersonalInfo | null;
  onClose: () => void;
}) {
  const [seed] = React.useState<VaultPersonalInfoFormValues>(() =>
    info
      ? {
          fullName: info.fullName ?? "",
          preferredName: info.preferredName ?? "",
          email: info.email ?? "",
          phone: info.phone ?? "",
          dateOfBirth: info.dateOfBirth ?? "",
          address: info.address ?? "",
          city: info.city ?? "",
          state: info.state ?? "",
          country: info.country ?? "",
          postalCode: info.postalCode ?? "",
          company: info.company ?? "",
          jobTitle: info.jobTitle ?? "",
          notes: info.notes ?? "",
        }
      : emptyVaultPersonalInfoForm,
  );

  const form = useVaultForm<VaultPersonalInfoFormValues>(seed);
  const save = useMutation(saveVaultPersonalInfoMutationOptions(queryClient));
  const issues = firstIssues(vaultPersonalInfoFormSchema, form.values);

  const done = () => onClose();

  const submit = () => {
    const names = Object.keys(issues);
    if (names.length) {
      form.markSubmitted();
      form.setError(issues[names[0]]);
      return;
    }
    form.setError(null);
    save.mutate(vaultPersonalInfoInputFrom(form.values), {
      onSuccess: done,
      onError: (error: Error) => form.setError(error.message),
    });
  };

  return (
    <VaultDialogShell
      description="What your coworker knows about you, so it can fill in a form on your behalf. Fill in only what you want it to use."
      error={form.error}
      onOpenChange={(next) => form.requestClose(next, onClose)}
      onSubmit={submit}
      open
      saving={save.isPending}
      submitLabel="Save details"
      title={info ? "Edit personal info" : "Add personal info"}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <VaultField
          error={form.showError("fullName") ? issues.fullName : undefined}
          htmlFor="vault-person-name"
          label="Full name"
        >
          <Input
            autoFocus
            autoComplete="off"
            id="vault-person-name"
            onChange={(event) => form.set("fullName", event.target.value)}
            placeholder="John Doe"
            value={form.values.fullName}
          />
        </VaultField>
        <VaultField
          error={
            form.showError("preferredName") ? issues.preferredName : undefined
          }
          htmlFor="vault-person-preferred"
          label="Preferred name"
        >
          <Input
            autoComplete="off"
            id="vault-person-preferred"
            onChange={(event) => form.set("preferredName", event.target.value)}
            placeholder="Johnny"
            value={form.values.preferredName}
          />
        </VaultField>
        <VaultField
          error={form.showError("email") ? issues.email : undefined}
          htmlFor="vault-person-email"
          label="Email"
        >
          <Input
            autoComplete="off"
            id="vault-person-email"
            onChange={(event) => form.set("email", event.target.value)}
            placeholder="john@example.com"
            value={form.values.email}
          />
        </VaultField>
        <VaultField
          error={form.showError("phone") ? issues.phone : undefined}
          htmlFor="vault-person-phone"
          label="Phone"
        >
          <Input
            autoComplete="off"
            id="vault-person-phone"
            onChange={(event) => form.set("phone", event.target.value)}
            placeholder="+44 7700 900000"
            value={form.values.phone}
          />
        </VaultField>
      </div>

      <VaultField
        description="Written as YYYY-MM-DD."
        error={form.showError("dateOfBirth") ? issues.dateOfBirth : undefined}
        htmlFor="vault-person-dob"
        label="Date of birth"
      >
        <Input
          autoComplete="off"
          id="vault-person-dob"
          onChange={(event) => form.set("dateOfBirth", event.target.value)}
          placeholder="1985-04-12"
          value={form.values.dateOfBirth}
        />
      </VaultField>

      <VaultField
        error={form.showError("address") ? issues.address : undefined}
        htmlFor="vault-person-address"
        label="Address"
      >
        <Textarea
          autoComplete="off"
          id="vault-person-address"
          onChange={(event) => form.set("address", event.target.value)}
          placeholder={"1 Example Street\nLondon"}
          rows={2}
          value={form.values.address}
        />
      </VaultField>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <VaultField
          error={form.showError("city") ? issues.city : undefined}
          htmlFor="vault-person-city"
          label="City"
        >
          <Input
            autoComplete="off"
            id="vault-person-city"
            onChange={(event) => form.set("city", event.target.value)}
            value={form.values.city}
          />
        </VaultField>
        <VaultField
          error={form.showError("state") ? issues.state : undefined}
          htmlFor="vault-person-state"
          label="State"
        >
          <Input
            autoComplete="off"
            id="vault-person-state"
            onChange={(event) => form.set("state", event.target.value)}
            value={form.values.state}
          />
        </VaultField>
        <VaultField
          error={form.showError("country") ? issues.country : undefined}
          htmlFor="vault-person-country"
          label="Country"
        >
          <Input
            autoComplete="off"
            id="vault-person-country"
            onChange={(event) => form.set("country", event.target.value)}
            value={form.values.country}
          />
        </VaultField>
        <VaultField
          error={form.showError("postalCode") ? issues.postalCode : undefined}
          htmlFor="vault-person-postal"
          label="Postal code"
        >
          <Input
            autoComplete="off"
            id="vault-person-postal"
            onChange={(event) => form.set("postalCode", event.target.value)}
            value={form.values.postalCode}
          />
        </VaultField>
        <VaultField
          error={form.showError("company") ? issues.company : undefined}
          htmlFor="vault-person-company"
          label="Company"
        >
          <Input
            autoComplete="off"
            id="vault-person-company"
            onChange={(event) => form.set("company", event.target.value)}
            value={form.values.company}
          />
        </VaultField>
        <VaultField
          error={form.showError("jobTitle") ? issues.jobTitle : undefined}
          htmlFor="vault-person-title"
          label="Job title"
        >
          <Input
            autoComplete="off"
            id="vault-person-title"
            onChange={(event) => form.set("jobTitle", event.target.value)}
            value={form.values.jobTitle}
          />
        </VaultField>
      </div>

      <VaultField
        error={form.showError("notes") ? issues.notes : undefined}
        htmlFor="vault-person-notes"
        label="Notes"
      >
        <Textarea
          id="vault-person-notes"
          onChange={(event) => form.set("notes", event.target.value)}
          placeholder="Anything a form has asked for that has no field here."
          rows={2}
          value={form.values.notes}
        />
      </VaultField>
    </VaultDialogShell>
  );
}
