import type * as React from "react";
import type { z } from "zod";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";

/**
 * The three pieces every one of the four vault dialogs is made of.
 *
 * WHY THEY ARE HERE AND NOT IN EACH DIALOG. "Add login" and "Edit login" are the same form with a
 * different title and a seeded box, and the same is true of cards and agent items — so what varies
 * between them is the field list and nothing else. Handing each dialog its own label/error trio would
 * be four copies to drift, and the drift shows up as an error message sitting next to the wrong
 * input, which is the one bug in a form that a person cannot work out for themselves.
 */

/**
 * A labelled control with its error beside it.
 *
 * `description` is for the sentence that changes what somebody types, and the most important one in
 * the whole form is "leave this empty to keep the one you already saved": an edit dialog showing an
 * empty password box is otherwise read as the password being gone.
 *
 * The error REPLACES the description rather than sitting above it, so a field is never two sentences
 * long telling somebody two different things.
 */
export function VaultField({
  label,
  htmlFor,
  error,
  description,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {children}
      {error ? (
        <FieldError errors={[{ message: error }]} />
      ) : description ? (
        <FieldDescription>{description}</FieldDescription>
      ) : null}
    </Field>
  );
}

/**
 * A refusal about the whole dialog rather than about one field.
 *
 * `role="alert"` because it is the answer to a click somebody just took: the server refused a save
 * for a reason no client rule covers (a duplicate name, a cap, an item somebody else already filled),
 * and the sentence arrives above the buttons where it is read before the next attempt.
 */
export function VaultFormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p className="text-destructive text-sm" role="alert">
      {message}
    </p>
  );
}

/** The field wrapper a dialog's list of controls goes inside. */
export function VaultFieldGroup({ children }: { children: React.ReactNode }) {
  return <FieldGroup>{children}</FieldGroup>;
}

/**
 * The first message per field, from a schema parse.
 *
 * One function for all four dialogs because the rule is the same everywhere: the FIRST issue about a
 * field is what a person reads, and three complaints about one input is a worse answer than the one
 * that would have fixed it.
 */
export function firstIssues<S extends z.ZodType>(
  schema: S,
  values: unknown,
): Record<string, string> {
  const parsed = schema.safeParse(values);
  if (parsed.success) return {};
  const issues: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !issues[field]) {
      issues[field] = issue.message;
    }
  }
  return issues;
}
