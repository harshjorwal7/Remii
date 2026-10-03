import { describe, expect, test } from "bun:test";
import { builtInAgentPrompt } from "../src/copilot";
import { SOLE_PERSON_GUIDANCE } from "../../shared/bot-prompt";

/**
 * THE FACT REACHES EVERY BUILT-IN BOT, NOT ONLY THE ONES THAT WERE TESTED.
 *
 * `SOLE_PERSON_GUIDANCE` is one string in `shared/bot-prompt.ts`, and the export can be correct
 * while the wiring is wrong: a prompt that is written and never included changes nothing at all, and
 * no test of the string alone would notice. That is the failure this file is for — it asserts on
 * the assembled prompt, because the assembled prompt is what a model actually reads.
 *
 * It is also asserted in the shape that matters: with NO tools, NO computer and NO standing
 * instructions. A Bot with nothing installed is exactly the Bot that hit this — asked for a
 * coworker it could not create and a capability it did not hold, Remii invented an administrator —
 * and a fact that only appeared alongside a tool grant would have been absent from the very Bot
 * that needed it.
 */

const aBot = (
  overrides: Partial<Parameters<typeof builtInAgentPrompt>[0]> = {},
) => ({
  id: "general-assistant",
  name: "Remii",
  systemPrompt: "You are the chief of staff.",
  ...overrides,
});

describe("a built-in Bot's prompt", () => {
  test("says there is no administrator, even with nothing installed", () => {
    const prompt = builtInAgentPrompt(
      aBot() as Parameters<typeof builtInAgentPrompt>[0],
      [],
      undefined,
      [],
      null,
    );
    expect(prompt).toContain(SOLE_PERSON_GUIDANCE);
    expect(prompt).toMatch(/no administrator/i);
  });

  test("keeps the fact when a computer and connectors are present too", () => {
    /*
     * The computer prose is long and emphatic and is appended last, so it is the likeliest thing to
     * crowd this out — and a Bot that browses is a Bot most likely to hit a sign-in it cannot pass,
     * which is the moment it goes looking for whoever could open the door.
     */
    const prompt = builtInAgentPrompt(
      aBot() as Parameters<typeof builtInAgentPrompt>[0],
      [{ name: "mcp__gmail__send" } as never],
      "You have a browser.",
      ["Gmail"],
      "Prefer short answers.",
    );
    expect(prompt).toContain(SOLE_PERSON_GUIDANCE);
  });

  test("does not bury the fact after a paragraph that contradicts it", () => {
    /*
     * Not a formatting nit. The computer guidance names `computer_request_help` and
     * `computer_request_secret` — tools that do not exist anywhere in this codebase — so a Bot
     * reading it has been told to expect a help desk. The sole-person fact has to be able to answer
     * that, and it can only do so if the reader meets it.
     */
    const prompt = builtInAgentPrompt(
      aBot() as Parameters<typeof builtInAgentPrompt>[0],
      [],
      "Call computer_request_help when a person is needed.",
      [],
      null,
    );
    expect(prompt.indexOf(SOLE_PERSON_GUIDANCE)).toBeGreaterThan(-1);
    // It is a whole paragraph, not a clause lost in someone else's.
    expect(prompt.split("\n\n")).toContain(SOLE_PERSON_GUIDANCE);
  });
});
