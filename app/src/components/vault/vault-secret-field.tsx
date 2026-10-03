import { IconEye, IconEyeOff, IconRefresh } from "@tabler/icons-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { generatePassword } from "@/lib/vault/form";
import { VaultField } from "./vault-field";

/**
 * A password box with a show/hide control and an optional generator.
 *
 * MASKED BY DEFAULT, every time it mounts, and the reveal is a held toggle rather than a sticky
 * state: somebody glances at a password to check which one it is, and a control that stays revealed
 * afterwards leaves it on screen for the rest of the session. Releasing or clicking again puts it
 * back.
 *
 * THE GENERATOR RUNS IN THE BROWSER. `generatePassword` is a local function over
 * `crypto.getRandomValues`; nothing is requested and nothing is logged, so the suggestion cannot
 * exist anywhere but in this tab. It REPLACES the box rather than offering a second field to copy
 * from — a "here is one, copy it into the field" control is the same value in two places at once,
 * which is the thing this form is otherwise careful not to do.
 */
export function VaultPasswordField({
  id,
  label,
  value,
  onChange,
  error,
  /** Set on an edit, where an empty box means "keep the stored one". */
  isEdit = false,
  /** SSH keys and long tokens have no useful show/hide; the box stays masked. */
  generate = true,
  autoFocus = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  isEdit?: boolean;
  generate?: boolean;
  autoFocus?: boolean;
}) {
  const [revealed, setRevealed] = React.useState(false);

  return (
    <VaultField
      description={
        isEdit
          ? "Leave this empty to keep the password you have already saved."
          : undefined
      }
      error={error}
      htmlFor={id}
      label={label}
    >
      <div className="flex items-center gap-2">
        <Input
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          autoFocus={autoFocus}
          id={id}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          type={revealed ? "text" : "password"}
          value={value}
        />
        <Button
          aria-label={
            revealed
              ? `Hide ${label.toLowerCase()}`
              : `Show ${label.toLowerCase()}`
          }
          onClick={() => setRevealed((shown) => !shown)}
          size="icon-sm"
          type="button"
          variant="outline"
        >
          {revealed ? <IconEyeOff /> : <IconEye />}
        </Button>
        {generate ? (
          <Button
            onClick={() => {
              onChange(generatePassword());
              // Revealing what was just generated: the point of asking for one is being able to read
              // it out loud to somebody else, and a box that stays masked after a deliberate
              // "generate" defeats the button.
              setRevealed(true);
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconRefresh data-icon="inline-start" />
            Generate
          </Button>
        ) : null}
      </div>
    </VaultField>
  );
}

/**
 * A value box that is not a password: an API key, a token, an SSH key.
 *
 * VISIBLE WHILE TYPED, and this is a deliberate difference from the password box above. Somebody
 * pasting a 40-character key needs to check they got all of it, and a masked box makes that a
 * character-count by eye; an SSH key is several lines long and cannot be pasted into a one-line input
 * at all. What protects the value is that this is a modal dialog the person opened themselves, and
 * that the stored value is never sent to this page — the placeholder on an edit says so in dots
 * rather than leaving an empty box that reads as "cleared".
 *
 * A textarea rather than an input for the same reason: a private key is more than one line, and a box
 * that silently swallows the newlines turns a paste into a broken key.
 */
export function VaultSecretField({
  id,
  label,
  value,
  onChange,
  error,
  description,
  isEdit = false,
  autoFocus = false,
  rows = 3,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  description?: React.ReactNode;
  isEdit?: boolean;
  autoFocus?: boolean;
  rows?: number;
}) {
  return (
    <VaultField
      description={
        description ??
        (isEdit
          ? "Leave this empty to keep the value you have already saved."
          : undefined)
      }
      error={error}
      htmlFor={id}
      label={label}
    >
      <Textarea
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        autoFocus={autoFocus}
        className="font-mono"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        placeholder={isEdit ? "••••••••••••••••" : undefined}
        rows={rows}
        spellCheck={false}
        value={value}
      />
    </VaultField>
  );
}
