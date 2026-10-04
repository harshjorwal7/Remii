import { describe, expect, test } from "bun:test";
import { desktopToolsFor } from "../server/src/computer/desktop-tools";
import {
  CHIEF_OF_STAFF_GUIDANCE,
  COMPUTER_GUIDANCE,
  COMPUTER_SLEEP_GUIDANCE,
  COMPUTERLESS_GUIDANCE,
  SOLE_PERSON_GUIDANCE,
} from "./bot-prompt";
import { BOT_ADMIN_TOOL_NAMES } from "../server/src/remi/bot-admin";
import { botHoldsTheComputer, REMII_AGENT_ID } from "./remii";

describe("COMPUTER_GUIDANCE", () => {
  test("keeps paragraph breaks as blank lines instead of collapsing them into spaces", () => {
    expect(COMPUTER_GUIDANCE).toContain("\n\n");
    expect(COMPUTER_GUIDANCE).not.toContain("  ");
  });

  test("keeps each paragraph as one unbroken line of prose", () => {
    for (const paragraph of COMPUTER_GUIDANCE.split("\n\n")) {
      expect(paragraph).not.toContain("\n");
      expect(paragraph.length).toBeGreaterThan(0);
    }
  });

  test("keeps the sentences the guidance is load-bearing on", () => {
    /*
     * These are the claims a Bot cannot recover from being wrong about: that it has a computer, that
     * the screen is how it looks, that files have their own faster tools, and that the machine sleeps.
     * Asserted as sentences rather than as a whole blob, so an edit that keeps the meaning does not
     * have to be fought and an edit that quietly drops one fails here.
     */
    expect(COMPUTER_GUIDANCE).toContain("You have a real computer");
    expect(COMPUTER_GUIDANCE).toContain("computer_screen");
    expect(COMPUTER_GUIDANCE).toContain(
      "FILES AND THE SHELL ARE FASTER THAN THE SCREEN",
    );
    expect(COMPUTER_GUIDANCE).toContain(COMPUTER_SLEEP_GUIDANCE);
    expect(COMPUTER_GUIDANCE).toContain(
      "Say what you found or did in plain language, briefly.",
    );
  });

  test("tells the Bot the machine sleeps, because the price depends on it", () => {
    // The idle stop is what makes a flat monthly price honest, so a Bot that does not know about it
    // will pause mid-task and charge for a machine doing nothing.
    //
    // This asserted the literal "4 minutes", which is what made it a liability rather than a test: the
    // figure is now generated from `E2B_AUTOSTOP_MINUTES`, so a deployment running a ten-minute
    // window was correctly told ten and this failed for being right. What matters is that the Bot is
    // told SOMETHING and that it is told the truth, which the block at the end of this file checks
    // against the setting the machine will actually obey.
    expect(COMPUTER_SLEEP_GUIDANCE).toMatch(/\d+ minutes/i);
    expect(COMPUTER_SLEEP_GUIDANCE).toMatch(/finish the job in one sitting/i);
    expect(COMPUTER_GUIDANCE).toContain(COMPUTER_SLEEP_GUIDANCE);
  });
});

describe("COMPUTERLESS_GUIDANCE", () => {
  test("says plainly that there is no computer", () => {
    expect(COMPUTERLESS_GUIDANCE).toContain("You do not have a computer");
  });

  test("names who does have one, and the tool for asking", () => {
    // A prohibition alone leaves the model to invent a remedy, and the remedy it invents is an
    // approver. So the remedy is named: Remii, and message_bot, which relays the answer back.
    expect(COMPUTERLESS_GUIDANCE).toContain("REMII HAS THE COMPUTER");
    expect(COMPUTERLESS_GUIDANCE).toContain("message_bot");
  });

  test("forbids reporting a screen it never saw", () => {
    // The failure this exists to stop: a Bot with no screen reaches for the explanation that feels
    // closest, which is a permission somebody is withholding, and sends the person after a person.
    expect(COMPUTERLESS_GUIDANCE).toMatch(/never claim you looked at a page/i);
    expect(COMPUTERLESS_GUIDANCE).not.toMatch(/administrator/i);
  });

  test("does not describe hands the Bot does not have", () => {
    expect(COMPUTERLESS_GUIDANCE).not.toMatch(/real hands/i);
    expect(COMPUTERLESS_GUIDANCE).not.toContain("computer_click");
  });
});

