/**
 * One person's vault: the logins, cards, details and agent items a coworker may reach for.
 *
 * WHAT THIS IS. Four stores behind one interface, because the four kinds of thing have almost
 * nothing in common except who owns them. A login is a username and an envelope; a card is an
 * envelope, four clear digits and an expiry; personal information holds no envelope at all; an agent
 * item is an envelope plus a scope. One store with a `kind` discriminator would mean every read
 * selects the union of those columns and picks in application code — see the header on
 * `db/schema/vault.ts` for the argument at the schema level, which is the same one.
 *
 * THE RULE THAT SHAPES EVERY METHOD HERE. Ownership is the caller's id and nothing else. No method
 * accepts a `userId` from a body, a query string or an argument a browser or a model supplied, and
 * every read filters on it in the `where` rather than filtering a broader result afterwards. That is
 * what makes one person's id useless against another's row: the query asks for both at once and the
 * database has to satisfy both.
 *
 * A row that is not the caller's raises the same {@link VaultNotFoundError} a row that does not
 * exist raises, with the same sentence. A caller that can tell those apart can enumerate which ids
 * exist, and an id that exists somewhere is one step from the row behind it.
 *
 * SECRETS LEAVE THIS FILE ONLY WHERE A PERSON ASKED FOR ONE. {@link readLoginSecret} and its three
 * siblings are the only methods that decrypt, they are named after the act rather than after the
 * field, and each one bumps `usage_count` so "who used my Stripe key" is answerable from the row
 * itself. Lists return masks and never call them.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { reasonWithoutStatement } from "../db/query-failure";
import {
  type vaultAgentItemKind,
  type vaultAgentItemScope,
  vaultAgentItems,
  vaultCards,
  vaultLogins,
  vaultPersonalInfo,
} from "../db/schema";

/** The transaction type drizzle hands a `database.transaction` callback. */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * A row that is not the caller's, or is nobody's.
 *
 * One class and one sentence for both, and that is the property rather than an inconvenience: the
 * caller cannot tell "you may not have this" from "there is no such thing", so probing ids reveals
 * nothing about rows belonging to anyone else. The same reasoning `RoutineNotFoundError` records.
 */
export class VaultNotFoundError extends Error {
  constructor(message = "That vault item does not exist.") {
    super(message);
    this.name = "VaultNotFoundError";
  }
}

/**
 * A save that was refused before it reached the database.
 *
 * Carries the sentence verbatim rather than a code, because the sentence is what reaches the screen
 * beside the field that caused it, and a screen that has to map a code back to prose is a second copy
 * of the rules in the rules.
 */
export class VaultRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultRefusedError";
  }
}

/*
 * Limits, all in one place, all measured in code points because that is what `length` counts and what
 * the browser counts too — a limit measured in bytes surprises somebody typing a character with an
 * accent in it.
 *
 * Generous for a note, tight for a label: a label appears in a dropdown beside two others, and one
 * long enough to push the rest off the screen has cost somebody their place in the list.
 */
export const MAX_LABEL = 80;
export const MAX_USERNAME = 320;
export const MAX_URL = 2000;
export const MAX_NOTES = 4000;
export const MAX_VALUE = 16_000;
export const MAX_SHORT_FIELD = 200;
export const MAX_ADDRESS = 1000;
/** A birthday is `YYYY-MM-DD`. Widen the column and it stops being one date. */
export const MAX_DATE = 10;

/**
 * How many items of one kind a person may keep.
 *
 * A constant with a reason rather than a setting. It exists so one account cannot fill the table and
 * turn every other person's list into a slow query, and it is set where the answer stops being
 * useful rather than where the database starts complaining: somebody with four hundred logins has a
 * problem no list, no search and no folder would fix.
 */
export const MAX_LOGINS = 200;
export const MAX_CARDS = 50;
export const MAX_AGENT_ITEMS = 300;

