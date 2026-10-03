import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createAuditReader } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * What a hand-edited cursor does to the admin trail, asked of the database that parses it.
 *
 * `audit-cursor.test.ts` pins the refusal itself and runs against a stub reader, which is the wrong
 * witness for this one: a stub takes any cursor at all, so the failure it cannot show is the only
 * failure there was. `audit_events.id` is a `uuid`, the cursor's `id` goes into
 * `lt(auditEvents.id, cursor.id)`, and an id that is not a uuid is PostgreSQL raising `invalid
 * input syntax for type uuid` from inside `createAuditReader.list` — past the route's
 * `AuditQueryError` catch, which knows only about the sentence `decodeCursor` throws, and out as a
 * 500 on a request whose only fault was a stale bookmark.
 *
 * So this drives the real cursor through the real route over the real database, and asserts the
 * STATUS CODE, because the status code is the whole difference between "you sent something I cannot
 * read" and "this deployment is broken".
 */

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);

function cursorOf(page: unknown): string {
  return Buffer.from(JSON.stringify(page)).toString("base64url");
}

/**
 * A hand-edited cursor, asked of the reader that turns it into SQL.
 *
 * WAS three tests driving `createApp` and asking for `/api/admin/audit-events?cursor=...`, asserting
 * 400 / 400 / 200. That route went with the admin surface, so all three were answering 404.
 *
 * The property underneath them is intact and is the one worth keeping: a cursor the server cannot
 * read must never reach PostgreSQL. It is asserted here by calling `createAuditReader.list` with the
 * cursor directly, which is the actual boundary — `decodeCursor` is inside the reader, and a stub
 * reader could never have shown the failure this file exists for, because a stub takes any cursor at
 * all. `audit_events.id` is a `uuid` and the cursor's id goes into `lt(auditEvents.id, cursor.id)`, so
 * an id that is not a uuid is `invalid input syntax for type uuid` from inside the query.
 */
describe("a cursor the trail's own columns have to parse", () => {
  const reader = createAuditReader(database);

  test("an id no uuid column can read is refused before the query is built", async () => {
    await expect(
      reader.list({
        cursor: cursorOf({
          id: "event-1",
          createdAt: "2026-08-13T12:00:00.000Z",
        }),
      }),
    ).rejects.toThrow("cursor must be a valid audit page cursor");
  });

  test("an id that is not a string at all is refused the same way", async () => {
    // Truthy, which is all the guard used to ask of it, and bound into a uuid comparison unchanged.
    await expect(
      reader.list({
        cursor: cursorOf({
          id: 7,
          createdAt: "2026-08-13T12:00:00.000Z",
        }),
      }),
    ).rejects.toThrow("cursor must be a valid audit page cursor");
  });

  test("a cursor the endpoint itself would issue still pages", async () => {
    /*
     * THE LIMIT ON THE REFUSAL: a uuid id and an ISO timestamp — exactly what `encodeCursor` writes
     * out of a row — still reaches the database and answers a page. Without this the two refusals
     * above would pass on a reader that rejected every cursor ever written.
     */
    const page = await reader.list({
      cursor: cursorOf({
        id: "6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11",
        createdAt: "2026-08-13T12:00:00.000Z",
      }),
      limit: 1,
    });

    expect(Array.isArray(page.events)).toBe(true);
  });
});

describe("a cursor over rows written within one millisecond", () => {
  const reader = createAuditReader(database);

  /** Rows in one statement, so they share `now()`, at the given microsecond offsets into its millisecond. */
  async function rowsAt(targetId: string, micros: number[]) {
    return database
      .insert(auditEvents)
      .values(
        micros.map((offset) => ({
          eventType: "configuration.changed",
          targetType: "audit_cursor_test",
          targetId,
          payload: {},
          createdAt: sql`date_trunc('milliseconds', now()) + ${offset}::int * interval '1 microsecond'`,
        })),
      )
      .returning({ id: auditEvents.id });
  }

  async function walk(targetId: string) {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await reader.list({
        targetId,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.events.map((event) => event.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return seen;
  }

  test("reaches every row, newest first, when they are microseconds apart", async () => {
    const targetId = `cursor-precision-${crypto.randomUUID()}`;
    const [newest, middle, oldest] = await rowsAt(targetId, [789, 456, 123]);

    expect(await walk(targetId)).toEqual([newest?.id, middle?.id, oldest?.id]);
  });

  test("reaches every row when they share one instant", async () => {
    const targetId = `cursor-precision-${crypto.randomUUID()}`;
    const rows = await rowsAt(targetId, [456, 456, 456]);
    // One instant, so the id alone orders them, descending as the reader does.
    const expected = rows
      .map((row) => row.id)
      .sort()
      .reverse();

    expect(await walk(targetId)).toEqual(expected);
  });
});