/**
 * There is no administrator, and a Bot has to be told so.
 *
 * A person asked this deployment for a coworker it could not create and a capability it did not
 * hold. Remii's answer: "I have no browser tool… an administrator can grant those on that
 * connector", and then asked whether to "leave this for an administrator to enable browser and
 * WhatsApp access on this deployment".
 *
 * The phrase exists nowhere in this codebase, in any prompt, in any product copy. It is the model's
 * own invention, reached for because the failure looked like a permissions wall and the familiar
 * shape of a permissions wall is somebody else who can lift it. The deployment says the opposite at
 * boot: the `user_roles` table was removed and `INITIAL_ADMIN_EMAILS` is ignored, because every
 * person is sovereign over their own data and there is no role that grants anything.
 *
 * The cost is not the wrong word — it is sending a person to an office that does not exist, with a
 * confident and specific and entirely fictional remedy attached. So the fact is stated, and the
 * real alternative is named in its place.
 */
describe("SOLE_PERSON_GUIDANCE", () => {
  test("states that there is no administrator to escalate to", () => {
    expect(SOLE_PERSON_GUIDANCE).toContain("no administrator");
  });

  test("forbids the two ways it shows up as a dead end", () => {
    // "ask one" and "wait for one" are the phrasings that send a person looking for someone.
    expect(SOLE_PERSON_GUIDANCE).toMatch(/never tell them to ask one/i);
    expect(SOLE_PERSON_GUIDANCE).toMatch(/nobody else to escalate to/i);
  });

  test("names the real alternative rather than only forbidding the wrong one", () => {
    /*
     * A prohibition on its own leaves the model to invent a replacement, which is how it invented
     * the first one. The remedy has to be concrete: what is missing, what would fix it, and the tool
     * that asks. `ask_person` is on offer to every Bot (`[asking, connecting, waiting, ...]` in
     * `index.ts`), so naming it promises nothing that is not true.
     */
    expect(SOLE_PERSON_GUIDANCE).toMatch(
      /what is missing and what would fix it/i,
    );
    expect(SOLE_PERSON_GUIDANCE).toContain("ask_person");
  });

  test("says the person is the only one, not merely that no admin exists", () => {
    // "There is no administrator" alone is compatible with a second person who can help, which is
    // the reading that produced "leave this for someone else". The count is the load-bearing part.
    expect(SOLE_PERSON_GUIDANCE).toMatch(/only person on this deployment/i);
  });

  test("closes the inference that actually produced it: someone must be above me", () => {
    /*
     * The first version of this guidance was obeyed in letter and ignored in practice — the model
     * still said "a grant only an administrator can make" with the fact sitting in the middle of its
     * prompt. The cause is in Remii's own role: it holds `bot_grant` and `bot_revoke`, so it grants
     * things to other coworkers and reasons symmetrically — something above me must have granted
     * this to me. The familiar answer to that is an administrator, and the familiar answer was
     * wrong.
     *
     * So the paragraph has to name that inference and break it, rather than restate the absence of
     * an administrator that the model had already read and discounted.
     */
    expect(SOLE_PERSON_GUIDANCE).toMatch(/nobody above you/i);
    expect(SOLE_PERSON_GUIDANCE).toMatch(
      /does not mean something sits above you/i,
    );
    // And it has to say WHO holds those powers, or the sentence leaves the gap open.
    expect(SOLE_PERSON_GUIDANCE).toMatch(/they are the one who grants/i);
  });

  test("separates a missing capability from a pending approval", () => {
    // "Waiting on an approver" is the other half of the same story, and it is the one that makes a
    // person wait for something that is never going to happen.
    expect(SOLE_PERSON_GUIDANCE).toMatch(
      /not because it is waiting on an approver/i,
    );
  });
});

/**
 * EVERY TOOL THIS PROMPT NAMES MUST BE A TOOL A RUN IS GIVEN.
 *
 * The check above is for wording, which is a matter of judgement. This one is arithmetic, and it
 * exists because the gap it catches was invisible for the whole life of the computer: the prompt
 * named `computer_request_help` and `computer_request_secret`, neither of which existed anywhere in
 * the codebase, and `COMPUTER_TOOLS` was declared in `schema.ts` and referenced by nothing. Nothing
 * failed. No test went red. The gateway's methods were all there and all governed — reachable only
 * over signed-in HTTP, for the live screen, by the one party that did not need a tool to use them.
 *
 * A Bot told it has hands, offered none, and asked to do a job does something worse than fail: it
 * reports the absence, and reaches for a familiar explanation. That is what sent a person to find an
 * administrator who does not exist.
 *
 * So the contract is stated where the names live: a name in this file is a promise that a run can
 * keep. The list is explicit rather than derived, because a derivation that quietly dropped a name
 * would pass here and fail in production.
 */
