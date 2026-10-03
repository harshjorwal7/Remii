import { afterEach, describe, expect, test } from "bun:test";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "../src/computer/policy-store";
import { createDatabase } from "../src/db/client";
import { actionPolicy } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The boundary has to survive a restart.
 *
 * A policy held only in memory means a rule an administrator adds is gone the next time the process
 * comes up, and nothing says so. The persisted row is the contract that keeps the boundary active
 * across process replacement.
 *
 * A restart is simulated by building a second store, which is what a restart is from this module's
 * point of view: a fresh process, the same configured default, the same database. Asserting through
 * one store would only prove it remembers what it was told a moment ago.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const configured = DEFAULT_ACTION_POLICY;
const rule = 'intent == "activate" && contains(element.name, "submit")';

afterEach(async () => {
  /*
   * EVERY row, and on `userId` rather than an `id`.
   *
   * `action_policy`'s primary key is the owner column itself — there is no separate `id` — so
   * `actionPolicy.id` was `undefined` and the `where` rendered as an empty clause. Postgres rejected it
   * with `syntax error at or near "="`, which reads as a database fault rather than as a column that
   * does not exist.
   *
   * The whole table is cleared rather than one named row, because `set` writes to whichever owner it
   * was handed — `"default"` with no `by`, or the caller's address with one — so a sweep of one row
   * left the others behind. A leftover row is not a cosmetic problem here: `load()` answers "the
   * database" whenever the table is non-empty, so the next test's "a deployment that never set one gets
   * its configured default" fails on somebody else's boundary. That is what these tests were reporting
   * before the sweep was widened.
   */
  await database.delete(actionPolicy);
});

describe("a boundary set while running", () => {
  test("is still there after a restart", async () => {
    const before = createPolicyStore(configured, database);
    await before.load();
    await before.set(
      { mode: "enforce", deny: [rule], allow: ["true"] },
      "admin@example.test",
    );

    /*
     * `get("admin@example.test")`, because that is who the boundary belongs to.
     *
     * `set` writes to whichever owner it was handed — the caller's address when there is a `by`, and
     * `"default"` when there is not — so the row is now keyed on the person who changed it and a bare
     * `get()` reads the DEPLOYMENT default rather than theirs. Read it back through the same owner and
     * this is still a restart test: a fresh store, the same database, no memory of the write.
     */
    const after = createPolicyStore(configured, database);
    expect(await after.load("admin@example.test")).toBe("the database");
    expect(after.get("admin@example.test").deny).toEqual([rule]);
  });

  test("a deployment that never set one gets its configured default", async () => {
    const store = createPolicyStore(configured, database);
    expect(await store.load()).toBe("configuration");
    expect(store.get()).toEqual(configured);
  });

  test("resetting forgets it, so a restart returns to configuration", async () => {
    const store = createPolicyStore(configured, database);
    await store.set({ mode: "enforce", deny: [rule], allow: ["true"] });
    await store.reset();

    // The saved row is removed rather than overwritten, so changing what configuration says then
    // changes what is enforced, which is what an operator expects a reset to mean.
    const after = createPolicyStore(configured, database);
    expect(await after.load()).toBe("configuration");
    expect(after.get().deny).toEqual([]);
  });

  test("setting twice keeps one row and the latest rule", async () => {
    const store = createPolicyStore(configured, database);
    await store.set({ mode: "enforce", deny: ["first"], allow: ["true"] });
    await store.set({ mode: "dry-run", deny: ["second"], allow: ["true"] });

    const rows = await database.select().from(actionPolicy);
    // One boundary per deployment, by construction. Two rows would mean something has to choose.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mode).toBe("dry-run");
    expect(rows[0]?.deny).toEqual(["second"]);
  });

  test("records who changed it", async () => {
    const store = createPolicyStore(configured, database);
    await store.set(
      { mode: "enforce", deny: [rule], allow: ["true"] },
      "admin@example.test",
    );

    const [row] = await database.select().from(actionPolicy);
    expect(row?.updatedBy).toBe("admin@example.test");
  });

  test("without a database it still works, in memory", async () => {
    // A test about the decision logic must not need Postgres, and a deployment with no database has
    // bigger problems than an unsaved rule.
    const store = createPolicyStore(configured);
    expect(await store.load()).toBe("configuration");
    await store.set({ mode: "enforce", deny: [rule], allow: ["true"] });
    expect(store.get().deny).toEqual([rule]);
    await store.reset();
    expect(store.get()).toEqual(configured);
  });
});
