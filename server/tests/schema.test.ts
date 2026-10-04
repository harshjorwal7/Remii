import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema";
import {
  accounts,
  agentPreferences,
  agentProfiles,
  agents,
  agentVisibility,
  auditEvents,
  channelAgents,
  channelMemberships,
  channels,
  credentialKind,
  credentials,
  intelligenceChannelMappings,
  mcpUserCredentials,
  sessions,
  userInstructions,
  users,
  verifications,
} from "../src/db/schema";

describe("Remii database schema", () => {
  /*
   * `user_roles` is gone from this list, and from the schema with it.
   *
   * Roles went when the administrator did: individual-user SaaS has no role to assign, so the table
   * had no writer and every account is exactly one user. The import failing here is not a typo to fix
   * — it is the surface reporting that a table this test still listed no longer exists, which is the
   * same fact the deleted `roles.test.ts` recorded.
   */
  test("defines the core runtime records", () => {
    expect(
      [
        users,
        sessions,
        accounts,
        verifications,
        agents,
        channels,
        channelMemberships,
        channelAgents,
        credentials,
        auditEvents,
        intelligenceChannelMappings,
        userInstructions,
      ].map(getTableName),
    ).toEqual([
      "users",
      "sessions",
      "accounts",
      "verifications",
      "agents",
      "channels",
      "channel_memberships",
      "channel_agents",
      "credentials",
      "audit_events",
      "intelligence_channel_mappings",
      "user_instructions",
    ]);
  });

  test("names the two kinds of OAuth secret separately from a shared token", () => {
    /*
     * Three different things, three names. `mcp` is one token an administrator holds for everybody.
     * An OAuth client belongs to the deployment and reaches nobody's data by itself; a refresh token
     * belongs to one person and reaches everything they can see. Filing all three under `mcp` would
     * make "what does this deployment hold" unanswerable without reading the metadata of every row,
     * and it is the question the vault exists to answer.
     */
    expect(credentialKind.enumValues).toEqual([
      "model",
      "connector",
      "agent",
      "mcp",
      "mcp_oauth_client",
      "mcp_user_token",
    ]);
  });

  test("gives one person one credential per server, and makes that the key", () => {
    expect(getTableName(mcpUserCredentials)).toBe("mcp_user_credentials");

    const config = getTableConfig(mcpUserCredentials);

    /*
     * A composite primary key, not a surrogate id.
     *
     * "Which credential serves this server for this person" must have exactly one answer. With an id
     * and no unique constraint, two rows for the same pair are legal, and then the answer depends on
     * whichever the query happened to order first — so a person who reconnected could keep being
     * served the grant they thought they had replaced.
     */
    expect(
      config.primaryKeys.flatMap((key) =>
        key.columns.map((column) => column.name),
      ),
    ).toEqual(["server_id", "user_id"]);

    expect(
      config.columns.map((column) => ({
        name: column.name,
        notNull: column.notNull,
      })),
    ).toEqual([
      { name: "server_id", notNull: true },
      { name: "user_id", notNull: true },
      { name: "credential_id", notNull: true },
      { name: "scope", notNull: true },
      { name: "connected_at", notNull: true },
      { name: "updated_at", notNull: true },
    ]);
  });

  test("gives one person one set of standing instructions, and makes that the key", () => {
    const config = getTableConfig(userInstructions);

    /*
     * The user id IS the primary key, not a column beside a surrogate one.
     *
     * "What has this person asked every coworker to do" must have exactly one answer, because the
     * answer goes into a prompt. With an id and no unique constraint two rows are legal, and then
     * which of them speaks for the person depends on whichever the query happened to order first.
     */
    expect(
      config.columns.map((column) => ({
        name: column.name,
        sqlType: column.getSQLType(),
        notNull: column.notNull,
        primary: column.primary,
      })),
    ).toEqual([
      { name: "user_id", sqlType: "text", notNull: true, primary: true },
      { name: "instructions", sqlType: "text", notNull: true, primary: false },
      {
        name: "created_at",
        sqlType: "timestamp with time zone",
        notNull: true,
        primary: false,
      },
      {
        name: "updated_at",
        sqlType: "timestamp with time zone",
        notNull: true,
        primary: false,
      },
    ]);

    /*
     * Cascade, because this is one person's own prose about themselves. A deleted account must not
     * leave behind a paragraph that would be read into somebody's prompt if the id were ever reused.
     */
    expect(
      config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          sourceColumns: reference.columns.map((column) => column.name),
          targetTable: getTableName(reference.foreignTable),
          onDelete: foreignKey.onDelete,
        };
      }),
    ).toEqual([
      {
        sourceColumns: ["user_id"],
        targetTable: "users",
        onDelete: "cascade",
      },
    ]);
  });

  test("follows the person and the server when either goes away", () => {
    const config = getTableConfig(mcpUserCredentials);
    const cascading = config.foreignKeys.filter(
      (key) => key.onDelete === "cascade",
    );
    /*
     * Both the person and the server cascade: a deleted user must not leave a row pointing at a
     * vault secret held on their behalf, and a removed server must not leave rows nobody can reach
     * to disconnect. The credential reference deliberately does not cascade — a revoked credential
     * is kept for the trail, and losing the row that says whose it was would take the trail with it.
     */
    expect(cascading.length).toBe(2);
  });

  test("holds no copy of a customer's documents", () => {
    /*
     * The rule this schema is now built on: a Bot answers from a live system by calling that
     * system's own search as the person asking, so the vendor decides what they may see. A table
     * of documents here would be a second copy of somebody's corpus, with a second permission
     * model of our own to keep in step with theirs, and it would outlive their access to the
     * original. `documents`, `chunks` and `document_acls` were exactly that and are gone.
     *
     * This asserts on every table the schema exports rather than on named ones, so it catches a
     * reintroduction under a different name, and on column types rather than column names, so it
     * catches an embedding smuggled onto a table that sounds like something else.
     */
    const tables = Object.values(schema).filter((value): value is PgTable =>
      is(value, PgTable),
    );
    expect(tables.length).toBeGreaterThan(20);

    expect(tables.map(getTableName)).not.toContain("documents");
    expect(tables.map(getTableName)).not.toContain("chunks");
    expect(tables.map(getTableName)).not.toContain("document_acls");

    const vectorColumns = tables.flatMap((table) =>
      getTableConfig(table)
        .columns.filter((column) => column.getSQLType().startsWith("vector"))
        .map((column) => `${getTableName(table)}.${column.name}`),
    );
    /*
     * `memories.embedding`, and only that.
     *
     * WAS `toEqual([])`. The blanket "no vector column anywhere" rule was written when the only tables
     * were tables — and durable memory arrived with a 1024-dimensional embedding for cosine
     * similarity (`server/src/remi/memory.ts`), which is a summary of what THIS Bot was told, not a copy
     * of somebody's documents. It is the one vector column this deployment holds.
     *
     * Naming it is the point: a second one on a table that sounds like a corpus is the reintroduction
     * this test exists to catch, and an allowlist of exactly one entry still fails on that. The rule is
     * "no document corpus", and memory is not one.
     */
    expect(vectorColumns).toEqual(["memories.embedding"]);
  });

  test("includes Better Auth's verified Google identity records", () => {
    expect(Object.keys(users)).toContain("emailVerified");
    expect(Object.keys(sessions)).toEqual(
      expect.arrayContaining(["ipAddress", "userAgent"]),
    );
    expect(Object.keys(accounts)).toEqual(
      expect.arrayContaining(["userId", "providerId", "accountId"]),
    );
  });

  test("defines the exact agent profile and roster preference contracts", () => {
    expect([agentProfiles, agentPreferences].map(getTableName)).toEqual([
      "agent_profiles",
      "agent_preferences",
    ]);
    expect(agentVisibility.enumName).toBe("agent_visibility");
    expect(agentVisibility.enumValues).toEqual(["public", "private"]);

    const profileConfig = getTableConfig(agentProfiles);
    const preferenceConfig = getTableConfig(agentPreferences);

    expect(
      profileConfig.columns.map((column) => ({
        name: column.name,
        notNull: column.notNull,
        hasDefault: column.hasDefault,
        primary: column.primary,
      })),
    ).toEqual([
      { name: "agent_id", notNull: true, hasDefault: false, primary: true },
      /*
       * Who owns it, and whether it came with the tenant package. Both nullable, the second with a
       * default, and both load-bearing: `accessFilter` admits a profile on
       * `systemOwned OR ownerUserId === actor.id`, so a package template is reachable by everybody and
       * a personal Bot by its author alone.
       */
      {
        name: "owner_user_id",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        name: "is_system_template",
        notNull: false,
        hasDefault: true,
        primary: false,
      },
      { name: "title", notNull: true, hasDefault: false, primary: false },
      {
        name: "role_description",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "avatar_seed",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      /*
       * A coworker's own body: two nullable columns, no defaults, and a `visibility` column above
       * them that this deployment no longer varies on.
       *
       * `mascot_shape` and `mascot_color` arrived with migration 0066 as empty columns precisely so no
       * existing row had to be read or rewritten — a null axis means "not chosen", which is what the
       * client then fills from `avatar_seed`. Two columns rather than one serialised choice, so a
       * partial choice is expressible.
       *
       * They used to be three. `mascot_expression` is gone as of migration 0070, and its absence here
       * is the assertion: a face is what the agent is doing, not something a row holds, so the column
       * that held it had nothing left to say and would have sat there empty forever.
       *
       * `visibility` stays in the schema because old rows still carry it. It is not a decision
       * anything makes: `mapProfile` returns `visibility: "private"` whatever the column says, and
       * `accessFilter` reads `ownerUserId` and `isSystemTemplate` instead.
       */
      {
        name: "mascot_shape",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        name: "mascot_color",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      /*
       * The pause, as a nullable timestamp rather than a boolean — the same "null means not chosen"
       * reading as the two mascot columns above.
       *
       * A boolean defaulting to false cannot tell "never paused" from "written before the column
       * existed", and that difference is the whole question when deciding whether a coworker that is
       * not working is paused or simply idle. `paused_reason` rides along and is cleared with the
       * pause, so a reason never outlives the pause it described.
       */
      { name: "paused_at", notNull: false, hasDefault: false, primary: false },
      {
        name: "paused_reason",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      /*
       * Still in the schema because old rows still carry it, and no longer a decision anything makes.
       * `mapProfile` returns `visibility: "private"` whatever the column says, and `accessFilter`
       * reads `ownerUserId` and `isSystemTemplate` instead — public sharing was removed, so nothing
       * reaches this deployment as a shared row.
       */
      {
        name: "visibility",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      /*
       * Nullable, and that is the security property.
       *
       * Null means this agent holds no credential and may not call a tool back, which is what a URL
       * somebody pasted gets until they hand it one themselves.
       */
      {
        name: "callback_token_hash",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        name: "callback_token_issued_at",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        name: "deleted_at",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        name: "created_at",
        notNull: true,
        hasDefault: true,
        primary: false,
      },
      {
        name: "updated_at",
        notNull: true,
        hasDefault: true,
        primary: false,
      },
    ]);

    expect(
      preferenceConfig.columns.map((column) => ({
        name: column.name,
        sqlType: column.getSQLType(),
        notNull: column.notNull,
        hasDefault: column.hasDefault,
        primary: column.primary,
      })),
    ).toEqual([
      {
        name: "user_id",
        sqlType: "text",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "agent_id",
        sqlType: "text",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "hidden_at",
        sqlType: "timestamp with time zone",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
    ]);

    expect(
      [...profileConfig.foreignKeys, ...preferenceConfig.foreignKeys].map(
        (foreignKey) => {
          const reference = foreignKey.reference();
          return {
            sourceColumns: reference.columns.map((column) => column.name),
            targetTable: getTableName(reference.foreignTable),
            targetColumns: reference.foreignColumns.map(
              (column) => column.name,
            ),
            onDelete: foreignKey.onDelete,
            onUpdate: foreignKey.onUpdate,
          };
        },
      ),
    ).toEqual([
      {
        sourceColumns: ["agent_id"],
        targetTable: "agents",
        targetColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
      /*
       * `cascade`, not `set null`.
       *
       * WAS `set null`. That was `sandboxed_components.owner_user_id` — a legacy shared playground
       * row, where nulling the owner preserved a read-only component everybody could see.
       *
       * This is `agent_profiles.owner_user_id`, and the two are opposites. A profile with no owner is
       * a SYSTEM TEMPLATE: `accessFilter` admits one to every caller, and `mapProfile` reports it as
       * `isSystemTemplate`. So nulling it on sign-out would promote a person's Bot to a template every
       * other user could reach and manage — a silent privilege escalation on an account deletion.
       * Cascade removes it with its owner instead, which is the only safe direction here.
       */
      {
        sourceColumns: ["owner_user_id"],
        targetTable: "users",
        targetColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
      {
        sourceColumns: ["user_id"],
        targetTable: "users",
        targetColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
      {
        sourceColumns: ["agent_id"],
        targetTable: "agents",
        targetColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
    ]);

    expect(
      preferenceConfig.primaryKeys.map((primaryKey) => ({
        name: primaryKey.getName(),
        columns: primaryKey.columns.map((column) => column.name),
      })),
    ).toEqual([
      {
        name: "agent_preferences_user_id_agent_id_pk",
        columns: ["user_id", "agent_id"],
      },
    ]);

    expect(
      profileConfig.indexes.map((index) => ({
        name: index.config.name,
        columns: index.config.columns.map((column) =>
          "name" in column ? column.name : undefined,
        ),
        unique: index.config.unique,
        method: index.config.method,
      })),
    ).toEqual([
      {
        name: "agent_profiles_visibility_deleted_idx",
        columns: ["visibility", "deleted_at"],
        unique: false,
        method: "btree",
      },
    ]);
  });

  /*
   * The callback columns arrive as an alteration, not in the base schema.
   *
   * Every deployment of this has already applied 0000, so editing it in place changes a file the
   * database has recorded as run and the columns never appear. They are added by 0001, and this
   * says so, because the alternative failure is silent: the code reads a column the deployment
   * does not have.
   */
  test("adds the callback token columns in their own migration", async () => {
    const migration = await readFile(
      new URL("../drizzle/0001_swift_morph.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain(
      `ALTER TABLE "agent_profiles" ADD COLUMN "callback_token_hash" text;`,
    );
    expect(migration).toContain(
      `ALTER TABLE "agent_profiles" ADD COLUMN "callback_token_issued_at" timestamp with time zone;`,
    );
  });

  test("keeps the agent profile migration aligned with the schema", async () => {
    const migration = await readFile(
      new URL("../drizzle/0000_schema.sql", import.meta.url),
      "utf8",
    );
    const normalizedMigration = migration.replace(/\s+/g, " ").trim();

    expect(normalizedMigration).toContain(
      `CREATE TYPE "public"."agent_visibility" AS ENUM('public', 'private')`,
    );
    expect(normalizedMigration).toContain(
      `"agent_id" text PRIMARY KEY NOT NULL, "owner_user_id" text, "title" text NOT NULL, "role_description" text NOT NULL, "avatar_seed" text NOT NULL, "visibility" "agent_visibility" NOT NULL, "deleted_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL`,
    );
    expect(normalizedMigration).toContain(
      `CREATE TABLE "agent_preferences" ( "user_id" text NOT NULL, "agent_id" text NOT NULL, "hidden_at" timestamp with time zone,`,
    );
    expect(normalizedMigration).toContain(
      `CONSTRAINT "agent_preferences_user_id_agent_id_pk" PRIMARY KEY("user_id","agent_id")`,
    );
    expect(normalizedMigration).toContain(
      `ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action`,
    );
    expect(normalizedMigration).toContain(
      `ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action`,
    );
    expect(normalizedMigration).toContain(
      `ALTER TABLE "agent_preferences" ADD CONSTRAINT "agent_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`,
    );
    expect(normalizedMigration).toContain(
      `ALTER TABLE "agent_preferences" ADD CONSTRAINT "agent_preferences_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action`,
    );
    expect(normalizedMigration).toContain(
      `CREATE INDEX "agent_profiles_visibility_deleted_idx" ON "agent_profiles" USING btree ("visibility","deleted_at")`,
    );
  });
});
