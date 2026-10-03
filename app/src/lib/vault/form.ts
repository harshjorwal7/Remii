import { z } from "zod";
import type {
  VaultAgentItemInput,
  VaultCardInput,
  VaultLoginInput,
  VaultPersonalInfoInput,
} from "./mutations";

/**
 * What the four vault dialogs hold, and what they refuse.
 *
 * THE LIMITS MATCH THE STORE'S EXACTLY, character for character, which is what makes a form that
 * submits a form that will be accepted and puts a rejection next to the field that caused it. The
 * numbers are duplicated deliberately and are the ones place a reader should be suspicious of: a
 * change in `vault/store.ts` has to be made here too, and the alternative — no browser validation —
 * trades a fast, specific message for a round trip and a sentence at the top of a dialog.
 *
 * NO SECRET IS EVER VALIDATED AGAINST WHAT IS STORED. The edit forms open with the password, CVV and
 * value boxes EMPTY, because the stored value is not sent to the browser and there is nothing to
 * pre-fill. Empty therefore means "leave it alone", and a person has to type into the box to change
 * it. That is a deliberate extra step, and it is the price of a secret that never reaches a list.
 */

const MAX_LABEL = 80;
const MAX_USERNAME = 320;
const MAX_URL = 2000;
const MAX_NOTES = 4000;
const MAX_VALUE = 16_000;
const MAX_SHORT_FIELD = 200;
const MAX_ADDRESS = 1000;
const MAX_DATE = 10;

const label = (what: string) =>
  z
    .string()
    .trim()
    .min(1, `${what} is required.`)
    .max(MAX_LABEL, `${what} must be ${MAX_LABEL} characters or fewer.`);

/**
 * An optional single-line field: every key must be present, and any of them may be "".
 *
 * Present-but-empty rather than absent, and the distinction is deliberate. These thirteen values are
 * the whole state of one dialog, which always holds all of them, so `.optional()` would only buy a
 * second spelling of the same form — and a `VaultField` reading `form.values.fullName` would then have
 * to cope with `undefined` as well as "", for no caller that exists. Empty is what "not written" is
 * spelled, and every input in the dialog is controlled by a value of exactly that kind.
 */
const short = (what: string) =>
  z
    .string()
    .trim()
    .max(
      MAX_SHORT_FIELD,
      `${what} must be ${MAX_SHORT_FIELD} characters or fewer.`,
    );

export const vaultLoginFormSchema = z.object({
  label: label("Website or app"),
  username: z
    .string()
    .trim()
    .min(1, "Username or email is required.")
    .max(
      MAX_USERNAME,
      `Username or email must be ${MAX_USERNAME} characters or fewer.`,
    ),
  /**
   * No minimum, because a login with no password is real: a shared account somebody else holds, a
   * site that only wants the address. The store stores it as absent rather than as "".
   */
  password: z
    .string()
    .max(MAX_VALUE, `Password must be ${MAX_VALUE} characters or fewer.`),
  websiteUrl: z
    .string()
    .trim()
    .max(MAX_URL, `Website URL must be ${MAX_URL} characters or fewer.`)
    .refine(
      (value) => value === "" || /^https?:\/\/\S+$/i.test(value),
      "Enter a web address starting with http:// or https://.",
    ),
  notes: z
    .string()
    .trim()
    .max(MAX_NOTES, `Notes must be ${MAX_NOTES} characters or fewer.`),
});

export type VaultLoginFormValues = z.infer<typeof vaultLoginFormSchema>;

export const emptyVaultLoginForm: VaultLoginFormValues = {
  label: "",
  username: "",
  password: "",
  websiteUrl: "",
  notes: "",
};

