import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { decryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  users,
  vaultAgentItems,
  vaultCards,
  vaultLogins,
  vaultPersonalInfo,
} from "../src/db/schema";
import {
  createVaultStore,
  MAX_LOGINS,
  VaultNotFoundError,
  VaultRefusedError,
} from "../src/vault/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The vault's integration tests.
 *
 * THE POINT OF THIS FILE IS ISOLATION. Every other concern here — masks, counts, caps — could be
 * tested against a fake. Ownership cannot, because ownership is a `where` clause and a fake has none:
 * a store that read a table and filtered in JavaScript would pass every other test in the tree and
 * would hand one person another's passwords. So these run against a real Postgres, and the tests that
 * matter most are the ones where two people exist at once.
 */

const TEST_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const store = createVaultStore(database, TEST_KEY);

const createdUserIds: string[] = [];

async function person() {
  const id = `vault-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@remii.test` });
  createdUserIds.push(id);
  return id;
}

afterEach(async () => {
  for (const userId of createdUserIds.splice(0)) {
    // Cascades: the vault goes with the person, which is the same guarantee the foreign key gives in
    // production and is therefore worth exercising here rather than by deleting each table.
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

describe("one person's vault, from the inside", () => {
  test("stores an encrypted password and hands back exactly what went in", async () => {
    const userId = await person();

    await store.createLogin(userId, {
      label: "Google",
      username: "user@example.com",
      password: "correct horse battery staple",
      websiteUrl: "https://mail.google.com",
    });

    const stored = await database
      .select()
      .from(vaultLogins)
      .where(eq(vaultLogins.userId, userId));
    expect(stored.length).toBe(1);

    // The column at rest is an envelope, not the password. Asserting on the absence of the plaintext
    // in the raw row is the point; decrypting to compare would pass even if it were stored twice.
    const row = stored[0];
    expect(row?.passwordEncrypted).not.toContain("correct horse");
    expect(JSON.parse(row!.passwordEncrypted!)).toMatchObject({ version: 1 });
    await expect(
      decryptSecret(TEST_KEY, row!.passwordEncrypted!),
    ).resolves.toBe("correct horse battery staple");

    await expect(
      store.readLoginSecret({ userId, id: row!.id }),
    ).resolves.toMatchObject({
      username: "user@example.com",
      password: "correct horse battery staple",
    });
  });

  test("never puts a password in a list answer", async () => {
    const userId = await person();
    await store.createLogin(userId, {
      label: "Bank",
      username: "me",
      password: "hunter2",
    });

    const [listed] = await store.listLogins(userId);
    expect(listed).toMatchObject({
      label: "Bank",
      username: "me",
      hasPassword: true,
    });
    // Serialised, because a property named `password` that happens to be undefined and one that is
    // absent are the same to a caller and the test should not care which — only what leaked.
    expect(JSON.stringify(listed)).not.toContain("hunter2");
    expect("password" in (listed ?? {})).toBe(false);
  });

  test("keeps a card's last four in the clear and its number encrypted", async () => {
    const userId = await person();
    const card = await store.createCard(userId, {
      label: "Personal Visa",
      cardNumber: "4242 4242 4242 4242",
      expiry: "04/29",
      cvv: "123",
    });

    expect(card.maskedNumber).toBe("•••• •••• •••• 4242");
    expect(JSON.stringify(card)).not.toContain("123");

    const [row] = await database
      .select()
      .from(vaultCards)
      .where(eq(vaultCards.userId, userId));
    expect(row?.last4).toBe("4242");
    expect(row?.cardNumberEncrypted).not.toContain("4242");

    await expect(
      store.readCardSecret({ userId, id: card.id }),
    ).resolves.toMatchObject({
      cardNumber: "4242424242424242",
      cvv: "123",
      expiry: "04/29",
    });
  });

  test("keeps an agent item's value encrypted and its kind and scope in the clear", async () => {
    const userId = await person();
    const item = await store.createAgentItem(userId, {
      label: "Stripe API key",
      kind: "api_key",
      value: "sk_live_abc123",
      scope: "integration",
      scopeRef: "api.stripe.com",
      allowedApps: ["https://api.stripe.com", "dashboard.stripe.com/x"],
    });

    expect(item).toMatchObject({
      kind: "api_key",
      scope: "integration",
      scopeRef: "api.stripe.com",
    });
    // The scheme and the path are stripped: the allow-list is a set of hosts, and storing "https://…"
    // beside a bare domain would make the match in `tools.ts` depend on how somebody typed it.
    expect(item.allowedApps).toEqual([
      "api.stripe.com",
      "dashboard.stripe.com",
    ]);
    expect(JSON.stringify(item)).not.toContain("sk_live");

    const [row] = await database
      .select()
      .from(vaultAgentItems)
      .where(eq(vaultAgentItems.userId, userId));
    expect(row?.valueEncrypted).not.toContain("sk_live");

    await expect(
      store.readAgentItemSecret({ userId, id: item.id }),
    ).resolves.toMatchObject({ value: "sk_live_abc123" });
  });

  test("counts a use and names who used it, so the row answers for itself", async () => {
    const userId = await person();
    const item = await store.createAgentItem(userId, {
      label: "GitHub token",
      kind: "access_token",
      value: "ghp_1",
    });

    expect(item.usageCount).toBe(0);
    expect(item.lastUsedAt).toBeNull();

    await store.readAgentItemSecret({
      userId,
      id: item.id,
      agentId: "general-assistant",
    });
    await store.readAgentItemSecret({
      userId,
      id: item.id,
      agentId: "general-assistant",
    });

    const [after] = await store.listAgentItems(userId);
    expect(after?.usageCount).toBe(2);
    expect(after?.usedByAgentId).toBe("general-assistant");
    expect(after?.lastUsedAt).toBeString();
  });

  test("finds an item by name, which is how a model asks for one", async () => {
    const userId = await person();
    await store.createAgentItem(userId, {
      label: "Stripe API key",
      kind: "api_key",
      value: "sk_live_1",
    });

    await expect(
      store.readAgentItemSecret({ userId, label: "Stripe API key" }),
    ).resolves.toMatchObject({ value: "sk_live_1" });
  });

  test("refuses two agent items with the same name, because a model's lookup would be ambiguous", async () => {
    const userId = await person();
    const input = {
      label: "Stripe API key",
      kind: "api_key",
      value: "sk_live_1",
    };

    await store.createAgentItem(userId, input);
    await expect(store.createAgentItem(userId, input)).rejects.toBeInstanceOf(
      VaultRefusedError,
    );
  });

  test("keeps a stored password through an edit that does not touch it", async () => {
    const userId = await person();
    const login = await store.createLogin(userId, {
      label: "Bank",
      username: "me",
      password: "hunter2",
    });

    // An edit sends only the label. If an empty password box were treated as a value, this is where
    // somebody's password would quietly disappear.
    await store.updateLogin(userId, login.id, { label: "Bank (current)" });

    await expect(
      store.readLoginSecret({ userId, id: login.id }),
    ).resolves.toMatchObject({ password: "hunter2" });
  });

  test("derives a card's mask again when the number is replaced", async () => {
    const userId = await person();
    const card = await store.createCard(userId, {
      label: "Visa",
      cardNumber: "4242424242424242",
    });

    const updated = await store.updateCard(userId, card.id, {
      cardNumber: "5555444433331111",
    });

    // Four digits belonging to the number that was just replaced is worse than no mask at all: it
    // names a card the person no longer has.
    expect(updated.maskedNumber).toBe("•••• •••• •••• 1111");
  });

  test("refuses a duplicate number-shaped card number before it is stored", async () => {
    const userId = await person();
    await expect(
      store.createCard(userId, { label: "Broken", cardNumber: "1234" }),
    ).rejects.toBeInstanceOf(VaultRefusedError);
  });

  test("treats personal info as one row, and absent as absent", async () => {
    const userId = await person();
    await expect(store.readPersonalInfo(userId)).resolves.toBeNull();

    const saved = await store.writePersonalInfo(userId, {
      fullName: "John Doe",
      email: "john@example.com",
      postalCode: "  SW1A 1AA  ",
    });
    expect(saved).toMatchObject({
      fullName: "John Doe",
      email: "john@example.com",
      postalCode: "SW1A 1AA",
    });

    const rows = await database
      .select()
      .from(vaultPersonalInfo)
      .where(eq(vaultPersonalInfo.userId, userId));
    expect(rows.length).toBe(1);

    // A second save replaces rather than appending: it is one person's details, not a list of them.
    await store.writePersonalInfo(userId, { fullName: "Jane Roe" });
    const [after] = (await store.readPersonalInfo(userId))
      ? [await store.readPersonalInfo(userId)]
      : [];
    expect(after?.fullName).toBe("Jane Roe");
  });

  test("returns only the personal fields a task named", async () => {
    const userId = await person();
    await store.writePersonalInfo(userId, {
      fullName: "John Doe",
      email: "john@example.com",
      phone: "+44 7700 900000",
      postalCode: "SW1A 1AA",
      city: "London",
    });

    // Spelled three ways, because a model writes field names in prose and refusing a task over a
    // spelling would be a refusal about punctuation.
    for (const name of ["postal_code", "postalCode", "Postal Code"]) {
      await expect(store.personalInfoFields(userId, [name])).resolves.toEqual({
        postalCode: "SW1A 1AA",
      });
    }

    // The half that matters: asking for a postcode does not bring a phone number along.
    await expect(
      store.personalInfoFields(userId, ["city", "postal_code"]),
    ).resolves.toEqual({ city: "London", postalCode: "SW1A 1AA" });

    await expect(store.personalInfoFields(userId, [])).resolves.toEqual({});
    await expect(
      store.personalInfoFields(userId, ["not_a_field"]),
    ).resolves.toEqual({});
  });

  test("refuses a save past the per-owner cap, and the cap is per owner", async () => {
    const userId = await person();
    const other = await person();

    for (let index = 0; index < MAX_LOGINS; index += 1) {
      await store.createLogin(userId, {
        label: `Login ${index}`,
        username: `user${index}`,
        password: "x",
      });
    }
    await expect(
      store.createLogin(userId, {
        label: "One too many",
        username: "x",
        password: "x",
      }),
    ).rejects.toBeInstanceOf(VaultRefusedError);

    // The cap is a limit on one person's vault, not on the table.
    await expect(
      store.createLogin(other, { label: "Fine", username: "x", password: "x" }),
    ).resolves.toMatchObject({ label: "Fine" });
  });

  test("trims what it is given, so the stored label is what the list shows", async () => {
    const userId = await person();
    const login = await store.createLogin(userId, {
      label: "  Google  ",
      username: "  user@example.com  ",
      password: "  spaces matter in a password  ",
      notes: "   ",
    });

    expect(login.label).toBe("Google");
    expect(login.username).toBe("user@example.com");
    // A blank note is absent rather than an empty string: one representation of "not written".
    expect(login.notes).toBeNull();
    // The password is NOT trimmed. Leading and trailing spaces are part of most passwords, and
    // trimming them would store something the person cannot log in with.
    await expect(
      store.readLoginSecret({ userId, id: login.id }),
    ).resolves.toMatchObject({
      password: "  spaces matter in a password  ",
    });
  });
});

/*
 * ISOLATION. Two people exist at once in every test below, which is the only arrangement in which a
 * missing owner filter can be caught: with one person in the table, a store that forgot to scope its
 * reads would still return the right answer.
 */
describe("one person's vault against another's", () => {
  test("lists only the caller's rows", async () => {
    const mine = await person();
    const theirs = await person();

    await store.createLogin(mine, {
      label: "Mine",
      username: "me",
      password: "x",
    });
    await store.createLogin(theirs, {
      label: "Theirs",
      username: "them",
      password: "y",
    });

    const listed = await store.listLogins(mine);
    expect(listed.map((row) => row.label)).toEqual(["Mine"]);
    expect(JSON.stringify(listed)).not.toContain("y");
  });

  test("will not read, change or delete a row belonging to somebody else", async () => {
    const mine = await person();
    const theirs = await person();
    const theirLogin = await store.createLogin(theirs, {
      label: "Theirs",
      username: "them",
      password: "theirs-secret",
    });

    await expect(
      store.readLoginSecret({ userId: mine, id: theirLogin.id }),
    ).rejects.toBeInstanceOf(VaultNotFoundError);
    await expect(
      store.updateLogin(mine, theirLogin.id, { label: "Stolen" }),
    ).rejects.toBeInstanceOf(VaultNotFoundError);
    await expect(store.removeLogin(mine, theirLogin.id)).rejects.toBeInstanceOf(
      VaultNotFoundError,
    );

    // Untouched, and still readable by its owner.
    const [surviving] = await store.listLogins(theirs);
    expect(surviving?.label).toBe("Theirs");
    await expect(
      store.readLoginSecret({ userId: theirs, id: theirLogin.id }),
    ).resolves.toMatchObject({ password: "theirs-secret" });
  });

  test("will not read a card or an agent item belonging to somebody else", async () => {
    const mine = await person();
    const theirs = await person();

    const theirCard = await store.createCard(theirs, {
      label: "Theirs",
      cardNumber: "4242424242424242",
      cvv: "999",
    });
    const theirItem = await store.createAgentItem(theirs, {
      label: "Theirs",
      kind: "api_key",
      value: "sk_live_theirs",
    });

    await expect(
      store.readCardSecret({ userId: mine, id: theirCard.id }),
    ).rejects.toBeInstanceOf(VaultNotFoundError);
    await expect(
      store.readAgentItemSecret({ userId: mine, id: theirItem.id }),
    ).rejects.toBeInstanceOf(VaultNotFoundError);
    // By name as well as by id: a model supplies a name, and that path has to be scoped too.
    await expect(
      store.readAgentItemSecret({ userId: mine, label: "Theirs" }),
    ).rejects.toBeInstanceOf(VaultNotFoundError);

    expect(await store.listCards(mine)).toEqual([]);
    expect(await store.listAgentItems(mine)).toEqual([]);
  });

  test("answers the same way for a row that is not yours as for a row that does not exist", async () => {
    const mine = await person();

    const theirs = await person();
    const theirLogin = await store.createLogin(theirs, {
      label: "Theirs",
      username: "them",
      password: "x",
    });

    const onTheirs = await store
      .readLoginSecret({ userId: mine, id: theirLogin.id })
      .then(() => "resolved")
      .catch((error: Error) => `${error.name}: ${error.message}`);
    const onNothing = await store
      .readLoginSecret({ userId: mine, id: "vault_login_nothing_here" })
      .then(() => "resolved")
      .catch((error: Error) => `${error.name}: ${error.message}`);

    // If these differ, the endpoint becomes an oracle for which ids exist anywhere on this deployment.
    expect(onTheirs).toBe(onNothing);
  });

  test("does not let one person's use of an item increment somebody else's", async () => {
    const mine = await person();
    const theirs = await person();

    await store.createAgentItem(theirs, {
      label: "Theirs",
      kind: "api_key",
      value: "sk_live_theirs",
    });
    const myItem = await store.createAgentItem(mine, {
      label: "Mine",
      kind: "api_key",
      value: "sk_live_mine",
    });

    // Using my own item must not touch theirs, even though the two writes carry the same column.
    await store.readAgentItemSecret({
      userId: mine,
      id: myItem.id,
      agentId: "bot",
    });

    const [theirAfter] = await store.listAgentItems(theirs);
    const [myAfter] = await store.listAgentItems(mine);
    expect(theirAfter?.usageCount).toBe(0);
    expect(theirAfter?.usedByAgentId).toBeNull();
    expect(myAfter?.usageCount).toBe(1);
  });

  test("keeps two people's agent items of the same name apart", async () => {
    const mine = await person();
    const theirs = await person();

    await store.createAgentItem(mine, {
      label: "Stripe API key",
      kind: "api_key",
      value: "sk_mine",
    });
    await store.createAgentItem(theirs, {
      label: "Stripe API key",
      kind: "api_key",
      value: "sk_theirs",
    });

    // The unique index is per owner, so the same name is not a collision across people — which is the
    // only way a model could ever look one up by name and get somebody else's key.
    await expect(
      store.readAgentItemSecret({ userId: mine, label: "Stripe API key" }),
    ).resolves.toMatchObject({ value: "sk_mine" });
    await expect(
      store.readAgentItemSecret({ userId: theirs, label: "Stripe API key" }),
    ).resolves.toMatchObject({ value: "sk_theirs" });
  });

  test("writes only onto the caller's own row when personal info is saved", async () => {
    const mine = await person();
    const theirs = await person();

    await store.writePersonalInfo(theirs, { fullName: "Theirs" });
    await store.writePersonalInfo(mine, { fullName: "Mine" });

    const mineRow = await database
      .select()
      .from(vaultPersonalInfo)
      .where(
        and(
          eq(vaultPersonalInfo.userId, mine),
          eq(vaultPersonalInfo.fullName, "Mine"),
        ),
      );
    expect(mineRow.length).toBe(1);
    expect((await store.readPersonalInfo(theirs))?.fullName).toBe("Theirs");
  });

  test("takes a person's vault with them when the account goes", async () => {
    const mine = await person();
    const theirs = await person();

    await store.createLogin(mine, {
      label: "Mine",
      username: "me",
      password: "x",
    });
    await store.createCard(mine, {
      label: "Mine",
      cardNumber: "4242424242424242",
    });
    await store.createAgentItem(mine, {
      label: "Mine",
      kind: "api_key",
      value: "sk_1",
    });
    await store.writePersonalInfo(mine, { fullName: "Mine" });
    await store.createLogin(theirs, {
      label: "Theirs",
      username: "them",
      password: "y",
    });

    await database.delete(users).where(eq(users.id, mine));

    // Every row goes with the account, so a deleted person leaves nothing behind that no one can
    // reach and nobody can clean up. Somebody else's vault is untouched.
    for (const table of [vaultLogins, vaultCards, vaultAgentItems]) {
      const rows = await database.select().from(table);
      expect(rows.every((row) => row.userId === theirs)).toBe(true);
    }
    const info = await database.select().from(vaultPersonalInfo);
    expect(info.every((row) => row.userId === theirs)).toBe(true);

    // Keep the afterEach sweep from trying to delete this id twice.
    createdUserIds.splice(createdUserIds.indexOf(mine), 1);
  });
});