describe("the tools this prompt names", () => {
  /*
   * DERIVED FROM THE REAL TOOL SET, which is the whole point of this file existing.
   *
   * It used to hold a hand-written `REGISTERED` array, and the comment above it claimed it "reads the
   * registered list out of the bridge itself rather than trusting the constant above". It did not. It
   * compared the prompt against a list somebody typed by hand, which is a tautology: it passed
   * perfectly while the guidance named nine tools that no longer existed and four real ones went
   * unnamed. A test that cannot fail is worse than no test, because it reads as coverage.
   *
   * So the list is built by calling the tool factory. Adding a tool without mentioning it in the
   * guidance now fails; mentioning one that does not exist fails; deleting one the guidance still
   * promises fails. That is the contract, and it can only be kept by reading the source of truth.
   */
  const REGISTERED: readonly string[] = desktopToolsFor({
    resolve: async () => null,
    actor: { id: "u1" },
    botId: REMII_AGENT_ID,
  }).map((t) => t.name);

  /** Tools the prompt mentions that come from somewhere other than the desktop tool set. */
  const ELSEWHERE = ["ask_person", "message_bot", "connect_app"] as const;

  const namedIn = (text: string): string[] => [
    ...new Set(
      [...text.matchAll(/\b(computer_[a-z_]+)\b/g)].map(
        (match) => match[1] as string,
      ),
    ),
  ];

  test("the derived list is not empty, or these assertions would pass on nothing", () => {
    // The guard against the guard. A factory that returned [] would make every containment check below
    // vacuously true, which is the same failure mode as the hand-written list, one level down.
    expect(REGISTERED.length).toBeGreaterThan(5);
  });

  test("every tool the computer guidance names is a real one", () => {
    const named = namedIn(COMPUTER_GUIDANCE);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      expect(REGISTERED).toContain(name);
    }
  });

  test("every tool the computerless guidance names is a real one", () => {
    // `message_bot` is the whole of that paragraph's usefulness, so it is named there on purpose.
    const named = namedIn(COMPUTERLESS_GUIDANCE).filter(
      (name) => name !== "message_bot",
    );
    for (const name of named) {
      expect(REGISTERED).toContain(name);
    }
  });

  test("every tool that exists is mentioned in the guidance", () => {
    /*
     * The other direction, and the one that catches a real gap: a tool the Bot holds but was never
     * told about is a tool it will not reach for, because nothing in its instructions says the
     * capability exists.
     */
    const named = new Set([
      ...namedIn(COMPUTER_GUIDANCE),
      ...namedIn(COMPUTERLESS_GUIDANCE),
      ...ELSEWHERE,
    ]);
    for (const name of REGISTERED) {
      expect(named).toContain(name);
    }
  });

  test("the fast machine tools exist, because the guidance promises they are faster", () => {
    // The claim "files and the shell are faster than the screen" is only true if those tools are
    // real. If they are ever removed the paragraph has to go with them, and this fails first.
    for (const name of [
      "computer_shell",
      "computer_read_file",
      "computer_write_file",
      "computer_list_files",
    ]) {
      expect(REGISTERED).toContain(name);
    }
  });

  test("the ask-for-help tool is named the way the prompt names it", () => {
    // It used to be `computer_ask_for_help` in the tools and `computer_request_help` in the prompt, so
    // the guidance instructed a call that could never be made.
    expect(REGISTERED).toContain("computer_request_help");
    expect(REGISTERED).not.toContain("computer_ask_for_help");
  });
});

describe("who holds the computer", () => {
  test("Remii is the one Bot allowed to drive the screen", () => {
    expect(botHoldsTheComputer(REMII_AGENT_ID)).toBe(true);
  });

  test("no other Bot is", () => {
    // A person may make as many coworkers as they like, and none of them may reach the mouse. This is
    // what keeps the price of the product independent of how many Bots somebody created.
    // `general-assistantx` is the sharp one: a prefix of the real id is not the real id, and an
    // `startsWith` gate would wave it through.
    for (const botId of [
      "",
      "support",
      "expenses",
      `${REMII_AGENT_ID}x`,
      REMII_AGENT_ID.toUpperCase(),
      null,
      undefined,
    ]) {
      expect(botHoldsTheComputer(botId)).toBe(false);
    }
  });
});

