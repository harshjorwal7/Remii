import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MASCOT,
  MASCOT_COLOR_IDS,
  MASCOT_SHAPE_IDS,
} from "../../shared/mascot-ids";
import {
  collectMascots,
  mascotColumnValues,
  readMascot,
} from "../src/agents/mascot";
import { parseMascot } from "../src/agents/routes";

/**
 * A projected `agent_profiles` row.
 *
 * Two mascot columns and no third: `mascot_expression` went with migration 0070, because a face is
 * the agent's work and not something a row stores. The type says so, which is the point of spelling it
 * out here rather than accepting a wider object — a test that could pass a column the schema does not
 * have would go on passing after the column is gone.
 */
const row = (
  overrides: Partial<{
    mascotShape: string | null;
    mascotColor: string | null;
  }> = {},
) => ({
  mascotShape: null,
  mascotColor: null,
  ...overrides,
});

describe("readMascot", () => {
  it("reads a fully dressed coworker", () => {
    expect(
      readMascot(row({ mascotShape: "pebble", mascotColor: "teal" })),
    ).toEqual({ shape: "pebble", color: "teal" });
  });

  it("has nowhere to put a face, because a face is not stored", () => {
    // Not merely "ignores it": the row type has no third field, so this is a compile-time property as
    // well. What a caller does with a face it cannot store is the client's business — see
    // `mascotExpressionFor`.
    expect(Object.keys(row()).sort()).toEqual(["mascotColor", "mascotShape"]);
    expect(readMascot(row({ mascotShape: "pebble" }))).toEqual({
      shape: "pebble",
    });
  });

  it("returns null for a row that has chosen nothing, which is every row before this feature", () => {
    // Null rather than the shared default, because absence is what tells the client to seed from the
    // avatarSeed. Filling it in here would make every unchosen coworker wear the same face.
    expect(readMascot(row())).toBeNull();
    expect(DEFAULT_MASCOT.shape).toBe("circle");
  });

  it("keeps a partial choice partial across a round trip through the database", () => {
    // The property that makes "I only picked a colour" work: the axis somebody did not choose comes
    // back still unset, so it keeps being seeded rather than freezing at a default.
    const partial = { mascotColor: "teal" };
    const back = readMascot(row(partial));
    expect(back).toEqual({ color: "teal" });
    expect(mascotColumnValues(back)).toEqual({
      mascotShape: null,
      mascotColor: "teal",
    });
  });

  it("drops an axis it does not recognise and keeps the ones it does", () => {
    // A row written by a newer build. Refusing to map it would take the whole roster query down for a
    // cosmetic field, which is a much worse outcome than one avatar falling back to its default.
    expect(
      readMascot(row({ mascotShape: "octagon", mascotColor: "teal" })),
    ).toEqual({ color: "teal" });
  });

  it("returns null rather than an empty object when every axis was unrecognised", () => {
    // An empty object would be truthy, and a caller testing `if (mascot)` would treat a coworker with
    // nothing readable as a coworker who had made a choice.
    expect(
      readMascot(row({ mascotShape: "octagon", mascotColor: "puce" })),
    ).toBeNull();
  });

  it("reads back every id the vocabulary declares", () => {
    for (const shape of MASCOT_SHAPE_IDS) {
      for (const color of MASCOT_COLOR_IDS) {
        expect(
          readMascot(row({ mascotShape: shape, mascotColor: color })),
        ).toEqual({
          shape,
          color,
        });
      }
    }
  });
});

describe("mascotColumnValues", () => {
  it("writes SQL NULL for every axis nobody chose", () => {
    expect(mascotColumnValues(undefined)).toEqual({
      mascotShape: null,
      mascotColor: null,
    });
    expect(mascotColumnValues(null)).toEqual(mascotColumnValues(undefined));
    expect(mascotColumnValues({})).toEqual(mascotColumnValues(undefined));
  });

  it("writes null for an omitted axis rather than leaving the column out", () => {
    // "Use the seed" and "keep what is there" are different, and this is where the difference lives.
    // For an insert they coincide; for an update they do not, which is why a mascot that the caller
    // has decided to replace is replaced whole.
    expect(mascotColumnValues({ color: "violet" })).toEqual({
      mascotShape: null,
      mascotColor: "violet",
    });
  });
});

