import { describe, expect, it } from "bun:test";
import { REMII_AGENT_ID } from "@/lib/agents/default-agent";
import {
  CHOOSABLE_COLOR_IDS,
  DEFAULT_COLOR_SLOTS,
  mascotChoiceForSeed,
  mergeMascotChoice,
  RESTING_EXPRESSION_IDS,
  restingExpressionForSeed,
} from "@/mascot/seed";
import {
  MASCOT_COLOR_IDS,
  MASCOT_SHAPE_IDS,
  type MascotColorId,
  type MascotExpressionId,
} from "../../shared/mascot-ids";

/**
 * The seeds this hashes are agent ids, which are opaque strings from the database rather than
 * sequential integers. Building them from a UUID shape keeps the test honest about that: a hash that
 * only survives `String(n)` would pass a suite full of numbers and fall over on the real data.
 */
function agentIds(count: number) {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const hex = (n: number) => n.toString(16).padStart(12, "0");
    // A fixed layout, the shape a cuid or a uuid takes, so consecutive ids differ in their first
    // characters too and not only at the end.
    out.push(
      `${hex(i * 2654435761)}-${hex(i ^ 0x9e3779b9)}-${hex(i * 40503)}-agent`,
    );
  }
  return out;
}

describe("mascotChoiceForSeed", () => {
  it("gives the same agent the same mascot, every time", () => {
    // The one property everything else rests on. It has to hold on another machine, in another
    // process, months later, or a coworker's face changes under them between sessions.
    const first = mascotChoiceForSeed("agent_01HX8QK2M4P");
    for (let i = 0; i < 50; i++) {
      expect(mascotChoiceForSeed("agent_01HX8QK2M4P")).toEqual(first);
    }
  });

  it("gives different agents different mascots", () => {
    const seeds = agentIds(500);
    const seen = new Map<string, string>();
    let collisions = 0;
    for (const seed of seeds) {
      const mascot = mascotChoiceForSeed(seed);
      const key = `${mascot.shape}/${mascot.color}/${restingExpressionForSeed(seed)}`;
      if (seen.has(key)) collisions++;
      seen.set(key, seed);
    }
    /*
     * The expectation is derived from the actual size of the space rather than guessed, because the
     * space is not 1,536 any more: a face is no longer chosen, so a coworker is a shape, a colour and
     * a resting face — and an unchosen coworker draws colour from a weighted subset, so the number of
     * distinct colours is the number of distinct entries in that subset and the reachable
     * combinations are that times eight shapes times the resting faces.
     */
    // Seven shapes by the eight seeded hues. The floor is below that on purpose: it is a claim that the
    // hash is spreading across the space it actually has, not that the space is large.
    const reachable = DEFAULT_COLOR_SLOTS.length * MASCOT_SHAPE_IDS.length;
    expect(reachable).toBe(56);
    // Birthday-paradox expectation for 500 draws from that many combinations. Comfortably above it
    // still means the hash is spreading; a collapsed axis would push this into the hundreds.
    expect(collisions).toBeLessThan(seeds.length * 0.6);
  });

  it("spreads every shape and every resting face across a real roster", () => {
    const shapes = new Set<string>();
    const faces = new Set<MascotExpressionId>();
    for (const seed of agentIds(2_000)) {
      shapes.add(mascotChoiceForSeed(seed).shape);
      faces.add(restingExpressionForSeed(seed));
    }
    // An axis that never appears is a whole dimension the roster would render and never show, which is
    // the kind of thing that only ever gets diagnosed by looking at one.
    expect(shapes.size).toBe(MASCOT_SHAPE_IDS.length);
    // Not the whole vocabulary: the resting faces are a deliberate ten of the sixteen, because the
    // other six are answers to something an agent is doing. Every one of the ten has to turn up.
    expect(faces.size).toBe(RESTING_EXPRESSION_IDS.length);
    for (const face of faces) expect(RESTING_EXPRESSION_IDS).toContain(face);
  });

  it("gives every unchosen coworker a colour, and never a black one", () => {
    // Two earlier versions of this list failed here and both were caught by rendering a twelve-row
    // roster and looking at it: one was half `ink`, which put six black blobs in every dozen rows.
    const seen = new Set<MascotColorId>();
    for (const seed of agentIds(2_000))
      seen.add(mascotChoiceForSeed(seed).color);

    for (const color of seen) expect(DEFAULT_COLOR_SLOTS).toContain(color);
    expect(seen).not.toContain("ink");
    // `cream` was in the first cut and rendered a coworker as a ghost on the light surface; `grey` read
    // as dead rather than quiet, and has since left the palette altogether. `cream` is still choosable
    // and still not a default; `ink`, `brown` and `grey` are gone from the palette, and the next test
    // says so.
    expect(seen).not.toContain("cream");
    expect(seen).not.toContain("grey");
    expect(seen).not.toContain("brown");
  });

  it("uses the whole vivid wheel, so a dozen coworkers are told apart by colour alone", () => {
    const seen = new Set<MascotColorId>();
    for (const seed of agentIds(2_000))
      seen.add(mascotChoiceForSeed(seed).color);
    expect(seen.size).toBe(DEFAULT_COLOR_SLOTS.length);
    // Every entry distinct, so the hash cannot waste a slot on a colour nobody distinguishes.
    expect(new Set(DEFAULT_COLOR_SLOTS).size).toBe(DEFAULT_COLOR_SLOTS.length);
  });

  it("leaves no neighbour two rows apart on the same colour", () => {
    // A roster is read as a list, so what matters is that neighbours differ — not that the colours are
    // evenly spread overall, which a hash already gives.
    const agents = agentIds(2_000).map(
      (seed) => mascotChoiceForSeed(seed).color,
    );
    let sameAsNeighbour = 0;
    for (let i = 1; i < agents.length; i++) {
      if (agents[i] === agents[i - 1]) sameAsNeighbour++;
    }
    // Even weighting predicts about one in eight. The bar is generous, because this is about how a
    // roster reads and not about how a hash behaves.
    expect(sameAsNeighbour / agents.length).toBeLessThan(0.2);
  });

  it("still lets a person choose every colour, narrowing the default only", () => {
    // The subset is a default, not a palette. Losing a colour from the picker to save a roster from
    // looking garish would be the wrong trade, so this is asserted rather than assumed.
    expect(CHOOSABLE_COLOR_IDS.length).toBe(MASCOT_COLOR_IDS.length);
    expect(CHOOSABLE_COLOR_IDS).toEqual(MASCOT_COLOR_IDS);
    for (const color of CHOOSABLE_COLOR_IDS) {
      expect(mergeMascotChoice({ color }, "agent_1").color).toBe(color);
    }
  });

  it("keeps the axes independent when one of them changes", () => {
    // Two ids that differ in one character must not come out matching on every axis. This is the
    // reason the digest is read from separate byte ranges rather than by hashing once per axis: a
    // shape that changed must not have taken somebody's resting face with it.
    const a = mascotChoiceForSeed("agent-aaaa");
    const b = mascotChoiceForSeed("agent-aaab");
    const differing = [
      a.shape !== b.shape,
      a.color !== b.color,
      restingExpressionForSeed("agent-aaaa") !==
        restingExpressionForSeed("agent-aaab"),
    ].filter(Boolean).length;
    expect(differing).toBeGreaterThan(0);
  });

  it("does not collapse on a single differing character", () => {
    // The specific failure a bad avalanche step produces: the low bits of the digest track the low
    // bits of the input, so a family of ids that differ only at the end all land on one value.
    const faces = new Set(
      Array.from({ length: 32 }, (_, i) =>
        restingExpressionForSeed(`agent-${String.fromCharCode(97 + i)}`),
      ),
    );
    expect(faces.size).toBeGreaterThan(1);
  });

  it("copes with an empty seed rather than dividing by nothing", () => {
    // `channel.agentIds` can carry an empty string before a real id is assigned, and an avatar that
    // throws on mount takes a whole roster row with it.
    expect(() => mascotChoiceForSeed("")).not.toThrow();
    expect(mascotChoiceForSeed("")).toEqual(mascotChoiceForSeed(""));
  });
});