/** Digits only, 12 to 19, grouped for reading — the grouping is display only and never stored. */
export const vaultCardFormSchema = z.object({
  label: label("Card name"),
  cardholderName: short("Cardholder name"),
  /**
   * Spaces and hyphens are stripped before checking, because a pasted card number arrives with them
   * and refusing it teaches people that pasting does not work.
   */
  /**
   * Digits, 12 to 19 of them, optionally separated by a space or a hyphen.
   *
   * The COUNT is checked on the digits rather than by counting the characters of the pattern, because
   * a pattern that permits a separator between every pair accepts up to 23 digits once the separators
   * are counted — which is how a 20-digit number passed here and then failed the store's own check
   * with a sentence on a dialog rather than beside the field.
   */
  cardNumber: z
    .string()
    .trim()
    .refine((value) => {
      if (value === "") return true;
      if (!/^(?:\d[ -]?)+$/.test(value)) return false;
      const digits = value.replace(/\D/g, "").length;
      return digits >= 12 && digits <= 19;
    }, "Enter a card number of 12 to 19 digits."),
  expiry: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || /^(0[1-9]|1[0-2])\s*\/\s*\d{2,4}$/.test(value),
      "Expiry date is written as MM/YY, for example 04/29.",
    ),
  cvv: z
    .string()
    .trim()
    .max(MAX_SHORT_FIELD, "The CVV must be short.")
    .regex(/^$|^\d{3,4}$/, "A CVV is 3 or 4 digits."),
  billingAddress: z
    .string()
    .trim()
    .max(
      MAX_ADDRESS,
      `Billing address must be ${MAX_ADDRESS} characters or fewer.`,
    ),
  notes: z
    .string()
    .trim()
    .max(MAX_NOTES, `Notes must be ${MAX_NOTES} characters or fewer.`),
});

export type VaultCardFormValues = z.infer<typeof vaultCardFormSchema>;

export const emptyVaultCardForm: VaultCardFormValues = {
  label: "",
  cardholderName: "",
  cardNumber: "",
  expiry: "",
  cvv: "",
  billingAddress: "",
  notes: "",
};

/**
 * The thirteen fields, all optional.
 *
 * Every field is `string()` rather than `string().min(1)`, on purpose: a blank field here means "not
 * written", which is a legitimate answer for all thirteen and the only answer for most people on most
 * of them. The date of birth is the one shape checked — a form with three date inputs is a form
 * everybody types a wrong year into.
 */
export const vaultPersonalInfoFormSchema = z.object({
  fullName: short("Full name"),
  preferredName: short("Preferred name"),
  email: short("Email"),
  phone: short("Phone"),
  /**
   * `YYYY-MM-DD`, checked as a shape and as a length.
   *
   * The length is `MAX_DATE` because a date of birth is ten characters and a longer one is a
   * mis-typed year rather than a date; the server caps it at the same ten. Nothing here parses it into
   * a Date: the value is shown on a form about the person and filled into somebody else's, and a
   * timezone is not a fact anybody wanted stored with a birthday.
   */
  dateOfBirth: z
    .string()
    .trim()
    .max(
      MAX_DATE,
      `Date of birth must be ${MAX_DATE} characters, as YYYY-MM-DD.`,
    )
    .refine(
      (value) => value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value),
      "Date of birth is written as YYYY-MM-DD.",
    ),
  address: z
    .string()
    .trim()
    .max(MAX_ADDRESS, `Address must be ${MAX_ADDRESS} characters or fewer.`),
  city: short("City"),
  state: short("State"),
  country: short("Country"),
  postalCode: short("Postal code"),
  company: short("Company"),
  jobTitle: short("Job title"),
  notes: z
    .string()
    .trim()
    .max(MAX_NOTES, `Notes must be ${MAX_NOTES} characters or fewer.`),
});

export type VaultPersonalInfoFormValues = z.infer<
  typeof vaultPersonalInfoFormSchema
>;

export const emptyVaultPersonalInfoForm: VaultPersonalInfoFormValues = {
  fullName: "",
  preferredName: "",
  email: "",
  phone: "",
  dateOfBirth: "",
  address: "",
  city: "",
  state: "",
  country: "",
  postalCode: "",
  company: "",
  jobTitle: "",
  notes: "",
};