function label(value: unknown, what = "Name"): string {
  if (typeof value !== "string") {
    throw new VaultRefusedError(`${what} is required.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new VaultRefusedError(`${what} is required.`);
  }
  if (trimmed.length > MAX_LABEL) {
    throw new VaultRefusedError(
      `${what} must be ${MAX_LABEL} characters or fewer.`,
    );
  }
  return trimmed;
}

/**
 * An optional free-text field.
 *
 * Absent and empty both become null, so one representation of "not written" and it is the database's.
 * A row that stored "" for a blank address and null for an absent one would make every future
 * `coalesce` a decision somebody has to remember.
 */
function optional(value: unknown, limit: number, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new VaultRefusedError(`${what} must be text.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > limit) {
    throw new VaultRefusedError(
      `${what} must be ${limit} characters or fewer.`,
    );
  }
  return trimmed;
}

/**
 * A required field that is an IDENTIFIER, and is trimmed.
 *
 * A username, a name, a card number. Surrounding whitespace on an identifier is never part of it —
 * `"  me@example.com  "` is a string that fails to log in and a person would never understand why —
 * so it is trimmed here rather than being a puzzle the agent hits at the login box.
 */
function required(value: unknown, limit: number, what: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new VaultRefusedError(`${what} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > limit) {
    throw new VaultRefusedError(
      `${what} must be ${limit} characters or fewer.`,
    );
  }
  return trimmed;
}

/**
 * A web address, checked for shape and otherwise left alone.
 *
 * Shape only, and deliberately: this deployment dials arbitrary addresses for its own reasons (see
 * `agentEndpoint` validation in `agents/`), so refusing an address here would be a second, different
 * policy about the same string. The field is a note for a person and a hint for a Bot.
 */
function url(value: unknown): string | null {
  const text = optional(value, MAX_URL, "Website URL");
  if (text === null) return null;
  if (!/^https?:\/\/\S+$/i.test(text)) {
    throw new VaultRefusedError(
      "Enter a web address starting with http:// or https://.",
    );
  }
  return text;
}

/**
 * The last four digits of a card number, kept in the clear so a mask can be drawn without decrypting.
 *
 * See the note on the column: the list endpoint must be structurally incapable of producing a
 * plaintext card number, and four digits cannot be spent.
 */
export function cardLast4(cardNumber: string): string {
  const digits = cardNumber.replace(/\D/g, "");
  return digits.slice(-4).padStart(4, "•");
}

/**
 * Digits only, of whatever length the issuer issued.
 *
 * Written once because it is used by two callers that must agree: the card writer, which needs the
 * clean digits to store the last four, and the agent layer, which needs them to fill a payment form.
 */
export function cardDigits(cardNumber: string): string {
  const digits = cardNumber.replace(/\D/g, "");
  if (digits.length < 12 || digits.length > 19) {
    throw new VaultRefusedError("Enter a card number of 12 to 19 digits.");
  }
  return digits;
}

/** `MM/YY`, as a person writes it. Kept as written; parsing belongs to whatever spends the card. */
function expiry(value: unknown): string | null {
  const text = optional(value, MAX_SHORT_FIELD, "Expiry date");
  if (text === null) return null;
  if (!/^(0[1-9]|1[0-2])\s*\/\s*\d{2,4}$/.test(text)) {
    throw new VaultRefusedError(
      "Expiry date is written as MM/YY, for example 04/29.",
    );
  }
  return text;
}

const KINDS: readonly string[] = [
  "api_key",
  "access_token",
  "secret",
  "environment_variable",
  "ssh_key",
  "recovery_code",
  "custom",
];

const SCOPES: readonly string[] = ["agent", "task", "integration"];

function kind(value: unknown): (typeof vaultAgentItemKind.enumValues)[number] {
  if (typeof value !== "string" || !KINDS.includes(value)) {
    throw new VaultRefusedError("Choose what kind of item this is.");
  }
  return value as (typeof vaultAgentItemKind.enumValues)[number];
}

function scope(
  value: unknown,
): (typeof vaultAgentItemScope.enumValues)[number] {
  if (value === undefined || value === null) return "agent";
  if (typeof value !== "string" || !SCOPES.includes(value)) {
    throw new VaultRefusedError("Choose how wide this item's reach is.");
  }
  return value as (typeof vaultAgentItemScope.enumValues)[number];
}

/**
 * Hosts an item may be spent on, given as the person typed them.
 *
 * Not validated as URLs and not normalised beyond trimming and dropping a scheme, because the test
 * that matters is "does this match where we are about to type it", and that comparison belongs to
 * the caller that knows the destination. Empty means unstated, which is deliberately weaker than
 * "allowed everywhere by decision" and says so in the column's own note.
 */
function apps(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new VaultRefusedError("Allowed apps must be a list.");
  }
  if (value.length > 20) {
    throw new VaultRefusedError("An item may name at most 20 apps or domains.");
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new VaultRefusedError("Allowed apps must be text.");
    }
    const trimmed = entry
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "");
    if (!trimmed || trimmed.length > MAX_URL) {
      throw new VaultRefusedError("An app or domain must be a host name.");
    }
    return trimmed;
  });
}

/** One row as the list screens draw it: a mask, never an envelope and never a plaintext secret. */
export type VaultLoginSummary = {
  id: string;
  label: string;
  username: string;
  websiteUrl: string | null;
  notes: string | null;
  /**
   * Whether there is a password behind the mask. The mask itself is drawn either way — four fixed
   * dots, never a real length, because a real length tells an observer how strong somebody's password
   * is — so this is the only thing the list learns about it.
   */
  hasPassword: boolean;
  lastUsedAt: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type VaultCardSummary = {
  id: string;
  label: string;
  cardholderName: string | null;
  /** The masked number. Built from `last4` and never from a decrypt. */
  maskedNumber: string;
  expiry: string | null;
  hasCvv: boolean;
  billingAddress: string | null;
  notes: string | null;
  lastUsedAt: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type VaultPersonalInfoRecord = {
  fullName: string | null;
  preferredName: string | null;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  company: string | null;
  jobTitle: string | null;
  notes: string | null;
  updatedAt: string;
};

export type VaultAgentItemSummary = {
  id: string;
  label: string;
  kind: (typeof vaultAgentItemKind.enumValues)[number];
  description: string | null;
  scope: (typeof vaultAgentItemScope.enumValues)[number];
  scopeRef: string | null;
  allowedApps: string[];
  /** Whether there is a value behind the mask. See `hasPassword`. */
  hasValue: boolean;
  lastUsedAt: string | null;
  usedByAgentId: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

/** A login paired with the two things a Bot needs to sign in and neither of which it should read twice. */
export type VaultLoginSecret = {
  id: string;
  label: string;
  username: string;
  password: string;
  websiteUrl: string | null;
};

export type VaultCardSecret = {
  id: string;
  label: string;
  cardholderName: string | null;
  cardNumber: string;
  expiry: string | null;
  cvv: string | null;
  billingAddress: string | null;
};

export type VaultAgentItemSecret = {
  id: string;
  label: string;
  kind: (typeof vaultAgentItemKind.enumValues)[number];
  value: string;
  description: string | null;
  scope: (typeof vaultAgentItemScope.enumValues)[number];
  scopeRef: string | null;
  allowedApps: string[];
};

export type VaultCreate = {
  logins: {
    label: string;
    username: string;
    password: string;
    websiteUrl?: string | null;
    notes?: string | null;
  };
  cards: {
    label: string;
    cardholderName?: string | null;
    cardNumber: string;
    expiry?: string | null;
    cvv?: string | null;
    billingAddress?: string | null;
    notes?: string | null;
  };
  agentItems: {
    label: string;
    kind: string;
    value: string;
    description?: string | null;
    scope?: string;
    scopeRef?: string | null;
    allowedApps?: string[];
  };
};

/**
 * Every field a person may change, each one optional.
 *
 * `password` is here as `password: null`-able for cards' CVV's sake, but on a login a save that
 * omits it keeps what is stored and a save that sends `null` clears it — so the route and the form
 * both have to make the distinction deliberate. That is the correct amount of friction for a secret.
 */
export type VaultUpdate = {
  logins: Partial<{
    label: string;
    username: string;
    password: string | null;
    websiteUrl: string | null;
    notes: string | null;
  }>;
  cards: Partial<{
    label: string;
    cardholderName: string | null;
    cardNumber: string | null;
    expiry: string | null;
    cvv: string | null;
    billingAddress: string | null;
    notes: string | null;
  }>;
  agentItems: Partial<{
    label: string;
    kind: string;
    value: string | null;
    description: string | null;
    scope: string;
    scopeRef: string | null;
    allowedApps: string[];
  }>;
};

export type VaultStore = {
  listLogins: (userId: string) => Promise<VaultLoginSummary[]>;
  createLogin: (
    userId: string,
    input: VaultCreate["logins"],
  ) => Promise<VaultLoginSummary>;
  updateLogin: (
    userId: string,
    id: string,
    patch: VaultUpdate["logins"],
  ) => Promise<VaultLoginSummary>;
  removeLogin: (userId: string, id: string) => Promise<void>;
  /** The one path that returns a password. Increments usage. */
  readLoginSecret: (input: {
    userId: string;
    id?: string;
    label?: string;
    agentId?: string;
  }) => Promise<VaultLoginSecret>;

  listCards: (userId: string) => Promise<VaultCardSummary[]>;
  createCard: (
    userId: string,
    input: VaultCreate["cards"],
  ) => Promise<VaultCardSummary>;
  updateCard: (
    userId: string,
    id: string,
    patch: VaultUpdate["cards"],
  ) => Promise<VaultCardSummary>;
  removeCard: (userId: string, id: string) => Promise<void>;
  /** The one path that returns a card number and a CVV. Increments usage. */
  readCardSecret: (input: {
    userId: string;
    id?: string;
    label?: string;
    agentId?: string;
  }) => Promise<VaultCardSecret>;

  /**
   * One row or null. Personal information is the one kind that is legitimately absent, so it answers
   * "not written yet" rather than raising — the same distinction `user-instructions.ts` draws
   * between null and "".
   */
  readPersonalInfo: (userId: string) => Promise<VaultPersonalInfoRecord | null>;
  writePersonalInfo: (
    userId: string,
    fields: Partial<{
      fullName: string | null;
      preferredName: string | null;
      email: string | null;
      phone: string | null;
      dateOfBirth: string | null;
      address: string | null;
      city: string | null;
      state: string | null;
      country: string | null;
      postalCode: string | null;
      company: string | null;
      jobTitle: string | null;
      notes: string | null;
    }>,
  ) => Promise<VaultPersonalInfoRecord>;

  listAgentItems: (userId: string) => Promise<VaultAgentItemSummary[]>;
  createAgentItem: (
    userId: string,
    input: VaultCreate["agentItems"],
  ) => Promise<VaultAgentItemSummary>;
  updateAgentItem: (
    userId: string,
    id: string,
    patch: VaultUpdate["agentItems"],
  ) => Promise<VaultAgentItemSummary>;
  removeAgentItem: (userId: string, id: string) => Promise<void>;
  /** The one path that returns an agent item's value. Increments usage. */
  readAgentItemSecret: (input: {
    userId: string;
    id?: string;
    label?: string;
    agentId?: string;
  }) => Promise<VaultAgentItemSecret>;

  /**
   * Personal information, asked for by field name.
   *
   * Separate from {@link readPersonalInfo} because the shapes differ in what they are FOR: this one
   * returns only the fields a task named, so "fill in the shipping address" cannot pull a phone number
   * and a date of birth along with it. A caller that wants the lot is asking for the lot.
   */
  personalInfoFields: (
    userId: string,
    fields: string[],
  ) => Promise<Record<string, string>>;
};

function loginSummary(row: typeof vaultLogins.$inferSelect): VaultLoginSummary {
  return {
    id: row.id,
    label: row.label,
    username: row.username,
    websiteUrl: row.websiteUrl,
    notes: row.notes,
    hasPassword: row.passwordEncrypted !== null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    usageCount: row.usageCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function cardSummary(row: typeof vaultCards.$inferSelect): VaultCardSummary {
  return {
    id: row.id,
    label: row.label,
    cardholderName: row.cardholderName,
    maskedNumber: `•••• •••• •••• ${row.last4}`,
    expiry: row.expiry,
    hasCvv: row.cvvEncrypted !== null,
    billingAddress: row.billingAddress,
    notes: row.notes,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    usageCount: row.usageCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function agentItemSummary(
  row: typeof vaultAgentItems.$inferSelect,
): VaultAgentItemSummary {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    description: row.description,
    scope: row.scope,
    scopeRef: row.scopeRef,
    allowedApps: [...row.allowedApps],
    hasValue: row.valueEncrypted !== null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    usedByAgentId: row.usedByAgentId,
    usageCount: row.usageCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function personalInfoRecord(
  row: typeof vaultPersonalInfo.$inferSelect,
): VaultPersonalInfoRecord {
  return {
    fullName: row.fullName,
    preferredName: row.preferredName,
    email: row.email,
    phone: row.phone,
    dateOfBirth: row.dateOfBirth,
    address: row.address,
    city: row.city,
    state: row.state,
    country: row.country,
    postalCode: row.postalCode,
    company: row.company,
    jobTitle: row.jobTitle,
    notes: row.notes,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The personal-information fields, and the wire names a task may use for them.
 *
 * Both halves are one object on purpose. A caller names `postal_code` and gets the `postal_code`
 * column, and there is no second list to fall out of step — the set of names a model may use IS the
 * set of columns that exist.
 */
const PERSONAL_FIELDS = {
  fullName: "full_name",
  preferredName: "preferred_name",
  email: "email",
  phone: "phone",
  dateOfBirth: "date_of_birth",
  address: "address",
  city: "city",
  state: "state",
  country: "country",
  postalCode: "postal_code",
  company: "company",
  jobTitle: "job_title",
  notes: "notes",
} as const;

type PersonalFieldName = keyof typeof PERSONAL_FIELDS;

const PERSONAL_FIELD_NAMES = Object.keys(
  PERSONAL_FIELDS,
) as PersonalFieldName[];

/** Strips separators, so `postal_code`, `postalCode` and `Postal Code` are one name rather than three. */
function squashed(name: string): string {
  return name.replaceAll(/[^a-zA-Z]/g, "").toLowerCase();
}

/**
 * Accepts `postalCode`, `postal_code` and `postal code` for one column.
 *
 * A model writes field names in prose, and refusing a task over a spelling would be a refusal about
 * punctuation. Matching the column name as well as the property name is what makes all three land on
 * the same column rather than on none.
 */
function personalFieldName(name: string): PersonalFieldName | null {
  const wanted = squashed(name);
  if (!wanted) return null;
  return (
    PERSONAL_FIELD_NAMES.find(
      (candidate) =>
        squashed(candidate) === wanted ||
        squashed(PERSONAL_FIELDS[candidate]) === wanted,
    ) ?? null
  );
}

/**
 * A constraint violation a caller can act on, told apart from every other database complaint.
 *
 * Raised for the two rules a person can hit by accident: the per-kind item cap, and two agent items
 * with the same name. Both arrive from the database as `databaseComplaint()` prose otherwise, which
 * is correct for a fault and useless as a sentence on a screen.
 */
function refusalFrom(error: unknown): Error | null {
  const complaint = reasonWithoutStatement(error);
  if (!/duplicate key|unique constraint/i.test(complaint)) return null;
  return new VaultRefusedError(
    "You already have an item with that name in your vault.",
  );
}

export function createVaultStore(
  database: Database,
  encryptionKey: string,
): VaultStore {
  /**
   * One item by id, owned.
   *
   * The `and` is the whole authorization model. Filtering a list afterwards would mean the foreign row
   * was read, and this is a table where reading a row means holding its envelope in memory.
   */
  async function ownedLogin(userId: string, id: string) {
    const [row] = await database
      .select()
      .from(vaultLogins)
      .where(and(eq(vaultLogins.id, id), eq(vaultLogins.userId, userId)))
      .limit(1);
    if (!row) throw new VaultNotFoundError();
    return row;
  }

  async function ownedCard(userId: string, id: string) {
    const [row] = await database
      .select()
      .from(vaultCards)
      .where(and(eq(vaultCards.id, id), eq(vaultCards.userId, userId)))
      .limit(1);
    if (!row) throw new VaultNotFoundError();
    return row;
  }

  async function ownedAgentItem(userId: string, id: string) {
    const [row] = await database
      .select()
      .from(vaultAgentItems)
      .where(
        and(eq(vaultAgentItems.id, id), eq(vaultAgentItems.userId, userId)),
      )
      .limit(1);
    if (!row) throw new VaultNotFoundError();
    return row;
  }

  /**
   * One agent item by name, owned.
   *
   * A model says "the Stripe key" rather than an id, so name lookup is a first-class path rather than
   * a list-then-filter. Unique per owner, so at most one row can answer.
   */
  async function ownedAgentItemByLabel(userId: string, name: string) {
    const [row] = await database
      .select()
      .from(vaultAgentItems)
      .where(
        and(
          eq(vaultAgentItems.userId, userId),
          eq(vaultAgentItems.label, name),
        ),
      )
      .limit(1);
    if (!row) throw new VaultNotFoundError();
    return row;
  }

  /**
   * How many rows of one kind this owner already has, on a given handle.
   *
   * Takes the handle rather than closing over `database` because the cap only holds if the count and
   * the write share one transaction: a count on a different pooled connection cannot see the
   * uncommitted row a racing create is about to add, which is the exact blindness the cap exists to
   * prevent. The same argument `routines/store.ts` makes for counting inside its advisory lock.
   */
  async function countFor(
    transaction: Transaction,
    which: "logins" | "cards" | "agentItems",
    userId: string,
  ): Promise<number> {
    const total = sql<number>`count(*)::int`;
    const [row] =
      which === "logins"
        ? await transaction
            .select({ total })
            .from(vaultLogins)
            .where(eq(vaultLogins.userId, userId))
        : which === "cards"
          ? await transaction
              .select({ total })
              .from(vaultCards)
              .where(eq(vaultCards.userId, userId))
          : await transaction
              .select({ total })
              .from(vaultAgentItems)
              .where(eq(vaultAgentItems.userId, userId));
    return row?.total ?? 0;
  }

  /**
   * Insert under a per-owner cap, or refuse.
   *
   * `write` takes the transaction so the insert joins the one holding the count rather than opening a
   * second pooled connection, which would make the cap advisory — and a cap that can be raced past is
   * not a cap. Three kinds through one helper because the columns do not otherwise share a shape, and
   * three near-identical functions would drift.
   */
  async function insertUnder<T>(input: {
    which: "logins" | "cards" | "agentItems";
    userId: string;
    cap: number;
    what: string;
    write: (transaction: Transaction) => Promise<T>;
  }): Promise<T> {
    return await database.transaction(async (transaction) => {
      if (
        (await countFor(transaction, input.which, input.userId)) >= input.cap
      ) {
        throw new VaultRefusedError(
          `Your vault already holds ${input.cap} ${input.what}, which is as many as it keeps.`,
        );
      }
      return await input.write(transaction);
    });
  }

  /**
   * Which of the two things a caller named. Exactly one is set.
   *
   * A model supplies a name and a person clicking "Copy" supplies an id, and they must not be two code
   * paths that could disagree about who owns the answer — so they are resolved to one of two shapes here
   * and every reader below branches on which. A discriminated union rather than two optional properties,
   * so `row.name` needs no assertion: the shape says it is there.
   */
  type Named = { by: "id"; id: string } | { by: "label"; label: string };

  function named(id: string | undefined, name: string | undefined): Named {
    if (id) return { by: "id", id };
    if (name) return { by: "label", label: name };
    throw new VaultRefusedError("Say which item to use.");
  }

  return {
    async listLogins(userId) {
      const rows = await database
        .select()
        .from(vaultLogins)
        .where(eq(vaultLogins.userId, userId))
        .orderBy(asc(vaultLogins.label), asc(vaultLogins.id));
      return rows.map(loginSummary);
    },

    async createLogin(userId, input) {
      const values = {
        id: `vault_login_${crypto.randomUUID()}`,
        userId,
        label: label(input.label, "Website or app"),
        username: required(input.username, MAX_USERNAME, "Username or email"),
        passwordEncrypted:
          typeof input.password === "string" && input.password
            ? await encryptSecret(encryptionKey, input.password)
            : null,
        websiteUrl: url(input.websiteUrl),
        notes: optional(input.notes, MAX_NOTES, "Notes"),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      try {
        const [row] = await insertUnder({
          which: "logins",
          userId,
          cap: MAX_LOGINS,
          what: "logins",
          write: (transaction) =>
            transaction.insert(vaultLogins).values(values).returning(),
        });
        if (!row) throw new Error("inserting a vault login returned no row");
        return loginSummary(row);
      } catch (error) {
        const refusal = refusalFrom(error);
        if (refusal) throw refusal;
        throw error;
      }
    },

    async updateLogin(userId, id, patch) {
      await ownedLogin(userId, id);
      const values: Partial<typeof vaultLogins.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (patch.label !== undefined)
        values.label = label(patch.label, "Website or app");
      if (patch.username !== undefined) {
        values.username = required(
          patch.username,
          MAX_USERNAME,
          "Username or email",
        );
      }
      // Absent keeps what is stored; a null clears it. Never "empty means unchanged" by accident.
      if (patch.password !== undefined) {
        values.passwordEncrypted =
          patch.password === null || !patch.password
            ? null
            : await encryptSecret(encryptionKey, patch.password);
      }
      if (patch.websiteUrl !== undefined)
        values.websiteUrl = url(patch.websiteUrl);
      if (patch.notes !== undefined) {
        values.notes = optional(patch.notes, MAX_NOTES, "Notes");
      }
      const [row] = await database
        .update(vaultLogins)
        .set(values)
        .where(and(eq(vaultLogins.id, id), eq(vaultLogins.userId, userId)))
        .returning();
      if (!row) throw new VaultNotFoundError();
      return loginSummary(row);
    },

    async removeLogin(userId, id) {
      await ownedLogin(userId, id);
      await database
        .delete(vaultLogins)
        .where(and(eq(vaultLogins.id, id), eq(vaultLogins.userId, userId)));
    },

    async readLoginSecret({ userId, id, label: name, agentId }) {
      const wanted = named(id, name);
      const row =
        wanted.by === "id"
          ? await ownedLogin(userId, wanted.id)
          : await ownedLogin(
              userId,
              await loginIdForLabel(userId, wanted.label),
            );

      await noteLoginUse(userId, row.id, agentId);

      if (!row.passwordEncrypted) {
        throw new VaultNotFoundError("That login has no password saved.");
      }
      return {
        id: row.id,
        label: row.label,
        username: row.username,
        password: await decryptSecret(encryptionKey, row.passwordEncrypted),
        websiteUrl: row.websiteUrl,
      };
    },

    async listCards(userId) {
      const rows = await database
        .select()
        .from(vaultCards)
        .where(eq(vaultCards.userId, userId))
        .orderBy(asc(vaultCards.label), asc(vaultCards.id));
      return rows.map(cardSummary);
    },

    async createCard(userId, input) {
      const digits = cardDigits(
        typeof input.cardNumber === "string" ? input.cardNumber : "",
      );
      const values = {
        id: `vault_card_${crypto.randomUUID()}`,
        userId,
        label: label(input.label, "Card name"),
        cardholderName: optional(
          input.cardholderName,
          MAX_SHORT_FIELD,
          "Cardholder name",
        ),
        cardNumberEncrypted: await encryptSecret(encryptionKey, digits),
        last4: digits.slice(-4),
        expiry: expiry(input.expiry),
        // Absent rather than an empty envelope: "has no CVV" and "has a CVV that decrypts to
        // nothing" are different rows, and the list draws them differently.
        cvvEncrypted:
          typeof input.cvv === "string" && input.cvv.trim()
            ? await encryptSecret(encryptionKey, input.cvv.trim())
            : null,
        billingAddress: optional(
          input.billingAddress,
          MAX_ADDRESS,
          "Billing address",
        ),
        notes: optional(input.notes, MAX_NOTES, "Notes"),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const [row] = await insertUnder({
        which: "cards",
        userId,
        cap: MAX_CARDS,
        what: "cards",
        write: (transaction) =>
          transaction.insert(vaultCards).values(values).returning(),
      });
      if (!row) throw new Error("inserting a vault card returned no row");
      return cardSummary(row);
    },

    async updateCard(userId, id, patch) {
      await ownedCard(userId, id);
      const values: Partial<typeof vaultCards.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (patch.label !== undefined)
        values.label = label(patch.label, "Card name");
      if (patch.cardholderName !== undefined) {
        values.cardholderName = optional(
          patch.cardholderName,
          MAX_SHORT_FIELD,
          "Cardholder name",
        );
      }
      if (patch.cardNumber !== undefined && patch.cardNumber !== null) {
        const digits = cardDigits(patch.cardNumber);
        values.cardNumberEncrypted = await encryptSecret(encryptionKey, digits);
        // Re-derived rather than kept: the old last4 belongs to the number that was just replaced,
        // and a mask showing four digits the card no longer has is worse than no mask.
        values.last4 = digits.slice(-4);
      }
      if (patch.expiry !== undefined) values.expiry = expiry(patch.expiry);
      if (patch.cvv !== undefined) {
        values.cvvEncrypted =
          patch.cvv === null || !patch.cvv.trim()
            ? null
            : await encryptSecret(encryptionKey, patch.cvv.trim());
      }
      if (patch.billingAddress !== undefined) {
        values.billingAddress = optional(
          patch.billingAddress,
          MAX_ADDRESS,
          "Billing address",
        );
      }
      if (patch.notes !== undefined) {
        values.notes = optional(patch.notes, MAX_NOTES, "Notes");
      }
      const [row] = await database
        .update(vaultCards)
        .set(values)
        .where(and(eq(vaultCards.id, id), eq(vaultCards.userId, userId)))
        .returning();
      if (!row) throw new VaultNotFoundError();
      return cardSummary(row);
    },

    async removeCard(userId, id) {
      await ownedCard(userId, id);
      await database
        .delete(vaultCards)
        .where(and(eq(vaultCards.id, id), eq(vaultCards.userId, userId)));
    },

    async readCardSecret({ userId, id, label: name, agentId }) {
      const wanted = named(id, name);
      const row =
        wanted.by === "id"
          ? await ownedCard(userId, wanted.id)
          : await ownedCard(userId, await cardIdForLabel(userId, wanted.label));

      await noteCardUse(userId, row.id, agentId);

      return {
        id: row.id,
        label: row.label,
        cardholderName: row.cardholderName,
        cardNumber: await decryptSecret(encryptionKey, row.cardNumberEncrypted),
        expiry: row.expiry,
        cvv: row.cvvEncrypted
          ? await decryptSecret(encryptionKey, row.cvvEncrypted)
          : null,
        billingAddress: row.billingAddress,
      };
    },

    async readPersonalInfo(userId) {
      const [row] = await database
        .select()
        .from(vaultPersonalInfo)
        .where(eq(vaultPersonalInfo.userId, userId))
        .limit(1);
      return row ? personalInfoRecord(row) : null;
    },

    async writePersonalInfo(userId, fields) {
      /*
       * The changed columns, and `updatedAt` with them. Typed as the insert row rather than a partial
       * of one because drizzle's `onConflictDoUpdate` takes an update source and a partial insert does
       * not narrow to it; the two objects below are built once and handed to both halves so the insert
       * and the update can never disagree about what was written.
       */
      const changed: Partial<typeof vaultPersonalInfo.$inferInsert> = {};
      /*
       * Every field is optional and every field is trimmed, so a form that posts its whole state and a
       * form that posts only what it changed store the same thing.
       *
       * Written out one assignment per field rather than looped over `PERSONAL_FIELDS`: a loop needs
       * the column name as a computed key, which is a cast on the insert, and a cast here is a hole
       * that would let a field name reach a column it does not belong to.
       */
      const set = (
        value: string | null | undefined,
        limit: number,
        what: string,
      ): string | null | undefined => optional(value, limit, what);

      if (fields.fullName !== undefined) {
        changed.fullName = set(fields.fullName, MAX_SHORT_FIELD, "Full name");
      }
      if (fields.preferredName !== undefined) {
        changed.preferredName = set(
          fields.preferredName,
          MAX_SHORT_FIELD,
          "Preferred name",
        );
      }
      if (fields.email !== undefined) {
        changed.email = set(fields.email, MAX_SHORT_FIELD, "Email");
      }
      if (fields.phone !== undefined) {
        changed.phone = set(fields.phone, MAX_SHORT_FIELD, "Phone");
      }
      if (fields.dateOfBirth !== undefined) {
        changed.dateOfBirth = set(
          fields.dateOfBirth,
          MAX_DATE,
          "Date of birth",
        );
      }
      if (fields.address !== undefined) {
        changed.address = set(fields.address, MAX_ADDRESS, "Address");
      }
      if (fields.city !== undefined) {
        changed.city = set(fields.city, MAX_SHORT_FIELD, "City");
      }
      if (fields.state !== undefined) {
        changed.state = set(fields.state, MAX_SHORT_FIELD, "State");
      }
      if (fields.country !== undefined) {
        changed.country = set(fields.country, MAX_SHORT_FIELD, "Country");
      }
      if (fields.postalCode !== undefined) {
        changed.postalCode = set(
          fields.postalCode,
          MAX_SHORT_FIELD,
          "Postal code",
        );
      }
      if (fields.company !== undefined) {
        changed.company = set(fields.company, MAX_SHORT_FIELD, "Company");
      }
      if (fields.jobTitle !== undefined) {
        changed.jobTitle = set(fields.jobTitle, MAX_SHORT_FIELD, "Job title");
      }
      if (fields.notes !== undefined) {
        changed.notes = set(fields.notes, MAX_NOTES, "Notes");
      }

      const [row] = await database
        .insert(vaultPersonalInfo)
        .values({ userId, updatedAt: new Date(), ...changed })
        .onConflictDoUpdate({
          target: vaultPersonalInfo.userId,
          set: { updatedAt: new Date(), ...changed },
        })
        .returning();
      if (!row) throw new Error("writing personal information returned no row");
      return personalInfoRecord(row);
    },

    async listAgentItems(userId) {
      const rows = await database
        .select()
        .from(vaultAgentItems)
        .where(eq(vaultAgentItems.userId, userId))
        .orderBy(asc(vaultAgentItems.label), asc(vaultAgentItems.id));
      return rows.map(agentItemSummary);
    },

    async createAgentItem(userId, input) {
      const values = {
        id: `vault_item_${crypto.randomUUID()}`,
        userId,
        label: label(input.label, "Name"),
        kind: kind(input.kind),
        valueEncrypted:
          typeof input.value === "string" && input.value
            ? await encryptSecret(encryptionKey, input.value)
            : null,
        description: optional(input.description, MAX_NOTES, "Description"),
        scope: scope(input.scope),
        scopeRef: optional(input.scopeRef, MAX_URL, "Scope"),
        allowedApps: apps(input.allowedApps),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      try {
        const [row] = await insertUnder({
          which: "agentItems",
          userId,
          cap: MAX_AGENT_ITEMS,
          what: "agent items",
          write: (transaction) =>
            transaction.insert(vaultAgentItems).values(values).returning(),
        });
        if (!row)
          throw new Error("inserting a vault agent item returned no row");
        return agentItemSummary(row);
      } catch (error) {
        const refusal = refusalFrom(error);
        if (refusal) throw refusal;
        throw error;
      }
    },

    async updateAgentItem(userId, id, patch) {
      await ownedAgentItem(userId, id);
      const values: Partial<typeof vaultAgentItems.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (patch.label !== undefined) values.label = label(patch.label, "Name");
      if (patch.kind !== undefined) values.kind = kind(patch.kind);
      if (patch.value !== undefined) {
        values.valueEncrypted =
          patch.value === null || !patch.value
            ? null
            : await encryptSecret(encryptionKey, patch.value);
      }
      if (patch.description !== undefined) {
        values.description = optional(
          patch.description,
          MAX_NOTES,
          "Description",
        );
      }
      if (patch.scope !== undefined) values.scope = scope(patch.scope);
      if (patch.scopeRef !== undefined) {
        values.scopeRef = optional(patch.scopeRef, MAX_URL, "Scope");
      }
      if (patch.allowedApps !== undefined)
        values.allowedApps = apps(patch.allowedApps);
      try {
        const [row] = await database
          .update(vaultAgentItems)
          .set(values)
          .where(
            and(eq(vaultAgentItems.id, id), eq(vaultAgentItems.userId, userId)),
          )
          .returning();
        if (!row) throw new VaultNotFoundError();
        return agentItemSummary(row);
      } catch (error) {
        const refusal = refusalFrom(error);
        if (refusal) throw refusal;
        throw error;
      }
    },

    async removeAgentItem(userId, id) {
      await ownedAgentItem(userId, id);
      await database
        .delete(vaultAgentItems)
        .where(
          and(eq(vaultAgentItems.id, id), eq(vaultAgentItems.userId, userId)),
        );
    },

    async readAgentItemSecret({ userId, id, label: name, agentId }) {
      const wanted = named(id, name);
      const row =
        wanted.by === "id"
          ? await ownedAgentItem(userId, wanted.id)
          : await ownedAgentItemByLabel(userId, wanted.label);

      await noteAgentItemUse(userId, row.id, agentId);

      if (!row.valueEncrypted) {
        throw new VaultNotFoundError("That agent item has no value saved.");
      }
      return {
        id: row.id,
        label: row.label,
        kind: row.kind,
        value: await decryptSecret(encryptionKey, row.valueEncrypted),
        description: row.description,
        scope: row.scope,
        scopeRef: row.scopeRef,
        allowedApps: [...row.allowedApps],
      };
    },

    async personalInfoFields(userId, fields) {
      const [row] = await database
        .select()
        .from(vaultPersonalInfo)
        .where(eq(vaultPersonalInfo.userId, userId))
        .limit(1);
      if (!row) return {};

      // Nothing was named, so nothing is returned. The alternative — the whole row — is how a task
      // that wanted a postcode ends up with a date of birth.
      if (!fields.length) return {};

      const answer: Record<string, string> = {};
      for (const asked of fields) {
        const name = personalFieldName(asked);
        if (!name) continue;
        const value = row[name];
        if (value) answer[name] = value;
      }
      return answer;
    },
  };

  /** The id of a login named `name`, owned. Same not-found rule as every other lookup here. */
  async function loginIdForLabel(
    userId: string,
    name: string,
  ): Promise<string> {
    const [row] = await database
      .select({ id: vaultLogins.id })
      .from(vaultLogins)
      .where(and(eq(vaultLogins.userId, userId), eq(vaultLogins.label, name)))
      .limit(1);
    if (!row)
      throw new VaultNotFoundError("No login by that name in your vault.");
    return row.id;
  }

  /** The id of a card named `name`, owned. */
  async function cardIdForLabel(userId: string, name: string): Promise<string> {
    const [row] = await database
      .select({ id: vaultCards.id })
      .from(vaultCards)
      .where(and(eq(vaultCards.userId, userId), eq(vaultCards.label, name)))
      .limit(1);
    if (!row)
      throw new VaultNotFoundError("No card by that name in your vault.");
    return row.id;
  }

  /**
   * Count this use, and say who used it.
   *
   * Three near-identical updates rather than one function taking three tables and three columns: the
   * union of drizzle's three table types is not a thing `update` accepts, so the shared version needed
   * a cast, and a cast around a statement that writes an owner filter is exactly where a missing
   * filter would go unnoticed. Three copies of a four-line update that cannot be wrong about which
   * table it is writing is the better trade.
   *
   * AWAITED, which is the half that was wrong at first. Fire-and-forget lost counts: two uses in the
   * same tick both read `usage_count = 0`, both wrote 1, and the row said one use when there had been
   * two. The increment is `count = count + 1` in SQL so two writers cannot overwrite each other's
   * arithmetic, but a read-then-assert still misses an uncommitted sibling, so the caller waits for
   * its own write.
   *
   * Failures are still swallowed, deliberately, and that is the other half of the decision: a person
   * copying a password should not be shown an error because a counter did not tick. Nothing about the
   * caught error reaches the log either — drizzle puts the statement and every bound value in its
   * message, and the row that was just read is one of them.
   */
  async function noteUse(input: {
    userId: string;
    id: string;
    write: () => Promise<unknown>;
  }): Promise<void> {
    const { userId, id, write } = input;
    try {
      await write();
    } catch {
      console.warn(
        JSON.stringify({
          type: "vault-usage-note-failed",
          userId,
          itemId: id,
          detail: "The vault could not record this use.",
        }),
      );
    }
  }

  /**
   * The timestamp and counter half, shared by the three updates below.
   *
   * Passed a closure rather than a table because `usageCount` has to increment in SQL, and the column
   * that does that belongs to the table — which is exactly the thing a shared function cannot name
   * without a cast.
   */
  function useMark(agentId: string | undefined): {
    lastUsedAt: Date;
    usedByAgentId?: string;
  } {
    return {
      lastUsedAt: new Date(),
      ...(agentId ? { usedByAgentId: agentId } : {}),
    };
  }

  /** The same update against `vault_logins`, scoped to its owner. */
  async function noteLoginUse(
    userId: string,
    id: string,
    agentId?: string,
  ): Promise<void> {
    await noteUse({
      userId,
      id,
      write: () =>
        database
          .update(vaultLogins)
          .set({
            usageCount: sql`${vaultLogins.usageCount} + 1`,
            ...useMark(agentId),
          })
          .where(and(eq(vaultLogins.id, id), eq(vaultLogins.userId, userId))),
    });
  }

  /** The same update against `vault_cards`, scoped to its owner. */
  async function noteCardUse(
    userId: string,
    id: string,
    agentId?: string,
  ): Promise<void> {
    await noteUse({
      userId,
      id,
      write: () =>
        database
          .update(vaultCards)
          .set({
            usageCount: sql`${vaultCards.usageCount} + 1`,
            ...useMark(agentId),
          })
          .where(and(eq(vaultCards.id, id), eq(vaultCards.userId, userId))),
    });
  }

  /** The same update against `vault_agent_items`, scoped to its owner. */
  async function noteAgentItemUse(
    userId: string,
    id: string,
    agentId?: string,
  ): Promise<void> {
    await noteUse({
      userId,
      id,
      write: () =>
        database
          .update(vaultAgentItems)
          .set({
            usageCount: sql`${vaultAgentItems.usageCount} + 1`,
            ...useMark(agentId),
          })
          .where(
            and(eq(vaultAgentItems.id, id), eq(vaultAgentItems.userId, userId)),
          ),
    });
  }
}
