import { describe, expect, test } from "bun:test";
import { nextPageHint, withDefaultPageSize } from "../src/plugins/page-size";

/**
 * Page size and the page after this one.
 *
 * The property under test throughout is that neither function ever decides anything the model did not
 * ask it to decide. A page size is only ever filled into a gap, a cursor hint is only ever added when
 * the vendor actually gave a cursor, and every case that could not be reasoned about with confidence
 * returns the input unchanged rather than a guess.
 */

const gmailSchema = {
  type: "object",
  properties: {
    q: { type: "string" },
    maxResults: { type: "integer" },
    pageToken: { type: "string" },
  },
};

describe("withDefaultPageSize", () => {
  test("fills the page size an action left out", () => {
    expect(
      withDefaultPageSize({
        toolName: "GMAIL_FETCH_EMAILS",
        args: { q: "from:boss" },
        schema: gmailSchema,
        effect: "read",
      }),
    ).toEqual({ maxResults: 25, q: "from:boss" });
  });

  test("never overrides what the model asked for", () => {
    /*
     * The model's number is a decision it made about a task this module has not read. Asking for five
     * and asking for a hundred are both things a model does on purpose, and a deployment that
     * silently replaced them would make an agent that appears to narrow its own queries lie about it.
     */
    for (const asked of [1, 5, 100]) {
      expect(
        withDefaultPageSize({
          toolName: "GMAIL_FETCH_EMAILS",
          args: { q: "invoice", maxResults: asked },
          schema: gmailSchema,
          effect: "read",
        }),
      ).toEqual({ q: "invoice", maxResults: asked });
    }
  });

  test("a present but empty page size is still the model's", () => {
    /*
     * `in` rather than a value test. A model does emit `maxResults: undefined`, and an argument that
     * is present as nothing has been chosen; injecting a 25 over the top of it would replace a decision
     * with a number while looking, in a diff, like a default.
     */
    expect(
      withDefaultPageSize({
        toolName: "GMAIL_FETCH_EMAILS",
        args: { q: "invoice", maxResults: undefined },
        schema: gmailSchema,
        effect: "read",
      }),
    ).toEqual({ q: "invoice", maxResults: undefined });
  });

  test("each spelling of a page size is recognised", () => {
    for (const name of [
      "maxResults",
      "max_results",
      "limit",
      "per_page",
      "count",
      "pageSize",
    ]) {
      expect(
        withDefaultPageSize({
          toolName: "ACTION",
          args: {},
          schema: {
            type: "object",
            properties: { [name]: { type: "integer" } },
          },
          effect: "read",
        }),
      ).toEqual({ [name]: 25 });
    }
  });

  test("an argument that is not a count is left alone", () => {
    for (const node of [
      { type: "string" },
      { type: "boolean" },
      { type: "integer", enum: [10, 20] },
      { type: "array" },
      { oneOf: [{ type: "integer" }] },
    ]) {
      expect(
        withDefaultPageSize({
          toolName: "ACTION",
          args: {},
          schema: { type: "object", properties: { limit: node } },
          effect: "read",
        }),
      ).toEqual({});
    }
  });

  test("a schema this module cannot read gets nothing", () => {
    /*
     * Behind `$ref`, behind `allOf`, or not an object at all: an action whose arguments are described
     * somewhere this module has not read. Every other place in this tree that meets such a schema
     * fails closed, and a page size guessed at from a name we cannot see would be a number put into
     * an argument whose meaning is unknown.
     */
    for (const schema of [
      { $ref: "#/definitions/Args" },
      {
        allOf: [{ type: "object", properties: { limit: { type: "integer" } } }],
      },
      { type: "string" },
      null,
      undefined,
      "not a schema",
    ]) {
      expect(
        withDefaultPageSize({
          toolName: "ACTION",
          args: { q: "x" },
          schema,
          effect: "read",
        }),
      ).toEqual({ q: "x" });
    }
  });

  test("a vendor ceiling below ours is the vendor's page, not ours to change", () => {
    /*
     * Skipped rather than clamped. An action that says "at most 10" has already decided what a page
     * is; sending a 10 and reporting that a page size was chosen here would be a claim about a
     * decision we did not make. The action runs either way — only the claim changes.
     */
    expect(
      withDefaultPageSize({
        toolName: "ACTION",
        args: {},
        schema: {
          type: "object",
          properties: { limit: { type: "integer", maximum: 10 } },
        },
        effect: "read",
      }),
    ).toEqual({});
    // Above ours, ours applies.
    expect(
      withDefaultPageSize({
        toolName: "ACTION",
        args: {},
        schema: {
          type: "object",
          properties: { limit: { type: "integer", maximum: 100 } },
        },
        effect: "read",
      }),
    ).toEqual({ limit: 25 });
  });

  test("a write is never given a page size", () => {
    /*
     * A `limit` on an action that changes something is not a page. The classification is the
     * deployment's own and the only signal available here about what an action does, so it is the one
     * consulted — and it is consulted strictly: only an action positively classified as a write is
     * spared, and an unclassifiable one is spared too, because nothing here narrows what a model may
     * ask a vendor to do.
     */
    for (const effect of ["write", null, undefined] as const) {
      expect(
        withDefaultPageSize({
          toolName: "ACTION",
          args: {},
          schema: gmailSchema,
          effect,
        }),
      ).toEqual({});
    }
  });

  test("the same object comes back when nothing is filled in", () => {
    const args = { q: "x" };
    expect(
      withDefaultPageSize({
        toolName: "GMAIL_SEND_EMAIL",
        args,
        schema: gmailSchema,
        effect: "write",
      }),
    ).toBe(args);
  });
});