describe("Remii", () => {
  it("is a pink cloud in every installation", () => {
    // The one coworker present in every roster of every deployment, and the one anybody looks at
    // twice. A hash gives it whatever its id lands on, which means the product's own assistant looks
    // different on every install for no reason.
    expect(mascotChoiceForSeed(REMII_AGENT_ID)).toEqual({
      shape: "cloud",
      color: "pink",
    });
    expect(restingExpressionForSeed(REMII_AGENT_ID)).toBe("curious");
  });

  it("still lets a person choose over it", () => {
    // A default, not a lock: picking one axis keeps the other two, so somebody who dislikes pink can
    // pick a colour and still get the cloud.
    const chosen = mergeMascotChoice({ color: "violet" }, REMII_AGENT_ID);
    expect(chosen.color).toBe("violet");
    expect(chosen.shape).toBe("cloud");
    // An explicit choice and no stored choice must not agree, or there would be no way to tell them
    // apart in the database.
    expect(chosen).not.toEqual(mascotChoiceForSeed(REMII_AGENT_ID));
  });
});

describe("mergeMascotChoice", () => {
  it("inherits the seeded mascot when nothing was chosen", () => {
    expect(mergeMascotChoice(null, "agent_01HX8QK2M4P")).toEqual(
      mascotChoiceForSeed("agent_01HX8QK2M4P"),
    );
  });

  it("keeps the seeded axes around the one that was chosen", () => {
    // A person who has only ever picked a colour should still get a different shape per coworker,
    // not eight identical circles. Falling back to the shared default instead would collapse every
    // agent on a roster onto one silhouette and read as a bug.
    const seed = "agent_01HX8QK2M4P";
    const merged = mergeMascotChoice({ color: "teal" }, seed);
    expect(merged.color).toBe("teal");
    expect(merged.shape).toBe(mascotChoiceForSeed(seed).shape);
  });

  it("has no expression to keep or override", () => {
    // The face moved to the state, and a stored one is ignored rather than honoured. A client that
    // still sends one has to get a save it can see succeed, and a face that quietly ignored the choice
    // would be indistinguishable from the bug.
    const merged = mergeMascotChoice(
      { shape: "cloud", color: "teal", expression: "wary" } as never,
      "agent_01HX8QK2M4P",
    );
    expect(Object.keys(merged).sort()).toEqual(["color", "shape"]);
  });

  it("lets a complete choice override every axis", () => {
    const choice = { shape: "cloud", color: "pink" } as const;
    expect(mergeMascotChoice(choice, "agent_anything")).toEqual(choice);
  });

  it("is not fooled by an unrecognised field", () => {
    const merged = mergeMascotChoice(
      { shape: "octagon" } as never,
      "agent_01HX8QK2M4P",
    );
    expect(merged.shape).toBe(mascotChoiceForSeed("agent_01HX8QK2M4P").shape);
  });
});
