import { createDatabase } from "../../src/db/client";
/**
 * The database integration suite must never fall back to the developer's application database.
 * `createDatabase` deliberately removes `process.env.DATABASE_URL` after opening a connection so Bun
 * cannot ignore the explicit connection parts on Windows. That means a later test that reads
 * `process.env.DATABASE_URL ?? localhost/remii` can silently fall into the live development DB.
 * Resolve one explicit test URL before opening a test pool and make the unsafe shape impossible.
 */
let cachedTestDatabaseUrl: string | undefined;

export function testDatabaseUrl() {
  cachedTestDatabaseUrl ??= testDatabaseUrlFrom(process.env);
  return cachedTestDatabaseUrl;
}

export function testDatabaseUrlFrom(
  environment: Record<string, string | undefined>,
) {
  const raw = environment.TEST_DATABASE_URL?.trim();
  if (!raw) {
    throw new Error(
      "TEST_DATABASE_URL must point at a dedicated PostgreSQL test database. Do not rely on DATABASE_URL; createDatabase removes it to preserve the Windows Bun connection fix.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "TEST_DATABASE_URL must be a PostgreSQL URL such as postgres://remii:remii@localhost:5432/remii_test.",
    );
  }
  if (!/^postgres(?:ql)?:$/.test(url.protocol)) {
    throw new Error(
      "TEST_DATABASE_URL must use the postgres:// or postgresql:// protocol.",
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new Error("TEST_DATABASE_URL must name a database.");
  }
  if (database === "remii") {
    throw new Error(
      "TEST_DATABASE_URL must not point at the live remii database. Use a dedicated database such as remii_test.",
    );
  }
  return raw;
}

/**
 * How many connections one test file may hold.
 *
 * The suite runs in a single process, so every file that opens a pool holds it for the whole run and
 * the totals add up rather than take turns. Left at the driver's default the suite sat at 83 of
 * PostgreSQL's 100, which is not a limit anybody set and not one that shows up until a file is added
 * and something unrelated fails on a machine slower than the author's.
 *
 * Two, because a test that opens a transaction and reads inside it needs a second connection to do
 * so. A test that wants the deadlock that pinning to one exposes asks for `{ max: 1 }` itself.
 */
export const TEST_POOL = { max: 2 } as const;

/**
 * A test pool, one per call.
 *
 * A factory and not a cached handle, deliberately. Caching it was tried and it is wrong: the suite
 * runs in a single process, so every file holds its pool for the whole run, and one shared pool put
 * 60-odd files' transactions on one set of connections and failed 653 tests. One pool per file keeps
 * each file's transactions to itself.
 *
 * What this does centralise is the URL and the pool size, which is where the two ways of opening a
 * test database disagreed. The suite opens 58 of them, so `max_connections` has to be high enough
 * for all of them at once — it is set to 400, because the alternative is a suite that fails
 * somewhere unrelated every time a file is added.
 */
export function testDatabase() {
  return createDatabase(testDatabaseUrl(), TEST_POOL);
}
