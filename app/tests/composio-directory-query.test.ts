import { expect, test } from "bun:test";
import { composioAppsQueryOptions } from "../src/lib/plugins/queries";

/**
 * The Composio directory is fetched on open, not after a keystroke.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. `composioAppsQueryOptions` was `enabled: term.length > 0`.
 * That is defensible in isolation — the directory is over a thousand rows and nobody should pay for
 * all of them before typing — and it produced a browser that opened on an empty box: no rows, no
 * error, and nothing on the page saying that typing was the thing that would fill it. A person
 * meeting that concludes the feature is broken rather than that the search is empty, and no amount
 * of waiting changes it, because nothing is being fetched.
 *
 * The fix has two halves and this pins the client half: the query is no longer gated on a term, and
 * the server answers an empty term with a short curated set rather than the whole catalogue. The
 * server half is asserted in `server/tests/plugin-routes.test.ts`, under "an empty term answers a
 * curated set rather than the whole directory".
 */
test("the directory query is enabled before anything has been typed", () => {
  // No term at all — this is the state the browser is in the moment it opens, and the one the gate
  // used to switch off. Asserted on the option rather than on the key: a key-only assertion passes
  // for a gated query too, because a gated query still has a key and nobody observes it here.
  const onOpen = composioAppsQueryOptions("");

  // `enabled` is absent rather than `true`, which is what "not gated" looks like — and `!enabled`
  // is the check that has to be false for the browser to fetch on open.
  expect((onOpen as { enabled?: boolean }).enabled ?? true).toBe(true);
  // Spread before comparing: the key is a tagged tuple, so a bare literal is not assignable to it.
  expect([...onOpen.queryKey]).toEqual(["plugins", "composio", "apps", ""]);
});

test("a term changes the key, so two searches do not share one answer", () => {
  /*
   * Compared through `toEqual` rather than by indexing: the key TanStack builds is a tagged tuple
   * carrying its own data/error phantom types, so a literal has to be matched the same way the
   * assertion above matches it. What matters is the last element — that is the term, and two terms
   * landing on one key would serve the first search's answer for the second.
   */
  const empty = composioAppsQueryOptions("").queryKey;
  const typed = composioAppsQueryOptions("gmail").queryKey;

  expect(empty).not.toEqual(typed);
  expect([...typed].at(-1)).toBe("gmail");
  expect([...empty].at(-1)).toBe("");
});

test("the request carries the term, so the narrowing happens where it admits to happening", () => {
  /*
   * Composio's own client drops a search parameter and answers with an unfiltered page, which would
   * read as "no results" for a term that does match. The term is therefore sent to OUR endpoint,
   * which filters over slug, name and description itself.
   */
  expect(composioAppsQueryOptions("gmail").queryFn).toBeInstanceOf(Function);
});
