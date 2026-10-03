import { describe, expect, test } from "bun:test";
import {
  costTierFor,
  orderChainByCost,
  relativeModelCost,
  turnRefusal,
} from "../src/billing/cost-tier";

/**
 * The degradation ladder, which is what makes a flat price survivable.
 *
 * The thing under test is a promise about someone's MONEY: that a plan buys a fixed number of dollars of
 * model time and a person who spends it quickly is not cut off at hour three while one who spreads it
 * over a month is never cut off at all. The only way that promise holds is if turns get cheaper as the
 * window empties, and these tests hold the shape of that.
 *
 * The ordering properties are the assertions that matter. "The cheapest model comes first" is a claim
 * about a sort, and a sort is exactly the thing that is quietly wrong when a model id contains another
 * model's name — `gpt-4o-mini` contains `mini`, `claude-3-5-haiku` contains `haiku` and `3-5`. So the
 * tests assert on the resulting ORDER rather than on a cost figure, which is the internal thing.
 */

const link = (model: string) => ({ model });

describe("model cost ordering", () => {
  test("a cheap model is dearer than nothing and cheaper than an expensive one", () => {
    expect(relativeModelCost("claude-3-5-haiku-20241022")).toBeLessThan(
      relativeModelCost("claude-sonnet-4-5"),
    );
    expect(relativeModelCost("claude-sonnet-4-5")).toBeLessThan(
      relativeModelCost("claude-opus-4-1"),
    );
  });

  test("matches on a substring, because model ids are names rather than an enum", () => {
    // Nobody is going to enumerate every dated snapshot, and a real id must be recognised.
    expect(relativeModelCost("claude-haiku-4-5-20251001")).toBe(
      relativeModelCost("claude-haiku-4-5"),
    );
  });

  test("an unrecognised model is treated as expensive rather than cheap", () => {
    // The failure that matters: an unknown expensive model priced as cheap would quietly eat
    // somebody's whole allowance while the meter showed plenty left. Unknown must mean dear.
    expect(relativeModelCost("some-future-model-2099")).toBeGreaterThan(
      relativeModelCost("claude-opus-4-1"),
    );
  });

  test("every model in the table is distinct from its neighbours", () => {
    // Guards against a price entry being duplicated, which would make two different models tie and make
    // the sort's order between them arbitrary.
    const models = [
      "claude-haiku-4-5",
      "gpt-4o-mini",
      "gpt-4.1-mini",
      "claude-sonnet-4-5",
      "gpt-4.1",
      "claude-opus-4-1",
    ];
    const costs = models.map(relativeModelCost);
    expect(new Set(costs).size).toBe(costs.length);
  });
});

describe("the chain is ordered cheapest first", () => {
  test("full tier keeps everything, cheapest first", () => {
    const ordered = orderChainByCost(
      [
        link("claude-opus-4-1"),
        link("claude-haiku-4-5"),
        link("claude-sonnet-4-5"),
      ],
      "full",
    );
    expect(ordered.map((l) => l.model)).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
      "claude-opus-4-1",
    ]);
  });

  test("a model's configured order does not survive the sort", () => {
    // The person configured opus first; the ladder still puts the cheap one first, because the point is
    // that the answer degrades with the money rather than with their preference.
    const ordered = orderChainByCost(
      [link("claude-opus-4-1"), link("claude-haiku-4-5")],
      "full",
    );
    expect(ordered[0]?.model).toBe("claude-haiku-4-5");
  });

  test("minimal tier reaches the small models and stops", () => {
    const chain = [
      link("claude-opus-4-1"),
      link("claude-sonnet-4-5"),
      link("claude-haiku-4-5"),
      link("gpt-4o-mini"),
    ];
    const ordered = orderChainByCost(chain, "minimal");
    // gpt-4o-mini and haiku, and NOT the two large ones.
    expect(ordered.map((l) => l.model)).toEqual([
      "gpt-4o-mini",
      "claude-haiku-4-5",
    ]);
  });

  test("reduced tier is wider than minimal, never narrower", () => {
    const chain = [
      link("claude-opus-4-1"),
      link("claude-sonnet-4-5"),
      link("claude-haiku-4-5"),
      link("gpt-4o-mini"),
    ];
    expect(orderChainByCost(chain, "reduced").length).toBeGreaterThanOrEqual(
      orderChainByCost(chain, "minimal").length,
    );
  });

  test("the chain is NEVER empty, even when nothing is affordable", () => {
    // A refusal is the last resort, not the first. A person whose allowance has run down should get the
    // model they configured at the end of a window, not an error.
    const expensiveOnly = [link("claude-opus-4-1")];
    expect(orderChainByCost(expensiveOnly, "minimal")).toHaveLength(1);

    const unknown = [link("who-knows-2099")];
    expect(orderChainByCost(unknown, "minimal")).toHaveLength(1);
  });

  test("a chain of one is returned as-is, because there is nothing to choose", () => {
    const only = link("claude-opus-4-1");
    expect(orderChainByCost([only], "minimal")).toEqual([only]);
  });

  test("an empty chain stays empty rather than inventing a model", () => {
    expect(orderChainByCost([], "full")).toEqual([]);
  });

  test("ordering is by cost, so every step down is cheaper than the one before", () => {
    const chain = [
      link("claude-opus-4-1"),
      link("claude-sonnet-4-5"),
      link("claude-haiku-4-5"),
      link("gpt-4o-mini"),
    ];
    for (const tier of ["full", "reduced", "minimal"] as const) {
      const costs = orderChainByCost(chain, tier).map((l) =>
        relativeModelCost(l.model),
      );
      for (let i = 1; i < costs.length; i++) {
        expect(costs[i]!).toBeGreaterThanOrEqual(costs[i - 1]!);
      }
    }
  });
});

describe("the tier follows the money", () => {
  test("a full window is full, and an empty one is minimal", () => {
    expect(costTierFor(100)).toBe("full");
    expect(costTierFor(0)).toBe("minimal");
  });

  test("the ladder only ever degrades, never recovers, as the number falls", () => {
    const order = { full: 0, reduced: 1, minimal: 2 } as const;
    let previous = -1;
    for (let percent = 100; percent >= 0; percent -= 5) {
      const rank = order[costTierFor(percent)];
      expect(rank).toBeGreaterThanOrEqual(previous);
      previous = rank;
    }
  });

  test("most of the window is spent before anything degrades", () => {
    // A person who has used 45% of a window should not yet be on a smaller model — degradation that
    // starts early is indistinguishable from a worse product.
    expect(costTierFor(55)).toBe("full");
    expect(costTierFor(45)).toBe("reduced");
  });
});

describe("refusal is the last resort", () => {
  test("a window with anything left is never refused", () => {
    expect(turnRefusal(1, new Date())).toBeNull();
    expect(turnRefusal(99, new Date())).toBeNull();
  });

  test("an empty window is refused in a sentence that names the reset", () => {
    const message = turnRefusal(0, new Date("2026-03-20T00:00:00.000Z"));
    expect(message).toContain("2026-03-20");
    expect(message).toContain("computer time is unaffected");
  });
});
