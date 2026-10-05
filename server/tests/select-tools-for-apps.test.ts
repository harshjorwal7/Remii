import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { appOf, selectToolsForApps } from "../src/plugins/selection";

/**
 * Narrowing by app.
 *
 * The property under test throughout: an action never becomes unreachable, and a normal sentence
 * never quietly loads a different app's definition of it. When the message names no app, the whole
 * grant comes back — the same behaviour as offering nothing, except it offers everything.
 */

function tool(name: string) {
  return {
    ref: `server/${name}`,
    name: `mcp__${name}`,
    description: `Action ${name}.`,
    parameters: z.object({}),
    execute: async () => "ok",
  };
}

const gmail = Array.from({ length: 63 }, (_, index) =>
  tool(
    `composio-gmail__GMAIL_${["FETCH_EMAILS", "SEND_EMAIL", "FETCH_MESSAGE", "LIST_MESSAGES"][index % 4]}_${index}`,
  ),
);
const slack = Array.from({ length: 40 }, (_, index) =>
  tool(`composio-slack__SLACK_ACTION_${index}`),
);
const granted = [...gmail, ...slack];

describe("appOf", () => {
  test("reads the app out of the model spelling of the granted ref", () => {
    expect(appOf("mcp__composio-gmail__GMAIL_FETCH_EMAILS")).toBe(
      "composio-gmail",
    );
    expect(appOf("mcp__drive__search_files")).toBe("drive");
  });

  test("names no app for what is not a granted vendor tool", () => {
    /*
     * These are the shapes that must never be narrowed. A tool whose name cannot be read as an app
     * action is not one, and a malformed name must read the same way — "could not tell" rather than
     * "looks like an app called __".
     */
    expect(appOf("computer_navigate")).toBeNull();
    expect(appOf("composio_workbench")).toBeNull();
    expect(appOf("gog_gmail_search")).toBeNull();
    expect(appOf("mcp__")).toBeNull();
    expect(appOf("mcp____GMAIL_FETCH")).toBeNull();
  });
});

describe("selectToolsForApps", () => {
  test("offers the named app's actions and skips the rest", async () => {
    const result = await selectToolsForApps({
      tools: granted,
      text: "send an email in gmail",
    });
    expect(result.reason).toBe("selected");
    expect(result.apps).toEqual(["composio-gmail"]);
    const names = result.offered.map((candidate) => candidate.name);
    expect(names.every((name) => name.includes("composio-gmail"))).toBe(true);
    expect(names.length).toBeLessThanOrEqual(16);
    expect(names.length).toBeGreaterThan(0);
  });

  test("a capability word reaches the app whose actions carry it", async () => {
    /*
     * The question that has no app name in it. "send that invoice" names no app, but `SLACK_SEND` and
     * `GMAIL_SEND_EMAIL` are in the vocabulary a whole-word match reads, and an app that claims the
     * word is relevant. Both may qualify — offering both is the honest answer, and the cap keeps it
     * honest anyway. What is asserted is only that a silent nothing is not.
     */
    const result = await selectToolsForApps({
      tools: granted,
      text: "email the invoice",
    });
    expect(result.reason).toBe("selected");
    expect(
      result.offered.some((candidate) => candidate.name.includes("gmail")),
    ).toBe(true);
  });

  test("a message naming no app offers everything", async () => {
    /*
     * The branch the whole design is graded on. "what did you think of that document" has no app
     * vocabulary, so nothing is ruled out. Losing this would be the whole failure class — narrowing
     * that takes a capability away rather than deciding what is offered.
     */
    const result = await selectToolsForApps({
      tools: granted,
      text: "what did you think of that document",
    });
    expect(result.reason).toBe("nothing-matched");
    expect(result.offered).toHaveLength(granted.length);
  });

  test("the words every action shares match nothing", async () => {
    /*
     * "tool", "tools", "mcp" appear in all of them and would mark both apps as relevant to a message
     * built from nothing else. Dropping those words means an ordinary sentence still hands the list a
     * yes or a no, rather than an always-yes dressed as one.
     */
    const result = await selectToolsForApps({
      tools: granted,
      text: "mcp tool tool",
    });
    expect(result.reason).toBe("nothing-matched");
  });

  test("a per-app cap splits evenly rather than favouring one", async () => {
    const result = await selectToolsForApps({
      tools: granted,
      text: "gmail and slack",
    });
    expect(result.reason).toBe("selected");
    const gmailCount = result.offered.filter((candidate) =>
      candidate.name.includes("gmail"),
    ).length;
    const slackCount = result.offered.filter((candidate) =>
      candidate.name.includes("slack"),
    ).length;
    /*
     * The per-app cap is the only fairness the pass has, and a shared cap would be spent on whichever
     * app matched first. Sixteen from each is the answer that lets both apps answer this turn rather
     * than the one that happened to score higher.
     */
    expect(gmailCount).toBe(16);
    expect(slackCount).toBe(16);
  });

  test("below the floor nothing is narrowed", async () => {
    const small = granted.slice(0, 10);
    const result = await selectToolsForApps({
      tools: small,
      text: "send an email in gmail",
    });
    expect(result.reason).toBe("under-floor");
    expect(result.offered).toHaveLength(small.length);
  });

  test("a single-app Bot whose message names that app is capped, not exempt", async () => {
    const onlyGmail = gmail.slice();
    const result = await selectToolsForApps({
      tools: onlyGmail,
      text: "send the email in gmail",
    });
    /*
     * The case this pass exists for. A single-app Gmail Bot was handed all sixty-three of its actions
     * on every run, and no narrowing was waiting to fix it — the one-app case was the exempt one.
     * Sixteen is the fair share for the app named in the message, and the rest is one search away.
     */
    expect(result.reason).toBe("selected");
    expect(result.offered.length).toBe(16);
  });

  test("a single-app Bot whose message does not name it gets everything back", async () => {
    const onlyGmail = gmail.slice();
    const result = await selectToolsForApps({
      tools: onlyGmail,
      text: "check the calendar",
    });
    expect(result.reason).toBe("nothing-matched");
    expect(result.offered.length).toBe(onlyGmail.length);
  });
});