/**
 * The kinds a person picks from, in the order they read best.
 *
 * `api_key` first because it is what most people arrive with, and `custom` last because it is the one
 * that means "none of these". The values are the store's wire vocabulary — the same list the agent's
 * tool descriptions are written from — so a kind cannot be spelled one way here and another there.
 */
export const VAULT_AGENT_ITEM_KINDS = [
  { value: "api_key", label: "API key" },
  { value: "access_token", label: "Access token" },
  { value: "secret", label: "Secret" },
  { value: "environment_variable", label: "Environment variable" },
  { value: "ssh_key", label: "SSH key" },
  { value: "recovery_code", label: "Recovery code" },
  { value: "custom", label: "Custom" },
] as const;

/** The same list as labels, for drawing a stored item's kind on a row. */
export const VAULT_AGENT_ITEM_KIND_LABELS: Record<string, string> =
  Object.fromEntries(
    VAULT_AGENT_ITEM_KINDS.map((kind) => [kind.value, kind.label]),
  );

export const VAULT_AGENT_ITEM_SCOPES = [
  {
    value: "agent",
    label: "Any task",
    description:
      "Any of your coworkers may use it, whenever the work needs it.",
  },
  {
    value: "integration",
    label: "One integration",
    description: "Only at the app you name below.",
  },
  {
    value: "task",
    label: "One task",
    description: "Only inside one job you name below.",
  },
] as const;

export const vaultAgentItemFormSchema = z.object({
  label: label("Name"),
  kind: z.enum([
    "api_key",
    "access_token",
    "secret",
    "environment_variable",
    "ssh_key",
    "recovery_code",
    "custom",
  ]),
  value: z
    .string()
    .max(MAX_VALUE, `Value must be ${MAX_VALUE} characters or fewer.`),
  description: z
    .string()
    .trim()
    .max(MAX_NOTES, `Description must be ${MAX_NOTES} characters or fewer.`),
  scope: z.enum(["agent", "task", "integration"]),
  /**
   * Which integration or task, when the scope is not "any task".
   *
   * Not required by the schema — the store does not refuse a scope with no referent either — because a
   * half-filled dropdown is not something to block a save over. The consequence of leaving it empty is
   * mild and is stated in the dialog: the narrowest rule that can be checked is the one in force.
   */
  scopeRef: z
    .string()
    .trim()
    .max(MAX_URL, `That must be ${MAX_URL} characters or fewer.`),
  /**
   * Apps and domains, one per line.
   *
   * A textarea of lines rather than a repeatable field: the list is at most twenty entries, nobody
   * types twenty of them, and a line-per-item control would be a second form system inside this
   * dialog for no gain.
   */
  allowedApps: z
    .string()
    .trim()
    .max(MAX_NOTES, `That must be ${MAX_NOTES} characters or fewer.`),
});

export type VaultAgentItemFormValues = z.infer<typeof vaultAgentItemFormSchema>;

export const emptyVaultAgentItemForm: VaultAgentItemFormValues = {
  label: "",
  kind: "api_key",
  value: "",
  description: "",
  scope: "agent",
  scopeRef: "",
  allowedApps: "",
};

/**
 * Group a card number as it is typed.
 *
 * FOUR DIGITS, THEN FOUR, THEN FOUR, then the rest in one group. Every real card number is 16 or 19
 * digits and both of those group cleanly; the tail group exists because the pattern has to do
 * something sensible with a 13-digit one rather than refuse to draw it.
 *
 * Spaces are added and existing ones dropped, so a paste of `4242 4242 4242 4242` and a paste of
 * `4242424242424242` both arrive the same. This is display only: the store strips non-digits before
 * it keeps anything.
 */
export function formatCardNumber(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 19);
  if (digits.length <= 4) return digits;
  if (digits.length <= 8) return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  if (digits.length <= 12) {
    return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`;
  }
  return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)} ${digits.slice(12)}`;
}

