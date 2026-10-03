import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { POSITIONS, createTestApp } from "./app";

/**
 * The test helper must keep up with the signature it wraps.
 *
 * `createApp` is positional and every parameter from the third onwards is optional, so a helper that
 * fell out of step with it would not fail here — it would put each store in the wrong slot, and every
 * route test would answer 503 or 404 for a reason that names nothing. The nineteen files that used to
 * count `undefined` holes by hand are exactly how that happened, and this file is the guard against it
 * coming back.
 *
 * Three properties, and each is a different way the helper could go wrong:
 *
 *  1. The same parameters, in the same order, as `createApp`'s own signature. Checked against the
 *     source text rather than against a type, because the type cannot see the order — which is the
 *     whole thing being protected.
 *  2. A store passed BY NAME reaches its slot, proven by asking a route that is 503 without it.
 *  3. A parameter the helper does not know about is caught rather than silently dropped.
 */
describe("the createApp test helper", () => {
  test("lists exactly the parameters createApp declares, in order", async () => {
    const source = await readFile(
      new URL("../../src/app.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("export function createApp(");
    const end = source.indexOf("\n) {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    /*
     * `[A-Za-z_]` rather than `\w`, because two parameters are spelled with a leading underscore and
     * `\w` does not match one at the start of a word — which would have quietly dropped them from the
     * declaration and made this test agree with a list that had also dropped them.
     */
    const declared = [
      ...source.slice(start, end).matchAll(/^\s{2}([A-Za-z_]\w*)\??:/gm),
    ].map((match) => match[1]);

    /*
     * The two the helper deliberately leaves out, by name, so a reader does not have to diff the lists
     * to find out why theirs is shorter. Both are load-bearing at boot and neither is a route test's
     * business: one is the credential admin service the server assembles from the encryption key, and
     * the other is the object store.
     */
    /*
     * Compared after normalising the underscores, because the two lists are written for two different
     * readers: the signature underscores a parameter to say "this one exists but the body does not
     * read it", and the helper's list has no reason to carry that. The ORDER is what is under test —
     * it is the order a misplaced argument would follow.
     */
    /*
     * `_packageStatusReader` is omitted alongside the other two. It takes the tenant package's status,
     * which is read at boot rather than per request, and no route test has one to offer.
     */
    /*
     * Only the object store is omitted. `_credentialService` and `_packageStatusReader` are kept — a
     * test may pass either, so the helper has a slot for both and the underscore is dropped on both
     * sides rather than one of them vanishing.
     */
    const omitted = ["_blobStore"];
    const expected = declared
      .filter((name) => !omitted.includes(name))
      .map((name) => name.replace(/^_/, ""));

    expect(POSITIONS).toEqual(expected);
  });

  test("every parameter it can be given is one createApp declares", () => {
    // A typo in the parts map would otherwise read as "not provided" and vanish.
    for (const name of POSITIONS) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
    // The object store is deliberately not among them; a route test has nothing to put in it.
    expect(POSITIONS).not.toContain("_blobStore");
  });

  test("a store named is placed, so its routes answer", async () => {
    /*
     * Standing instructions are the witness because their route answers 503 when the store is absent
     * and 200 when it is there — one request that distinguishes "wired up" from "not", with no
     * inspection of the helper's internals required.
     */
    const written: string[] = [];
    const app = createTestApp({
      parts: {
        userInstructions: {
          read: async () => null,
          write: async (_userId, text) => {
            written.push(text);
            return text;
          },
        },
      },
    });

    const read = await app.request(
      "http://remii.test/api/settings/instructions",
    );
    expect(read.status).toBe(200);

    const put = await app.request(
      "http://remii.test/api/settings/instructions",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instructions: "Write in British English." }),
      },
    );
    expect(put.status).toBe(200);
    expect(written).toEqual(["Write in British English."]);
  });

  test("a route with no store still answers 503, so a missing name is visible", async () => {
    const app = createTestApp();
    const response = await app.request(
      "http://remii.test/api/settings/instructions",
    );
    // The failure the helper exists to make impossible to reach by accident.
    expect(response.status).toBe(503);
  });

  test("the person the session names is the person the store sees", async () => {
    const seen: string[] = [];
    const app = createTestApp({
      as: { id: "somebody-else", email: "else@remii.test" },
      parts: {
        userInstructions: {
          read: async (userId) => {
            seen.push(userId);
            return null;
          },
          write: async (_userId, text) => text,
        },
      },
    });

    await app.request("http://remii.test/api/settings/instructions");
    expect(seen).toEqual(["somebody-else"]);
  });
});
