import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";

/**
 * One person's saved information: logins, cards, personal details, and the items a Bot is allowed
 * to reach for.
 *
 * WHY THIS IS FOUR TABLES AND NOT ONE. A login has a username and a password and nothing else; a card
 * has a number, an expiry and a CVV; personal information is mostly prose about a person and holds
 * no secret worth an envelope. Folding them into one row with a `kind` discriminator would mean every
 * query a person makes — the one card list, the one login list — selects every column of every kind
 * and filters in application code, so the password envelope of a login travels through the card list
 * on the way to being discarded. Four tables means each list only ever holds the columns that list
 * renders, and the secret columns live on exactly the two tables that have them.
 *
 * WHAT EVERY TABLE HERE SHARES.
 *
 * Every row belongs to exactly one person through `user_id`, which cascades from `users`: deleting an
 * account deletes the vault with it rather than leaving an orphan nobody can reach or clean up. That
 * column is the entire authorization model. There is no role, no administrator, and no override,
 * because Remii has none — see `auth/guards.ts` — so the only question a query asks is "is this row
 * this person's", and it is asked in the `where` of every single one.
 *
 * ENCRYPTION. Every column that holds a secret holds a `{version, iv, ciphertext}` envelope
 * produced by `encryptSecret` in `server/src/credentials.ts`, with the deployment's
 * `KEY_ENCRYPTION_KEY`. Nothing here is plaintext at rest, and the DTO layer never carries a
 * plaintext value back out: a list answers with a mask, and the only endpoints that decrypt are the
 * ones a person clicked "Copy" or a Bot asked to use an item by name.
 */
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * `updatedAt` has no database trigger anywhere in this schema — every writer sets it. Stated here so
 * the next column does not get a trigger that the other fifty tables do not have.
 */
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull();

/**
 * Usage bookkeeping, identical on all four tables.
 *
 * Present now because `use_login` and friends already have to write an audit row per call, and
 * counting the call is the same write. Built now so that "last used", "most used" and "recently used"
 * are filters over existing columns rather than a second migration plus a second index family later.
 *
 * `usedByAgentId` is an id rather than a reference: a coworker's row can be deleted while the trail
 * of what it reached for is still the answer to "who used this". The audit table carries the same
 * rule for the same reason (`core.ts`, `audit_events`).
 */
const usageColumns = {
  /** When an item was last handed to something acting for this person. Null means never used. */
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  /** Which coworker last reached for it. Not a foreign key; see the note above. */
  usedByAgentId: text("used_by_agent_id"),
  /** How many times it has been handed over. Cheap, and the only column a cap would need. */
  usageCount: integer("usage_count").notNull().default(0),
  /**
   * A person's own label for an item, kept beside the name the row already has.
   *
   * Empty rather than absent, so "not tagged" is one comparison rather than a null check beside it.
   * Search, sorting and grouping are the reason this exists and none of them have a screen yet: the
   * column is here so adding them is a query rather than a migration.
   */
  tags: text("tags").array().notNull().default([]),
} as const;

export const vaultLogins = pgTable(
  "vault_logins",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "Google", "Company VPN" — what the person calls this login on their own screen. */
    label: text("label").notNull(),
    username: text("username").notNull(),
    /**
     * The password, as an AES-GCM envelope. Never selected into a list DTO; see the header.
     *
     * Nullable because a login with no password is a real thing — a shared account somebody else
     * holds, a site that only wants the username — and an empty string would have to be read back
     * and decoded to discover that. Absent is the absence.
     */
    passwordEncrypted: text("password_encrypted"),
    /** Where to type it. Stored as given and parsed only when something actually navigates. */
    websiteUrl: text("website_url"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ...usageColumns,
  },
  (table) => [
    /*
     * One listing per owner, ordered by name, plus the owner itself as the leading column: every
     * list query filters on `user_id` and every one of them sorts, so a composite index serves both
     * rather than the owner scan and the sort fighting over one single-column index.
     */
    index("vault_logins_owner_label_idx").on(table.userId, table.label),
  ],
);

export const vaultCards = pgTable(
  "vault_cards",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "Personal Visa" — the person's name for it, never derived from the issuer. */
    label: text("label").notNull(),
    cardholderName: text("cardholder_name"),
    /** An envelope. The last four digits are also kept in the clear, for the masked list. */
    cardNumberEncrypted: text("card_number_encrypted").notNull(),
    /**
     * The last four digits, unencrypted and deliberately so.
     *
     * A mask has to be drawn without decrypting: the list endpoint must not be able to produce a
     * plaintext card number even accidentally, because that is the property the whole surface rests
     * on. Four digits cannot be spent, and `•••• 4242` is what a person recognises a card by.
     */
    last4: text("last4").notNull(),
    /** "MM/YY" as written. Formatted for a person, parsed only by something paying with it. */
    expiry: text("expiry"),
    /** An envelope, like the number. Never in a list, never in an audit payload. */
    cvvEncrypted: text("cvv_encrypted"),
    billingAddress: text("billing_address"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ...usageColumns,
  },
  (table) => [
    index("vault_cards_owner_label_idx").on(table.userId, table.label),
  ],
);