/**
 * A password to offer, not one to keep.
 *
 * GENERATED IN THE BROWSER and never sent anywhere until somebody types one in deliberately. Sixteen
 * characters from the alphabet below, which is 95 characters of real entropy per pick and therefore
 * about 105 bits — deliberately past anything a person would choose. Not from `crypto.getRandomValues`
 * of a charset because a modulo of a random byte over a charset biased it: 95 does not divide 256, so
 * the first 61 characters were a little likelier than the rest. Rejection sampling removes that, and
 * for sixteen characters the loop runs about 16 times.
 *
 * The alphabet excludes the characters that get autocorrected, mangled by a password manager's
 * "looks like a typo" heuristic, or read aloud wrongly: no quotes, no backslash, no space, and no
 * characters that differ only by shape. It keeps `-_.+=` because those survive most forms.
 */
const GENERATED_ALPHABET =
  "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_.+=@#%^&*";

export function generatePassword(length = 16): string {
  const out: string[] = [];
  const ceiling = 256 - (256 % GENERATED_ALPHABET.length);
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      // Drawn again rather than mapped, so every character in the alphabet is equally likely.
      if (byte >= ceiling) continue;
      out.push(GENERATED_ALPHABET[byte % GENERATED_ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join("");
}

/** The forms as the API accepts them, which is not what the form holds. */

export function vaultLoginInputFrom(
  values: VaultLoginFormValues,
  /** Present when editing: an untouched password box sends nothing, which keeps what is stored. */
  isEdit: boolean,
): VaultLoginInput {
  return {
    label: values.label.trim(),
    username: values.username.trim(),
    // NOT TRIMMED, and the one place in this file where that matters: leading and trailing spaces are
    // part of most passwords, and trimming them stores a password the person cannot log in with.
    //
    // On create, an empty box is an empty password — the store keeps absence, which is right. On edit,
    // an empty box is "I did not change it", and sending "" would delete the stored one.
    ...(isEdit && !values.password ? {} : { password: values.password }),
    websiteUrl: values.websiteUrl.trim(),
    notes: values.notes.trim(),
  };
}

export function vaultCardInputFrom(
  values: VaultCardFormValues,
  isEdit: boolean,
): VaultCardInput {
  return {
    label: values.label.trim(),
    cardholderName: values.cardholderName.trim(),
    // The number arrives already grouped by `formatCardNumber`; the store strips the spaces.
    ...(isEdit && !values.cardNumber
      ? {}
      : { cardNumber: values.cardNumber.trim() }),
    expiry: values.expiry.trim(),
    // The CVV is trimmed: unlike a password it is three digits from a signature panel, and the
    // leading space of a bad copy is a paste artefact rather than part of it.
    ...(isEdit && !values.cvv ? {} : { cvv: values.cvv.trim() }),
    billingAddress: values.billingAddress.trim(),
    notes: values.notes.trim(),
  };
}

export function vaultPersonalInfoInputFrom(
  values: VaultPersonalInfoFormValues,
): VaultPersonalInfoInput {
  // Trimmed here rather than left to the server, so the box the person sees after a save holds what
  // was actually stored — the same reason `standing-instructions.tsx` re-seeds its textarea.
  return {
    fullName: values.fullName.trim(),
    preferredName: values.preferredName.trim(),
    email: values.email.trim(),
    phone: values.phone.trim(),
    dateOfBirth: values.dateOfBirth.trim(),
    address: values.address.trim(),
    city: values.city.trim(),
    state: values.state.trim(),
    country: values.country.trim(),
    postalCode: values.postalCode.trim(),
    company: values.company.trim(),
    jobTitle: values.jobTitle.trim(),
    notes: values.notes.trim(),
  };
}

/** The allowed-apps textarea into the list the store keeps, one host per line. */
export function vaultAgentItemInputFrom(
  values: VaultAgentItemFormValues,
  isEdit: boolean,
): VaultAgentItemInput {
  return {
    label: values.label,
    kind: values.kind,
    // As with a password: an untouched box on an edit sends nothing rather than clearing the value.
    ...(isEdit && !values.value ? {} : { value: values.value }),
    description: values.description,
    scope: values.scope,
    scopeRef: values.scopeRef,
    allowedApps: values.allowedApps
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };
}
