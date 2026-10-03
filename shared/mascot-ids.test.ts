import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MASCOT,
  DEFAULT_MASCOT_EXPRESSION,
  MASCOT_COLOR_IDS,
  MASCOT_COMBINATION_COUNT,
  MASCOT_EXPRESSION_IDS,
  MASCOT_SHAPE_IDS,
  type MascotColorId,
  type MascotExpressionId,
  type MascotShapeId,
  resolveMascotChoice,
} from "./mascot-ids";

describe("the mascot vocabulary", () => {
  it("has no duplicate ids in any axis", () => {
    // A duplicate would silently drop a choice from the picker and shrink the space it advertises,
    // which is exactly the sort of thing that only shows up as somebody's mascot never appearing.
    expect(new Set(MASCOT_SHAPE_IDS).size).toBe(MASCOT_SHAPE_IDS.length);
    expect(new Set(MASCOT_COLOR_IDS).size).toBe(MASCOT_COLOR_IDS.length);
    expect(new Set(MASCOT_EXPRESSION_IDS).size).toBe(
      MASCOT_EXPRESSION_IDS.length,
    );
  });

  it("multiplies out to the combination count it claims", () => {
    // Two axes, not three: it was 8 × 12 × 16 while the face was something a person picked, and it was
    // 8 × 12 before the black, the brown and then the grey left the palette.
    expect(MASCOT_COMBINATION_COUNT).toBe(7 * 9);
  });

  it("has no black, no brown and no grey in it", () => {
    // Black and brown failed the same way — a row of mascots in a sidebar read as a hole and as mud,
    // and on the dark theme the near-black one vanished into the surface. Grey failed a slightly
    // different way: every surface and border in this app is already a grey, so a grey mascot is the
    // one avatar that reads as furniture rather than as a coworker. None is offered, none is seeded,
    // and none is the default, so the assertion is on the list itself rather than on behaviour that
    // could be reintroduced by a caller.
    expect(MASCOT_COLOR_IDS).not.toContain("ink");
    expect(MASCOT_COLOR_IDS).not.toContain("brown");
    expect(MASCOT_COLOR_IDS).not.toContain("grey");
    expect(DEFAULT_MASCOT.color).not.toBe("ink");
    expect(DEFAULT_MASCOT.color).not.toBe("brown");
    expect(DEFAULT_MASCOT.color).not.toBe("grey");
  });

  it("keeps a face vocabulary that nothing is expected to store", () => {
    // The faces are still a closed list, because the app names one and the server has to be able to
    // refuse a value it does not know — but they are answers to work states, not choices, so they are
    // not part of the count and not part of `MascotChoice`.
    expect(MASCOT_EXPRESSION_IDS.length).toBeGreaterThan(0);
    expect(new Set(MASCOT_EXPRESSION_IDS).size).toBe(
      MASCOT_EXPRESSION_IDS.length,
    );
    expect(MASCOT_EXPRESSION_IDS).toContain(DEFAULT_MASCOT_EXPRESSION);
    expect(Object.keys(DEFAULT_MASCOT)).toEqual(["shape", "color"]);
  });

  it("defaults to the blue circle", () => {
    expect(DEFAULT_MASCOT).toEqual({
      shape: "circle",
      color: "blue",
    });
    expect(MASCOT_SHAPE_IDS).toContain(DEFAULT_MASCOT.shape);
    expect(MASCOT_COLOR_IDS).toContain(DEFAULT_MASCOT.color);
  });
});

describe("resolveMascotChoice", () => {
  it("keeps a fully specified choice", () => {
    const choice = {
      shape: "pebble",
      color: "violet",
    } as const;
    expect(resolveMascotChoice(choice)).toEqual(choice);
  });

  it("drops an expression rather than honouring it", () => {
    // A client that has not been rebuilt still sends one, and the answer has to be a mascot with no
    // expression in it: a face that quietly took the stored value would be a face that ignored the
    // work and looked like the bug rather than like the fix.
    const resolved = resolveMascotChoice({
      shape: "pebble",
      color: "violet",
      expression: "laughing",
    });
    expect(resolved).toEqual({ shape: "pebble", color: "violet" });
    expect(Object.keys(resolved)).toEqual(["shape", "color"]);
  });

  it("defaults every field of an agent that has never been customised", () => {
    // The null case is not an edge. It is every agent row written before this feature existed, which
    // is all of them on the day this ships, and it is why no backfill migration is needed.
    expect(resolveMascotChoice(null)).toEqual(DEFAULT_MASCOT);
    expect(resolveMascotChoice(undefined)).toEqual(DEFAULT_MASCOT);
  });

  it("defaults the fields a partial choice leaves out", () => {
    expect(resolveMascotChoice({ color: "teal" })).toEqual({
      ...DEFAULT_MASCOT,
      color: "teal",
    });
  });

  it("defaults one bad field without losing the good ones beside it", () => {
    // A row written by a newer build, or a hand-edited one. Rejecting the whole mascot would cost
    // somebody their colour over a shape nobody has heard of.
    expect(
      resolveMascotChoice({
        shape: "octagon",
        color: "teal",
      }),
    ).toEqual({ ...DEFAULT_MASCOT, color: "teal" });
  });

  it("refuses to invent an id that is not one of ours", () => {
    const resolved = resolveMascotChoice({
      shape: "__proto__",
      color: "constructor",
    });
    expect(resolved).toEqual(DEFAULT_MASCOT);
  });

  it("survives input that is not an object", () => {
    expect(resolveMascotChoice("triangle")).toEqual(DEFAULT_MASCOT);
    expect(resolveMascotChoice(42)).toEqual(DEFAULT_MASCOT);
    expect(resolveMascotChoice([])).toEqual(DEFAULT_MASCOT);
  });
});

describe("the ids, as types", () => {
  // Compile-time assertions, kept as tests so `bun run typecheck` and `bun test` agree about which
  // spelling of a mascot is the real one.
  it("accepts every id it declares", () => {
    const shape: MascotShapeId = "hexagon";
    const color: MascotColorId = "amber";
    const expression: MascotExpressionId = "confused";
    // The face is a type the app still names — `mascotExpressionFor` returns one — so it still has to
    // compile; it just is not something a stored mascot may carry.
    const faces: readonly MascotExpressionId[] = [
      expression,
      ...MASCOT_EXPRESSION_IDS,
    ];
    expect(resolveMascotChoice({ shape, color })).toEqual({ shape, color });
    expect(faces.length).toBe(MASCOT_EXPRESSION_IDS.length + 1);
  });
});