/**
 * One row per person, not a list.
 *
 * The spec asks for "personal info" as a section, and a list of competing addresses and phone
 * numbers is a thing nobody has wanted. The uniqueness of `user_id` is the whole design: it makes
 * "this person's details" a single row, so there is no ambiguity for an agent to resolve and no
 * question of which of three addresses to put on a form.
 *
 * No encrypted column, and that is a real decision rather than an omission. Every field here is
 * information a person fills into web forms under their own name — a CVV or a bearer token is a
 * secret, and a postal address is not one. Encrypting it would buy nothing an attacker could not get
 * from the form's own confirmation email, while costing the agent layer a decrypt it would have no
 * way to justify.
 */
export const vaultPersonalInfo = pgTable("vault_personal_info", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  fullName: text("full_name"),
  preferredName: text("preferred_name"),
  email: text("email"),
  phone: text("phone"),
  /** ISO `YYYY-MM-DD`. A date of birth is identity data, not a credential. */
  dateOfBirth: text("date_of_birth"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  country: text("country"),
  postalCode: text("postal_code"),
  company: text("company"),
  jobTitle: text("job_title"),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * The kinds of thing a Bot can be handed.
 *
 * An enum rather than free text because these are the choices the screen offers, and a typo in the
 * column would produce a row the agent layer cannot classify. `custom` is the escape hatch, so
 * nothing is lost when the list grows: a new kind is an enum value and a migration, which is what
 * "keep the data model extensible" means here. Adding an integration-specific kind does NOT touch
 * this enum — that belongs in `allowedApps` below, where an app name is vendor vocabulary and
 * `plugins.ts` keeps vendor vocabulary as text for exactly that reason.
 */
export const vaultAgentItemKind = pgEnum("vault_agent_item_kind", [
  "api_key",
  "access_token",
  "secret",
  "environment_variable",
  "ssh_key",
  "recovery_code",
  "custom",
]);

/**
 * How wide an item's reach is.
 *
 * `agent` is "any Bot this person runs, for any job". `task` and `integration` narrow it further and
 * are stored now, enforced loosely, because the enforcement UI does not exist yet: the honest
 * position is that the model carries the distinction and nothing yet queries on it, and saying so in
 * a comment is better than a `scope` column whose meaning is a guess. See `scopeRefusalNote` in
 * `tools.ts` for the one behaviour that IS enforced — an item scoped to a task refuses outside it.
 */
export const vaultAgentItemScope = pgEnum("vault_agent_item_scope", [
  "agent",
  "task",
  "integration",
]);

export const vaultAgentItems = pgTable(
  "vault_agent_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "Stripe API key". */
    label: text("label").notNull(),
    kind: vaultAgentItemKind("kind").notNull(),
    /**
     * The secret, as an envelope. A value long enough to be worth masking rather than a flag.
     *
     * Nullable for the same reason a login's password is: an item whose value is not written yet is
     * not an item holding "".
     */
    valueEncrypted: text("value_encrypted"),
    description: text("description"),
    scope: vaultAgentItemScope("scope").notNull().default("agent"),
    /**
     * Which integration or task an item is narrowed to, when `scope` is not `agent`.
     *
     * Free text on purpose: an integration here is "stripe", "linear", a web app's domain — vendor
     * vocabulary that changes without a migration, the same reasoning `plugins.ts` records for
     * `mcp_servers.provenance`.
     */
    scopeRef: text("scope_ref"),
    /**
     * Where this item may be used, as host patterns: "linkedin.com", "api.stripe.com".
     *
     * An empty array means "no restriction stated", which is deliberately NOT the same as "allowed
     * everywhere by decision". One representation of an unstated restriction and it is absence.
     */
    allowedApps: text("allowed_apps").array().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ...usageColumns,
  },
  (table) => [
    /*
     * One item per (owner, name). Two rows called "Stripe API key" is what makes an agent's lookup
     * ambiguous, and the person who could resolve the ambiguity is not the person holding the run.
     *
     * This index also serves the list, since every list filters on `user_id` and sorts on `label`.
     */
    uniqueIndex("vault_agent_items_owner_label_idx").on(
      table.userId,
      table.label,
    ),
  ],
);
