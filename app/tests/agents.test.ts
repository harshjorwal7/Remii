import { describe, expect, test } from "bun:test";
import { agentFormSchema, agentInputFrom } from "@/lib/agents/form";
import {
  checkProposal,
  proposedBotSchema,
  trimToLimit,
} from "@/lib/agents/proposal";
import { agentKeys } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";

describe("coworker query keys", () => {
  test("separates the visible roster from the hidden one", () => {
    expect(agentKeys.list()).toEqual(["agents", "list", { hidden: false }]);
    expect(agentKeys.list(true)).toEqual(["agents", "list", { hidden: true }]);
    // Both lists and every profile sit under one prefix, so a mutation can invalidate all of them.
    expect(agentKeys.detail("agent_1")[0]).toBe(agentKeys.all[0]);
    expect(channelKeys.detail("channel_1")).toEqual([
      "channels",
      "detail",
      "channel_1",
    ]);
  });
});

describe("coworker form validation", () => {
  test("accepts the fields a person fills in", () => {
    expect(
      agentFormSchema.parse({
        name: "  Expense Manager  ",
        title: "Finance Operations",
        roleDescription: "Review receipts and prepare reimbursement reports.",
        visibility: "private",
      }).name,
    ).toBe("Expense Manager");
  });

  test("carries no address and no key, because a coworker has nowhere else to run", () => {
    const valid = {
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
      visibility: "private" as const,
    };
    // The form offers neither field, so neither is in the contract. Asserted as the exact field list
    // rather than as two absences, because a field the schema accepted but the route refused would be
    // a form a person could fill in and save nowhere.
    expect(Object.keys(agentFormSchema.shape)).toEqual([
      "name",
      "title",
      "roleDescription",
      "visibility",
      "mascot",
    ]);
    expect(agentFormSchema.safeParse(valid).success).toBe(true);
    // The schema and the input builder agree, or a save that works on the server fails in the form.
    const input = agentInputFrom(valid);
    expect(input).not.toHaveProperty("endpoint");
    expect(input).not.toHaveProperty("auth");
  });

  test("rejects what the server would reject", () => {
    const valid = {
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
      visibility: "private" as const,
    };

    expect(agentFormSchema.safeParse({ ...valid, name: "   " }).success).toBe(
      false,
    );
    expect(
      agentFormSchema.safeParse({ ...valid, name: "n".repeat(81) }).success,
    ).toBe(false);
    expect(
      agentFormSchema.safeParse({ ...valid, title: "t".repeat(121) }).success,
    ).toBe(false);
    expect(
      agentFormSchema.safeParse({
        ...valid,
        roleDescription: "r".repeat(1001),
      }).success,
    ).toBe(false);
    expect(
      agentFormSchema.safeParse({ ...valid, visibility: "everyone" }).success,
    ).toBe(false);
  });
});

describe("coworker proposal validation", () => {
  test("proposedBotSchema includes max constraints for LLM tools", () => {
    expect(
      proposedBotSchema.safeParse({
        name: "Renewal Desk",
        title: "Accounts Receivable",
        roleDescription: "r".repeat(1001),
      }).success,
    ).toBe(false);
  });

  /*
   * An over-length role description is CUT, not refused.
   *
   * It used to come back as "trim at least 250 characters and propose it again", which is a
   * sentence a model cannot act on: it has no way to count, it lands near the line rather than
   * under it, and asked again it lands near the line again. That loop spent whole turns and made no
   * coworker. The cut is reported instead, on both sides — the card draws it and the model is told
   * — because a coworker running on half a brief is worse than a shorter brief that everybody knows
   * is shorter.
   */
  test("an over-length role description is cut to the limit rather than refused", () => {
    const checked = checkProposal({
      name: "Renewal Desk",
      title: "Accounts Receivable",
      roleDescription: "r".repeat(1250),
    });

    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.values.roleDescription.length).toBeLessThanOrEqual(1000);
    expect(agentFormSchema.safeParse(checked.values).success).toBe(true);
    expect(checked.trimmed).toEqual([
      {
        field: "roleDescription",
        was: 1250,
        now: checked.values.roleDescription.length,
      },
    ]);
  });

  test("a proposal inside the limits is not trimmed and reports nothing", () => {
    const checked = checkProposal({
      name: "Renewal Desk",
      title: "Accounts Receivable",
      roleDescription: "Chase unpaid renewals.",
    });

    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.trimmed).toEqual([]);
    expect(checked.values.roleDescription).toBe("Chase unpaid renewals.");
  });

  test("over-length name and title are cut on the same terms as the role", () => {
    const checked = checkProposal({
      name: "n".repeat(200),
      title: "t".repeat(300),
      roleDescription: "Do the work.",
    });

    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.values.name.length).toBeLessThanOrEqual(80);
    expect(checked.values.title.length).toBeLessThanOrEqual(120);
    expect(checked.trimmed.map((entry) => entry.field)).toEqual([
      "name",
      "title",
    ]);
  });

  test("a missing field is still refused, because there is nothing left to keep", () => {
    const checked = checkProposal({
      name: "   ",
      title: "",
      roleDescription: "",
    });

    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.length).toBeGreaterThan(0);
    expect(checked.problems.join(" ")).not.toContain("Trim at least");
  });

  test("a cut lands on a boundary rather than inside a word", () => {
    const word =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const long = Array.from({ length: 40 }, () => word).join(" ");

    const cut = trimToLimit(long, 100);

    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.endsWith(" ")).toBe(false);
    // Whatever survived ends on a whole word, not part of one.
    expect(long.startsWith(cut)).toBe(true);
  });

  test("a cut never leaves half a character behind", () => {
    // A family is four people joined by zero-width joiners: one character, many code units. Cutting
    // by code units would leave a dangling joiner rather than a shorter family.
    const family = "👨‍👩‍👧‍👦".repeat(300);

    const cut = trimToLimit(family, 100);

    // The bound that matters is the one the schema checks, so this is code units and it must hold.
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.includes("�")).toBe(false);
    for (const { segment } of new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(cut)) {
      expect(segment).toBe("👨‍👩‍👧‍👦");
    }
  });

  /*
   * The two halves have to agree, and they measure in different units.
   *
   * A string's `.length` is code units, and that is what `.max(1000)` compares. A cut that took the
   * first 1000 *characters* of a description made of emoji would be up to 4000 units long and be
   * refused by the very schema it was cut for — which is the loop, wearing a different hat. This
   * is the test that says the cut is accepted by the thing that checks it.
   */
  test("a cut of emoji is still accepted by the schema it has to satisfy", () => {
    const checked = checkProposal({
      name: "Renewal Desk",
      title: "Accounts Receivable",
      roleDescription: `${"🙂".repeat(900)} tail`,
    });

    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(agentFormSchema.safeParse(checked.values).success).toBe(true);
  });

  test("a cut over plain text still lands on a whole word", () => {
    const cut = trimToLimit(
      "alpha bravo charlie delta echo foxtrot golf hotel",
      20,
    );

    expect(cut.length).toBeLessThanOrEqual(20);
    expect(cut.endsWith(" ")).toBe(false);
  });
});