describe("collectMascots", () => {
  const joined = (agentId: string, overrides = {}) => ({
    agentId,
    ...row(overrides),
  });

  it("keys each mascot by its agent id", () => {
    expect(
      collectMascots([
        joined("agent_a", { mascotColor: "teal" }),
        joined("agent_b", { mascotShape: "cloud" }),
      ]),
    ).toEqual({ agent_a: { color: "teal" }, agent_b: { shape: "cloud" } });
  });

  it("leaves an agent with no choice out of the map entirely", () => {
    // The roster needs to tell "chosen" from "not chosen", and an entry with null axes would look
    // chosen while drawing nothing.
    expect(
      collectMascots([
        joined("agent_a"),
        joined("agent_b", { mascotColor: "teal" }),
      ]),
    ).toEqual({
      agent_b: { color: "teal" },
    });
  });

  it("collapses the repeated rows a channel query produces for one agent", () => {
    // Both channel queries return one row per channel-agent pair, so an agent in thirty channels
    // arrives thirty times. Every write for one id carries the same columns, so last-write-wins is
    // both correct and cheaper than deduplicating first.
    const repeated = Array.from({ length: 30 }, () =>
      joined("agent_a", { mascotColor: "teal" }),
    );
    expect(Object.keys(collectMascots(repeated))).toEqual(["agent_a"]);
  });
});

describe("parseMascot", () => {
  it("accepts a mascot this build knows", () => {
    expect(parseMascot({ shape: "triangle", color: "amber" })).toEqual({
      ok: true,
      value: { shape: "triangle", color: "amber" },
    });
  });

  it("accepts every id the vocabulary declares", () => {
    for (const shape of MASCOT_SHAPE_IDS) {
      for (const color of MASCOT_COLOR_IDS) {
        expect(parseMascot({ shape, color })).toEqual({
          ok: true,
          value: { shape, color },
        });
      }
    }
  });

  it("ignores a face rather than refusing the save", () => {
    /*
     * Every other field in this parser is refused when it is wrong, and this one is the exception on
     * purpose. `expression` was a real axis until migration 0070, so a client that has not been
     * rebuilt — an open tab from before the deploy, a script written against the old API — still
     * sends it, and it will keep sending it on every retry. Refusing would fail the whole save over a
     * field the person never chose and cannot see, forever.
     *
     * So the save succeeds with no face in it, the face follows the work, and the log says what
     * happened. Asserted as a value rather than as silence, because "the parse succeeded" is exactly
     * what a parser that returned the expression would also have done.
     */
    const parsed = parseMascot({
      shape: "triangle",
      color: "amber",
      expression: "proud",
    });
    expect(parsed).toEqual({
      ok: true,
      value: { shape: "triangle", color: "amber" },
    });
    // Even an id nobody has heard of, which the parser would otherwise have refused.
    expect(parseMascot({ color: "teal", expression: "elated" })).toEqual({
      ok: true,
      value: { color: "teal" },
    });
  });

  it("refuses an id it does not know rather than dropping it", () => {
    // Every stored field in this parser is refused when it is wrong, because a person can act on an
    // error message. A silently dropped mascot renders as somebody else's and cannot be diagnosed
    // from the screen at all.
    expect(parseMascot({ shape: "octagon" })).toEqual({
      ok: false,
      error: '"octagon" is not a mascot shape.',
    });
    expect(parseMascot({ color: "puce" })).toEqual({
      ok: false,
      error: '"puce" is not a mascot colour.',
    });
  });

  it("refuses a non-object", () => {
    expect(parseMascot("triangle")).toEqual({
      ok: false,
      error: "Mascot must be an object.",
    });
    expect(parseMascot(["triangle"])).toEqual({
      ok: false,
      error: "Mascot must be an object.",
    });
  });

  it("leaves the key absent when the body said nothing about a mascot", () => {
    // Not null. `store.update` reads a missing mascot as "leave the row alone" and a present one as
    // "replace it", so a parser that always produced the key would clear the mascot on every save —
    // and since the edit form sends the whole form, that is every rename and every endpoint change.
    expect(parseMascot(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseMascot(null)).toEqual({ ok: true, value: undefined });
  });

  it("reads an empty object as a deliberate reset", () => {
    // `{}` is how a person gets a coworker back to being seeded, and it has to be distinguishable
    // from saying nothing at all.
    expect(parseMascot({})).toEqual({ ok: true, value: {} });
  });

  it("reads an explicit null axis as unset rather than as an error", () => {
    // A form that clears one swatch and submits null for it is a reasonable thing to write, and
    // refusing it would be a worse answer than honouring it.
    expect(parseMascot({ shape: null, color: "teal" })).toEqual({
      ok: true,
      value: { color: "teal" },
    });
  });

  it("ignores keys it does not know instead of failing", () => {
    // Forward compatibility: a client from a newer build may send axes this build has no column for,
    // and refusing the whole save over one of them would be a much worse outcome than ignoring it.
    expect(parseMascot({ color: "teal", sparkle: true })).toEqual({
      ok: true,
      value: { color: "teal" },
    });
  });
});
