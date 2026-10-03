/**
 * Turning the model allowance down as it empties.
 *
 * THE PROBLEM THIS SOLVES. A plan buys a fixed number of dollars of model time a month, and a flat
 * price has to be the same whatever that money is spent on. But a person who spends it in one afternoon
 * and a person who spreads it over a month are billed the same, and without this the first one is
 * refused at hour three and the second is never refused at all. The allowance becomes a speed limit
 * rather than a budget, and the plan stops being worth its price to the person who uses it most.
 *
 * So the answer is not "no" at the end of the allowance but "less" throughout it: as a window empties,
 * turns are answered by a cheaper model. Nothing is refused while there is still money to spend on a
 * good answer, and the degradation is invisible in the sense that matters — the person still gets an
 * answer, and it is still their own assistant with its own memory and its own tools.
 *
 * WHAT IT IS NOT. This is not a model router in the sense of picking the best model per task: the chain
 * is a PROVIDER chain, built by `buildModelChain` for the case where one provider's key stops working.
 * What is added here is a second decision on top — how capable an answer this turn can afford — and the
 * two are deliberately separate, because they answer different questions and conflating them makes the
 * provider fallback stop working.
 *
 * THE COST TABLE IS A GUESS UNTIL IT IS MEASURED, and it says so. These are per-million-token prices
 * for models this deployment can actually be configured with; they are ordering information — which of
 * two models is dearer — and not a billing basis. The dollars that come off somebody's allowance are
 * computed from real token counts against a plan, not from this table. Change a price here and only the
 * ORDERING changes; nothing about what anybody is charged moves.
 */

/** Dollars per million tokens, for ordering. Not a billing basis — see the note above. */
type ModelPrice = { inputPerMillion: number; outputPerMillion: number };

/**
 * Known models, cheapest first.
 *
 * Ordered rather than looked up, because the only question asked is "which of these can this person
 * afford", and a sorted list answers it without needing to price a model nobody has heard of. A model
 * absent from this list is treated as expensive, which is the safe direction: an unpriced model keeps
 * the person on their configured one rather than silently dropping them onto something worse.
 */
const KNOWN_MODEL_PRICES: ReadonlyArray<readonly [string, ModelPrice]> = [
  // Deliberately cheapest-first. The order is the whole contract; the numbers only explain it.
  ["haiku-3-5", { inputPerMillion: 0.8, outputPerMillion: 4 }],
  ["haiku", { inputPerMillion: 1, outputPerMillion: 5 }],
  ["gpt-4o-mini", { inputPerMillion: 0.15, outputPerMillion: 0.6 }],
  ["gpt-4.1-mini", { inputPerMillion: 0.4, outputPerMillion: 1.6 }],
  ["flash", { inputPerMillion: 0.1, outputPerMillion: 0.4 }],
  ["mini", { inputPerMillion: 0.3, outputPerMillion: 1.2 }],
  ["sonnet", { inputPerMillion: 3, outputPerMillion: 15 }],
  ["gpt-4.1", { inputPerMillion: 2, outputPerMillion: 8 }],
  ["gpt-4o", { inputPerMillion: 2.5, outputPerMillion: 10 }],
  ["opus", { inputPerMillion: 15, outputPerMillion: 75 }],
  ["deepseek", { inputPerMillion: 0.27, outputPerMillion: 1.1 }],
  ["qwen", { inputPerMillion: 0.35, outputPerMillion: 1.4 }],
  ["kimi", { inputPerMillion: 0.6, outputPerMillion: 2.5 }],
  ["llama", { inputPerMillion: 0.5, outputPerMillion: 1.5 }],
  ["grok", { inputPerMillion: 3, outputPerMillion: 15 }],
];

