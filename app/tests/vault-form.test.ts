import { describe, expect, test } from "bun:test";
import {
  emptyVaultAgentItemForm,
  emptyVaultCardForm,
  emptyVaultLoginForm,
  emptyVaultPersonalInfoForm,
  formatCardNumber,
  generatePassword,
  VAULT_AGENT_ITEM_KINDS,
  vaultAgentItemFormSchema,
  vaultAgentItemInputFrom,
  vaultCardFormSchema,
  vaultCardInputFrom,
  vaultLoginFormSchema,
  vaultLoginInputFrom,
  vaultPersonalInfoFormSchema,
} from "@/lib/vault/form";

/**
 * The vault's browser-side form contract.
 *
 * THE LOAD-BEARING TEST IN HERE IS THE "isEdit" ONE, repeated for all three secret-bearing forms. A
 * stored password, card number, CVV and value are never sent to the browser, so every edit form opens
 * its secret box EMPTY — and an empty box that gets sent as `""` silently deletes somebody's password
 * the moment they rename a login. `vault*InputFrom` is the one place that distinction is made, so it
 * is the one place it is tested.
 */

describe("a login", () => {
  test("wants a name and a username, and allows neither password nor URL", () => {
    expect(
      vaultLoginFormSchema.safeParse({
        ...emptyVaultLoginForm,
        label: "Google",
        username: "user@example.com",
      }).success,
    ).toBe(true);

    const noName = vaultLoginFormSchema.safeParse({
      ...emptyVaultLoginForm,
      username: "user@example.com",
    });
    expect(noName.success).toBe(false);
    expect(noName.error?.issues[0]?.message).toBe(
      "Website or app is required.",
    );

    const noUsername = vaultLoginFormSchema.safeParse({
      ...emptyVaultLoginForm,
      label: "Google",
    });
    expect(noUsername.error?.issues[0]?.message).toBe(
      "Username or email is required.",
    );
  });

  test("refuses a URL without a scheme, and accepts one with either", () => {
    for (const websiteUrl of [
      "https://mail.google.com",
      "http://localhost:3000",
      "",
    ]) {
      expect(
        vaultLoginFormSchema.safeParse({
          ...emptyVaultLoginForm,
          label: "Google",
          username: "me",
          websiteUrl,
        }).success,
      ).toBe(true);
    }

    const refused = vaultLoginFormSchema.safeParse({
      ...emptyVaultLoginForm,
      label: "Google",
      username: "me",
      websiteUrl: "mail.google.com",
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toContain("http://");
  });

  test("a create sends its password and an edit that left the box alone sends none", () => {
    const filled = {
      ...emptyVaultLoginForm,
      label: "Google",
      username: "me",
      password: "hunter2",
    };

    // Creating: what was typed is what is stored, including nothing.
    expect(vaultLoginInputFrom(filled, false).password).toBe("hunter2");
    expect(
      vaultLoginInputFrom(
        { ...emptyVaultLoginForm, label: "X", username: "y" },
        false,
      ).password,
    ).toBe("");

    // Editing with an untouched box: the field is OMITTED, not sent empty. This is the assertion that
    // keeps an edit from deleting a password.
    const untouched = vaultLoginInputFrom(
      { ...emptyVaultLoginForm, label: "Google", username: "me" },
      true,
    );
    expect("password" in untouched).toBe(false);

    // Editing with a typed one replaces it.
    expect(vaultLoginInputFrom(filled, true).password).toBe("hunter2");
  });

  test("trims the label and the username, and leaves the password alone", () => {
    const input = vaultLoginInputFrom(
      {
        label: "  Google  ",
        username: "  me@example.com  ",
        password: "  spaces matter  ",
        websiteUrl: "  https://mail.google.com  ",
        notes: "  a note  ",
      },
      false,
    );
    expect(input).toEqual({
      label: "Google",
      username: "me@example.com",
      password: "  spaces matter  ",
      websiteUrl: "https://mail.google.com",
      notes: "a note",
    });
  });
});

describe("a card", () => {
  test("accepts a pasted number with spaces, hyphens or neither", () => {
    for (const cardNumber of [
      "4242 4242 4242 4242",
      "4242-4242-4242-4242",
      "4242424242424242",
    ]) {
      expect(
        vaultCardFormSchema.safeParse({
          ...emptyVaultCardForm,
          label: "Visa",
          cardNumber,
        }).success,
      ).toBe(true);
    }
  });

  test("refuses a number that is too short or too long", () => {
    for (const cardNumber of ["1234", "42424242424242424242"]) {
      const parsed = vaultCardFormSchema.safeParse({
        ...emptyVaultCardForm,
        label: "Visa",
        cardNumber,
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain("12 to 19 digits");
    }
  });

  test("refuses an expiry it could not read, and accepts MM/YY either way round", () => {
    for (const expiry of ["04/29", "04 / 29", "12/2029", ""]) {
      expect(
        vaultCardFormSchema.safeParse({
          ...emptyVaultCardForm,
          label: "Visa",
          expiry,
        }).success,
      ).toBe(true);
    }
    for (const expiry of ["2029-04", "13/29", "04"]) {
      expect(
        vaultCardFormSchema.safeParse({
          ...emptyVaultCardForm,
          label: "Visa",
          expiry,
        }).success,
      ).toBe(false);
    }
  });

  test("refuses a CVV that is not three or four digits", () => {
    for (const cvv of ["123", "1234", ""]) {
      expect(
        vaultCardFormSchema.safeParse({
          ...emptyVaultCardForm,
          label: "Visa",
          cvv,
        }).success,
      ).toBe(true);
    }
    for (const cvv of ["12", "12345", "abc"]) {
      expect(
        vaultCardFormSchema.safeParse({
          ...emptyVaultCardForm,
          label: "Visa",
          cvv,
        }).success,
      ).toBe(false);
    }
  });

  test("an edit that left the CVV alone sends none, so the stored one survives", () => {
    const untouched = vaultCardInputFrom(
      { ...emptyVaultCardForm, label: "Visa" },
      true,
    );
    expect("cvv" in untouched).toBe(false);
    // And the number, which is the same problem one field over.
    expect("cardNumber" in untouched).toBe(false);
  });
});

describe("personal info", () => {
  test("every field may be left blank, because there is no field everybody has", () => {
    // Blank, which is what "not written" is spelled: all thirteen keys present, every one empty.
    expect(
      vaultPersonalInfoFormSchema.safeParse(emptyVaultPersonalInfoForm).success,
    ).toBe(true);

    // And a missing KEY is refused, deliberately. These thirteen values are the whole state of one
    // dialog, which always holds all of them, so a second spelling of "not written" would only mean a
    // `VaultField` reading `form.values.fullName` had to cope with undefined as well as "".
    expect(vaultPersonalInfoFormSchema.safeParse({}).success).toBe(false);
  });

  test("a date of birth must look like one", () => {
    expect(
      vaultPersonalInfoFormSchema.safeParse({
        ...emptyVaultPersonalInfoForm,
        dateOfBirth: "1985-04-12",
      }).success,
    ).toBe(true);
    for (const dateOfBirth of ["12/04/1985", "1985", "today"]) {
      expect(
        vaultPersonalInfoFormSchema.safeParse({
          ...emptyVaultPersonalInfoForm,
          dateOfBirth,
        }).success,
      ).toBe(false);
    }
  });
});

describe("an agent item", () => {
  test("the kinds offered are exactly the ones the store accepts", () => {
    // A kind drawn here that the store refuses is a form that cannot save; one the store accepts that
    // is missing here is a value a person cannot choose.
    expect(VAULT_AGENT_ITEM_KINDS.map((kind) => kind.value)).toEqual([
      "api_key",
      "access_token",
      "secret",
      "environment_variable",
      "ssh_key",
      "recovery_code",
      "custom",
    ]);
    // With a name filled in, because an unnamed item is refused by the schema and by the store alike —
    // so this is asserting the KIND is accepted, not that an empty form is.
    for (const kind of VAULT_AGENT_ITEM_KINDS) {
      expect(
        vaultAgentItemFormSchema.safeParse({
          ...emptyVaultAgentItemForm,
          label: "Stripe API key",
          kind: kind.value,
        }).success,
      ).toBe(true);
    }
  });

  test("refuses a kind that is not one of them", () => {
    expect(
      vaultAgentItemFormSchema.safeParse({
        ...emptyVaultAgentItemForm,
        kind: "password_hint",
      }).success,
    ).toBe(false);
  });

  test("turns the allowed-apps textarea into one host per line, and drops the blanks", () => {
    const input = vaultAgentItemInputFrom(
      {
        ...emptyVaultAgentItemForm,
        label: "Stripe",
        allowedApps: "  api.stripe.com  \n\n   \ndashboard.stripe.com\n",
      },
      false,
    );
    expect(input.allowedApps).toEqual([
      "api.stripe.com",
      "dashboard.stripe.com",
    ]);
  });

  test("an empty allowed-apps box is an empty list, not a box of nothing", () => {
    expect(
      vaultAgentItemInputFrom(emptyVaultAgentItemForm, false).allowedApps,
    ).toEqual([]);
  });

  test("an edit that left the value alone sends none", () => {
    const untouched = vaultAgentItemInputFrom(
      { ...emptyVaultAgentItemForm, label: "Stripe" },
      true,
    );
    expect("value" in untouched).toBe(false);
    expect(
      vaultAgentItemInputFrom(
        { ...emptyVaultAgentItemForm, label: "Stripe", value: "sk_live_1" },
        true,
      ).value,
    ).toBe("sk_live_1");
  });
});

describe("card number formatting", () => {
  test("groups in fours, then four, then four, then the rest", () => {
    expect(formatCardNumber("")).toBe("");
    expect(formatCardNumber("4")).toBe("4");
    expect(formatCardNumber("4242")).toBe("4242");
    expect(formatCardNumber("42424")).toBe("4242 4");
    expect(formatCardNumber("42424242")).toBe("4242 4242");
    expect(formatCardNumber("424242424")).toBe("4242 4242 4");
    expect(formatCardNumber("424242424242")).toBe("4242 4242 4242");
    expect(formatCardNumber("4242424242424242")).toBe("4242 4242 4242 4242");
  });

  test("drops what is not a digit, so a paste and a keystroke arrive the same", () => {
    expect(formatCardNumber("4242-4242 4242.4242")).toBe("4242 4242 4242 4242");
  });

  test("will not draw more than nineteen digits, whatever is pasted", () => {
    // Nineteen is the longest number any issuer issues, so a longer paste is truncated rather than
    // drawn as a five-block number that would then fail the schema.
    expect(formatCardNumber("42424242424242424242")).toBe(
      "4242 4242 4242 4242424",
    );
    // And nineteen digits exactly, which is a real card length and must survive whole.
    expect(formatCardNumber("4242424242424242424")).toBe(
      "4242 4242 4242 4242424",
    );
  });
});

describe("the password generator", () => {
  test("is sixteen characters drawn without a modulo bias", () => {
    /*
     * The bias is the whole reason this function loops. `byte % alphabet.length` over 256 values and a
     * 73-character alphabet leaves the first 37 characters a little likelier than the rest, so a
     * generated password would be measurably less random than its length suggests. Rejection sampling
     * is the fix and this asserts the shape that fix produces: sixteen characters, all from the
     * alphabet, and nothing longer.
     */
    const password = generatePassword();
    expect(password).toHaveLength(16);
    expect(password).toMatch(/^[a-zA-Z0-9\-_.+=@#%^&*]+$/);
  });

  test("produces a different one each time, which is the entire feature", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(seen.size).toBe(50);
  });

  test("covers the alphabet rather than a corner of it", () => {
    /*
     * A weak generator shows up here: 200 samples of a biased modulo will lean on the tail of the
     * alphabet. Asserting that most of the alphabet appeared is a cheap check that the distribution is
     * not badly wrong, without pretending sixteen characters prove anything on their own.
     */
    const drawn = new Set(
      Array.from({ length: 200 }, () => generatePassword()).join(""),
    );
    expect(drawn.size).toBeGreaterThan(50);
  });

  test("respects a requested length", () => {
    expect(generatePassword(24)).toHaveLength(24);
  });
});