describe("nextPageHint", () => {
  test("says nothing when the answer has no cursor", () => {
    /*
     * The overwhelmingly common case, and the one that has to cost nothing but a shallow walk: a send,
     * a fetch, a delete, and every read that returned everything there was.
     */
    for (const data of [
      { id: "m1", snippet: "hello" },
      { messages: [{ id: "m1" }] },
      { nextPageToken: "" },
      { nextPageToken: null },
      { next_cursor: "   " },
      { next: 42 },
      null,
      undefined,
      "a string",
      [],
    ]) {
      expect(nextPageHint(data)).toBe("");
    }
  });

  test("names the token and the field, for every spelling a vendor uses", () => {
    const expectations: [Record<string, unknown>, string][] = [
      [{ nextPageToken: "tok-1" }, "nextPageToken"],
      [{ next_page_token: "tok-2" }, "next_page_token"],
      [{ next_cursor: "tok-3" }, "next_cursor"],
      [{ pageToken: "tok-4" }, "pageToken"],
      [{ continuationToken: "tok-5" }, "continuationToken"],
      [{ start_cursor: "tok-6" }, "start_cursor"],
      [{ after: "tok-7" }, "after"],
    ];
    for (const [data, field] of expectations) {
      const hint = nextPageHint(data);
      expect(hint).toContain(`${field}="`);
      expect(hint).toContain("more results");
      expect(hint).toContain("next page");
      // The remedy is the point of the sentence: a model told only that a list is partial has
      // nothing to do about it.
      expect(hint).toContain("rather than treating this one as the whole list");
    }
  });

  test("finds a cursor nested inside a list result", () => {
    /*
     * Gmail puts it beside the list rather than inside it, Slack puts it inside a `messages` envelope
     * beside `response_metadata`, and Drive puts it in its own object. A hint that only looked at the
     * top level would find the first two and miss the third, which is the one this deployment
     * connects by default.
     */
    expect(
      nextPageHint({
        messages: [{ id: "m1" }],
        response_metadata: { next_cursor: "dGVzdA==" },
      }),
    ).toContain('next_cursor="dGVzdA=="');
  });

  test("is quiet about a deeply nested value rather than walking forever", () => {
    let nested: unknown = { nextPageToken: "deep" };
    for (let index = 0; index < 40; index += 1) nested = { child: nested };
    expect(nextPageHint(nested)).toBe("");
  });
});