describe("the number the prompt quotes about sleeping", () => {
  /*
   * The prompt used to hardcode "4 minutes" in three places and the behaviour read a fourth number
   * from the plan, with a comment in the server explaining that the two must never drift. They were
   * one edit away from disagreeing, and `E2B_AUTOSTOP_MINUTES` — documented in `.env.example` and
   * parsed at boot — was read by nothing at all.
   *
   * So the figure is generated now, and the property worth locking down is not "it says four" but
   * "it says whatever the machine will actually do". That is what fails if someone reintroduces a
   * literal, and it is the thing the original comment was reaching for.
   */
  const withIdleStop = async (value: string | undefined) => {
    const previous = process.env.E2B_AUTOSTOP_MINUTES;
    if (value === undefined) delete process.env.E2B_AUTOSTOP_MINUTES;
    else process.env.E2B_AUTOSTOP_MINUTES = value;
    try {
      // Re-imported so the module-level strings are rebuilt against the new environment.
      const mod = await import(`./bot-prompt?idle=${value ?? "unset"}`);
      return mod.COMPUTER_SLEEP_GUIDANCE;
    } finally {
      if (previous === undefined) delete process.env.E2B_AUTOSTOP_MINUTES;
      else process.env.E2B_AUTOSTOP_MINUTES = previous;
    }
  };

  test("follows the setting the machine will actually obey", async () => {
    expect(await withIdleStop("30")).toContain("about 30 minutes");
    expect(await withIdleStop("12")).toContain("about 12 minutes");
  });

  test("falls back to the plan default when the setting is absent or unusable", async () => {
    expect(await withIdleStop(undefined)).toContain("about 4 minutes");
    expect(await withIdleStop("not-a-number")).toContain("about 4 minutes");
    expect(await withIdleStop("-5")).toContain("about 4 minutes");
  });
});

/**
 * The chief of staff, told what it is answerable for over the roster.
 *
 * This block exists because the powers are real and the prompt had to catch up: Remii could stop
 * and pause coworkers and reshape them, and was still carrying the paragraph that says not to
 * reason from the powers you hold. Left alone it would have read its own tool set, concluded that a
 * supervisor therefore sits above it, and gone looking for the arrangement this deployment does not
 * have — the exact failure SOLE_PERSON_GUIDANCE was written to prevent, arriving from the other
 * direction.
 */
describe("CHIEF_OF_STAFF_GUIDANCE", () => {
  test("names every tool it promises, and the promise is checkable", () => {
    // The file header says a name in this file is a promise. This block adds six, so the names are
    // asserted against the list the tools are actually built from rather than trusted.
    for (const name of [
      "coworker_status",
      "bot_list",
      "bot_read",
      "bot_stop",
      "bot_pause",
      "bot_resume",
      "bot_update",
    ]) {
      expect(BOT_ADMIN_TOOL_NAMES).toContain(name as never);
      expect(CHIEF_OF_STAFF_GUIDANCE).toContain(name);
    }
  });

  test("says the authority is over coworkers", () => {
    expect(CHIEF_OF_STAFF_GUIDANCE).toContain("CHIEF OF STAFF");
    expect(CHIEF_OF_STAFF_GUIDANCE).toMatch(/keep an eye on the whole roster/i);
  });

  test("draws the boundary with the person in the same breath, or it does nothing", () => {
    /*
     * The load-bearing sentence. Authority over coworkers read on its own becomes authority over
     * the person — and then "the person told me to" becomes something the deployment has a view
     * about, which is precisely the sovereign-user design this repository is built on.
     */
    expect(CHIEF_OF_STAFF_GUIDANCE).toMatch(
      /OVER COWORKERS, NOT OVER THE PERSON/i,
    );
    expect(CHIEF_OF_STAFF_GUIDANCE).toMatch(/never about overruling them/i);
  });

  test("does not undo the paragraph above it", () => {
    // The two blocks sit adjacent in Remii's prompt and agree: no administrator, and nothing above
    // either of them. If either said otherwise the model would have two instructions to reconcile and
    // would reach for whichever suited the question.
    expect(CHIEF_OF_STAFF_GUIDANCE).toMatch(/still no administrator/i);
    expect(CHIEF_OF_STAFF_GUIDANCE).not.toMatch(
      /you are in charge of the person/i,
    );
  });

  test("tells it to watch the roster before repainting it", () => {
    // The reported bug, prevented rather than fixed: two coworkers in one colour read as one. A
    // warning that is not attached to the tool that causes it is a warning nobody acts on.
    expect(CHIEF_OF_STAFF_GUIDANCE).toMatch(/read the roster/i);
    expect(CHIEF_OF_STAFF_GUIDANCE).toMatch(
      /same colour are hard to tell apart/i,
    );
  });

  test("does not promise that a stop undoes what a tool already did", () => {
    // A model told only "it stopped" will offer a retraction it cannot perform.
    expect(CHIEF_OF_STAFF_GUIDANCE).toMatch(
      /keeps going unless that tool honours/i,
    );
  });

  test("is not told to the whole roster — only to the Bot that holds the computer", () => {
    // A coworker that believed it could pause other coworkers would reach for a tool it was never
    // offered, and fill the gap with a plausible name for something that does not exist.
    expect(COMPUTERLESS_GUIDANCE).not.toContain("bot_pause");
    expect(SOLE_PERSON_GUIDANCE).not.toContain("bot_pause");
  });
});