/**
 * How dear a model is, relative to the others. Lower is cheaper.
 *
 * Matching on a SUBSTRING of the model string, because model ids are names rather than an enum:
 * `claude-3-5-haiku-20241022` is a real id nobody wants to enumerate. Ordered so the cheaper patterns are
 * tried first, and `flash` before `mini` before the bare name — a model id that says `gpt-4o-mini`
 * contains `mini`, so whichever is checked first decides.
 *
 * A model that matches nothing is given a HIGH cost rather than a low one. The failure that matters is
 * an unrecognised expensive model being treated as cheap and quietly eating somebody's whole allowance.
 */
export function relativeModelCost(model: string): number {
  const name = model.toLowerCase();
  for (const [pattern, price] of KNOWN_MODEL_PRICES) {
    if (name.includes(pattern)) {
      // Blended input/output at a 4:1 ratio, which is roughly what an agentic turn looks like: a lot of
      // context in, a comparatively small answer out. Only ever compared against another model, so the
      // ratio does not have to be exactly right — it has to be the same for both.
      return price.inputPerMillion * 4 + price.outputPerMillion;
    }
  }
  return 1_000;
}

/**
 * How capable an answer this turn can afford, as a fraction of the window that is left.
 *
 * The thresholds are where the money is, not where the quality cliff is — a 30%-left person still gets a
 * good model on a short question, and a 10%-left person asking for a one-line answer should not be moved
 * onto a small model because the WINDOW is low rather than because the question is.
 */
export type CostTier = "full" | "reduced" | "minimal";

export function costTierFor(percentRemaining: number): CostTier {
  if (percentRemaining > 50) return "full";
  if (percentRemaining > 20) return "reduced";
  return "minimal";
}

/**
 * The chain, cheapest model first, with the person's own model LAST.
 *
 * Ordered rather than filtered, so the answer is never "there is no model left": the last entry is
 * whatever they configured, so when even the cheapest option cannot be afforded the turn still runs on
 * the model they chose rather than failing. A person who has run their allowance down to nothing is
 * better served by the model they asked for at the end of a window than by an error.
 *
 * `tier` narrows the search but never empties it, for the reason above.
 */
export function orderChainByCost<T extends { model: string }>(
  chain: readonly T[],
  tier: CostTier,
): T[] {
  if (chain.length <= 1) return [...chain];

  /*
   * Ceilings on the BLENDED cost, which is `input × 4 + output`. The numbers are placed where the
   * families actually fall rather than at round values: about 10 admits the small models and nothing
   * else, and about 30 admits the middle without admitting the largest.
   *
   * Sorted ASCENDING, so the cheap model is first in the array — and the array is a fallback chain,
   * where earlier entries are tried first.
   *
   * This has been wrong in both directions at different points during development, which is why it is
   * worth saying out loud: an ascending sort followed by a `.reverse()` ends up descending, and
   * descending here hands a run whose allowance is nearly exhausted the most expensive model in the list.
   * The tests assert the resulting ORDER rather than a cost figure, which is the thing that has to hold.
   */
  const ceiling: Record<CostTier, number> = {
    full: Number.POSITIVE_INFINITY,
    reduced: 30,
    minimal: 10,
  };

  const affordable = chain.filter(
    (link) => relativeModelCost(link.model) <= ceiling[tier],
  );

  const chosen = affordable.length > 0 ? affordable : [...chain];
  if (chosen.length === 0) return [...chain];

  return [...chosen].sort(
    (a, b) => relativeModelCost(a.model) - relativeModelCost(b.model),
  );
}

/**
 * Whether a turn may start at all.
 *
 * A refusal, unlike degradation, and it is the last resort rather than the first: `orderChainByCost`
 * has already done everything it could. Returns the sentence rather than a boolean, because the caller
 * is a tool boundary and the model is owed something it can say out loud — a person who is told
 * "quota exceeded" by an assistant has learned nothing and asks support; a person told when it resets
 * can plan around it.
 */
export function turnRefusal(
  percentRemaining: number,
  resetsAt: Date,
): string | null {
  if (percentRemaining > 0) return null;
  const when = resetsAt.toISOString().slice(0, 10);
  return `Your model allowance for this period is used up, and it resets on ${when}. Your computer time is unaffected — I can still do work that does not need the model.`;
}
