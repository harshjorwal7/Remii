import { afterEach, describe, expect, test } from "bun:test";
import { createDatabase } from "../src/db/client";
import { testDatabaseUrl } from "./support/database";

/**
 * The address goes to Bun in parts, and `$DATABASE_URL` does not survive the call.
 *
 * Both halves matter and only together. Bun reads a connection URL's path as the path of a unix
 * socket, so `postgres://…/remii` cannot connect on Windows (oven-sh/bun#27713); and it prefers
 * `$DATABASE_URL` to the options it was handed, so passing the parts while the variable is still
 * set changes nothing. These assert the observable half: what the environment looks like
 * afterwards, and which addresses are refused before a socket is ever opened.
 */
const original = process.env.DATABASE_URL;

afterEach(() => {
  if (original === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original;
});

describe("the database address", () => {
  test("is taken out of the environment, so Bun cannot prefer it to the parts", () => {
    process.env.DATABASE_URL = "postgres://remii:remii@127.0.0.1:5432/remii";

    createDatabase("postgres://remii:remii@127.0.0.1:5432/remii");

    expect(process.env.DATABASE_URL).toBeUndefined();
  });

  test("refuses a connection string that is not a URL", () => {
    expect(() => createDatabase("://remii@/remii")).toThrow(
      /DATABASE_URL is not a valid URL/,
    );
  });

  test("does not put the password in the message when the URL will not parse", () => {
    // A stray character in a generated password is the likeliest reason `new URL` throws here, so
    // the refusal must not echo the string it was given: DATABASE_URL carries the credential, and a
    // message quoting it would write the password into the log line that reports the fault. The
    // invalid port makes `new URL` throw with the secret still present in the input.
    const secret = "s3cr3t-p4ssw0rd";
    let message = "";
    try {
      createDatabase(`postgres://remii:${secret}@127.0.0.1:notaport/remii`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/DATABASE_URL is not a valid URL/);
    expect(message).not.toContain(secret);
  });

  test("refuses a URL with no host, which would otherwise parse and connect nowhere", () => {
    // `new URL` accepts this: the scheme is "remii:" and there is no host at all.
    expect(() => createDatabase("remii:remii@localhost/remii")).toThrow(
      /names no host/,
    );
  });

  test("refuses a URL that names no database, rather than connecting to a default", () => {
    expect(() =>
      createDatabase("postgres://remii:remii@127.0.0.1:5432"),
    ).toThrow(/names no database/);
  });

  test("refuses a port of zero instead of connecting nowhere", () => {
    /*
     * `new URL` accepts `:0` and reports the port as `"0"`, so without this check boot succeeds
     * and every query fails against a port nothing listens on. A refusal here names the variable
     * and the range, the way every other malformed address does.
     */
    expect(() =>
      createDatabase("postgres://remii:remii@127.0.0.1:0/remii"),
    ).toThrow(/DATABASE_URL names a port that is not between 1 and 65535/);
  });

  test("refuses a password holding a percent that starts no escape, naming the part", () => {
    /*
     * `new URL` accepts this and `decodeURIComponent` does not, so the refusal used to be a bare
     * `URIError: URI error` naming neither DATABASE_URL nor the password -- out of the one function
     * whose job is to make a connection failure legible. A generated password is a common place to
     * find a literal `%`.
     */
    expect(() =>
      createDatabase("postgres://remii:100%pure@127.0.0.1:5432/remii"),
    ).toThrow(/DATABASE_URL has a password that is not percent-encoded/);
  });

  test("refuses a username holding one too", () => {
    expect(() =>
      createDatabase("postgres://open%bot:remii@127.0.0.1:5432/remii"),
    ).toThrow(/DATABASE_URL has a username that is not percent-encoded/);
  });

  test("refuses a database name holding one too", () => {
    expect(() =>
      createDatabase("postgres://remii:remii@127.0.0.1:5432/open%bot"),
    ).toThrow(/DATABASE_URL has a database name that is not percent-encoded/);
  });

  test("still accepts a password that IS percent-encoded, decoding it", () => {
    // The escape a correctly written password uses: `%40` is `@`, which cannot be written raw.
    expect(() =>
      createDatabase("postgres://remii:p%40ss@127.0.0.1:5432/remii"),
    ).not.toThrow();
  });

  test("still refuses pool options where the address belongs", () => {
    // @ts-expect-error the wrong-way-round call this guard exists for
    expect(() => createDatabase({ max: 1 })).toThrow(/connection string/);
  });
});

describe("connection parameters on the URL", () => {
  test("survive, because a dropped application_name turns a lock test into a timeout", async () => {
    const address = new URL(testDatabaseUrl());
    address.searchParams.set("application_name", "db_client_address_probe");
    const named = createDatabase(address.toString());

    /*
     * ANCHORED TO THIS PROBE'S OWN NAME, because that is the only version of this that can fail.
     *
     * Reading `pg_backend_pid()` back over the same connection — which is what this used to do — returns
     * this backend's row whether or not `application_name` ever arrived, so it passed unconditionally
     * and proved nothing about the parameter. Filtering on a name nothing else uses cannot be satisfied by
     * an unrelated session that happens to be connected, and it finds nothing at all if the parameter
     * was dropped on the way to Bun.
     *
     * Inlined rather than bound: `execute` takes no parameter list here, and this value is a name the file
     * chose rather than a caller-supplied one.
     *
     * AT LEAST ONE ROW, AND EVERY ROW CARRYING THE NAME — not exactly one row. `createDatabase` opens a
     * pool and Bun opens its connections lazily, so how many backends are named here depends on how many
     * the pool established before the query ran: five on a warm run, one on a cold one. A count would be
     * asserting Bun's scheduler rather than the behaviour under test, so the claim is made as "at least
     * one, and all of them".
     */
    try {
      const rows = (await named.execute(
        "select application_name from pg_stat_activity where application_name = 'db_client_address_probe'",
      )) as Array<{ application_name: string }>;

      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.every((row) => row.application_name === "db_client_address_probe"),
      ).toBe(true);
    } finally {
      await named.$client.close();
    }
  });
});
