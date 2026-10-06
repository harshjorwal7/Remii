/**
 * Whether this deployment can put a real screen in front of a new person, and what it would say.
 *
 * The onboarding used to draw a desktop: two invented windows on a gradient, with a cursor sliding
 * between them forever. That is a feature tour, and a feature tour is the thing a purple cow is
 * defined against — everybody has one, so nobody remembers it. What this product actually has is the
 * screen itself, and the only honest way to introduce it is to show it working.
 *
 * So the whole first-run experience now has two paths, and this module is where the choice between
 * them is made. The live path needs three independent things and every one of them can be absent on
 * a real deployment:
 *
 * - a computer behind the server (`/api/capabilities`), which is off unless an E2B key is configured;
 * - Remii on the person's roster, because `botHoldsTheComputer` in `shared/remii.ts` is what gates the
 *   desktop tools, and every other coworker is told it has no screen at all;
 * - a browser, because the demo drives one.
 *
 * Which is why the answer is a function of what is actually here rather than a boolean somebody set.
 * Getting this wrong in the optimistic direction is the failure this file exists to prevent: a
 * spinner that never resolves, on a screen a person is meeting the product for the first time.
 */
import type { AIState } from "@/components/agents/orb/ai-core";
import { aiStateForChannel } from "@/components/channels/activity-mark";
import type { AgentProfile } from "@/lib/agents/queries";
import type { ChannelActivityBrief } from "@/lib/channels/queries";
import type { DeploymentCapabilities } from "@/lib/deployment/queries";
import { REMII_AGENT_ID } from "../../../../../shared/remii";

/**
 * What the demo needs, decided from what the deployment actually has.
 *
 * The illustrated path is not an error state and is not a consolation prize. It is the same story
 * told with a drawing instead of a machine, and a person who lands on it should have no idea which
 * one they got — which is why nothing downstream branches on the label, only on this boolean.
 */
export type DemoAvailability = "live" | "drawn";

/**
 * Where the demo has got to.
 *
 * `preparing` and `settled` are both states where the screen is waiting on a person rather than on a
 * model, and they are kept apart because they draw differently: one is a screen that has not begun and
 * the other is a screen that has finished and is offering the wheel. Collapsing them would make a
 * finished run indistinguishable from one that never started, which is the one distinction here that a
 * person absolutely needs.
 *
 * Declared beside `demoAvailability` rather than beside the machinery that walks through it, because
 * both the run and the screen that draws it have to name these states and a cycle between two modules
 * to say so is a cycle for nothing.
 */
export type DemoPhase =
  /** Warming the desktop, or creating the conversation. Nothing has been sent yet. */
  | "preparing"
  /** The task is on the wire and Remii has it. */
  | "working"
  /** Remii stopped on something only a person can do. */
  | "needs-you"
  /** A reply landed. */
  | "settled"
  /** The budget expired mid-run. The run is still going, over there, in the conversation. */
  | "over-time"
  /** The run refused to happen, or errored. Honest, and offered a way out rather than a dead end. */
  | "failed";

/**
 * The coworker who holds the computer, on this person's roster.
 *
 * BY ID, and not through `defaultAgentProfile`. That helper answers "who should receive this message"
 * and prefers `picked-harness` over Remii, which is the right answer for a conversation and the wrong
 * one here: `picked-harness` has no screen, so a demo handed to it would watch a coworker explain,
 * at length, that it cannot see one. The question this asks is not who is default but who can drive,
 * and `botHoldsTheComputer` is the answer to that, so the id is asked for directly.
 *
 * Null rather than undefined because the caller has one question to ask and null says it.
 */
export function computerHoldingAgent(
  agents: readonly AgentProfile[] | undefined,
): AgentProfile | null {
  if (!agents) return null;
  return agents.find((agent) => agent.id === REMII_AGENT_ID) ?? null;
}

/**
 * Whether a live demo is possible, from the three things it needs.
 *
 * `computer: false` from a server that could not be reached is indistinguishable from a server that
 * has no computer, and both answer the same way, which is the fail-closed direction the capability
 * query already commits to in its own docblock. Drawing a picture of a screen is a smaller promise
 * than drawing one that never appears.
 */
export function demoAvailability(
  capabilities: DeploymentCapabilities | undefined,
  holder: AgentProfile | null,
): DemoAvailability {
  if (capabilities?.computer !== true) return "drawn";
  if (holder === null) return "drawn";
  return "live";
}

/**
 * What Remii is asked to do, and why this task and not a more impressive one.
 *
 * This text is the demo. It is sent to a real model, on a real computer, on somebody's first day, so
 * it is chosen for being boring rather than for being impressive:
 *
 * - **read-only.** It navigates and reads. Nothing is sent, submitted, bought or posted. A first-run
 *   task that could have a side effect is a task that can have a side effect on a stranger's
 *   deployment, and no amount of it looking good is worth that.
 * - **one page, no search.** A search result depends on an index, a ranking and a network, so the
 *   run's length and its answer are both out of our hands. A single known URL is the one thing on
 *   the internet that is reliably, boringly there.
 * - **one sentence, asked for.** The answer is the receipt. What the person is actually watching is
 *   the cursor moving on a real screen, and a paragraph would bury that under reading.
 * - **it is told to ask.** The second sentence is the part that makes this a demonstration of the
 *   product rather than of the web: when the page wants something only a person can give, Remii stops
 *   and asks instead of working around it. `computer_request_help` is a real tool, seeded and
 *   described in `server/src/computer/computer-skills.ts`, and the demonstration is that this
 *   deployment will use it rather than that it has one.
 *
 * The login instruction is a hope, not a script. Nothing here fakes a password prompt, because a
 * password box that a scripted animation puts on screen teaches a person to trust a thing the product
 * cannot do. If Remii asks, the real ask appears; if the page has no login, the person takes the
 * wheel themselves, which is the same lesson offered on every run.
 */
export const DEMO_TASK =
  "Open https://example.com on your computer and tell me in one sentence what it says. " +
  "If you hit a login or a captcha, ask me instead of working around it.";

/**
 * How long the demo is given before the wizard stops waiting and moves on.
 *
 * A bound, and a generous one, because the honest failure here is a person sitting on a spinner
 * during the only screen where they decide what they think of the product. The first request can take
 * twenty seconds or more on its own — `live-screen.tsx` says so about the very call that wakes the
 * desktop — and the run after it adds a model, a browser and a network on top.
 *
 * When this expires the wizard does NOT report a failure. It hands over the screen with whatever has
 * happened so far and says the rest is waiting in the conversation, because by then there is a real
 * conversation and it is genuinely still going. The alternative — a red sentence about a timeout on
 * a first-run screen — describes an implementation detail as though it were a broken product.
 */
export const DEMO_BUDGET_MS = 90_000;

/**
 * Whether this run is worth starting.
 *
 * NAMED, AND EXTRACTED, BECAUSE THE CONDITION IS THE WHOLE OF WHAT IS AT STAKE HERE.
 *
 * The first version of this was `step === 1` — "the demo screen exists, so run the demo" — and on a
 * deployment with no computer behind it that spent a real model turn on a coworker answering that it cannot
 * see a screen, and left that conversation in the new person's sidebar as the first thing on their home
 * page. The drawing was playing next to it, telling a completely different story. So the capability is
 * part of the question rather than a detail of how the screen is drawn, and it is written here where a test
 * can reach it.
 *
 * Both halves are load-bearing. `step` alone would spend a run before anybody asked to see one. The
 * capability alone would start a demonstration while the person is still reading the welcome screen — on
 * the welcome screen, which exists precisely so the twenty seconds the desktop takes to wake happen under
 * a paragraph instead of in front of somebody.
 */
export function shouldRunDemo(
  step: number,
  availability: DemoAvailability,
): boolean {
  return step === 1 && availability === "live";
}

/**
 * The work state the mascot wears, from the run.
 *
 * `aiStateForChannel` is the join between the server's six run states and the six every AI surface in
 * this product speaks, and it is used here rather than a table of our own — because a state that meant
 * one thing to the roster and another to the mascot would be a bug nobody would go looking for. It is
 * exactly the question this screen asks: what is this coworker doing.
 *
 * BUT IT IS NOT THE WHOLE ANSWER, and the two places it is overridden are the interesting ones.
 *
 * The brief goes quiet when a run ends, which is correct for a roster — a finished run is the absence of
 * activity — and wrong for a screen whose entire job is to show somebody that something finished. Left
 * alone, a completed demo would settle the mascot back to its resting face at the exact moment the
 * person is deciding whether what they just watched was impressive. So `settled` is `done`, which is the
 * one state that means it, and it is held until the wizard moves on.
 *
 * `needs-you` is `listening` for the same reason the table maps it that way: a run blocked on a person
 * is not working, it is waiting to be spoken to, and `wink` would say the opposite in the middle of the
 * one beat that most needs to read as a question. That mapping is the table's, not ours — it is
 * restated here only so the override reads as deliberate.
 */
export function aiStateForDemo(
  phase: DemoPhase,
  activity: ChannelActivityBrief | null,
  busy: boolean,
): AIState {
  if (phase === "settled") return "done";
  if (phase === "needs-you") return "listening";
  if (phase === "over-time") return "streaming";
  /*
   * `failed` IS an override rather than part of what falls through to the brief. The brief answers
   * what the server currently reports, and between a refused run and the brief noticing there is a moment
   * where the brief still says `thinking` and the only thing that knows otherwise is this phase. Wearing
   * an idle face on a screen whose last thing that happened was a failure would be the mascot keeping a
   * secret from the person it is supposed to be at work for.
   */
  if (phase === "failed") return "error";
  return aiStateForChannel(activity, busy);
}

/**
 * The words, which are the demo as much as the machinery is.
 *
 * Godin's test for a purple cow is whether somebody would describe it to a friend, and copy is half of
 * what they would describe. "Each agent has its own computer" is a specification: it names a
 * property, and a property is not worth repeating. Every string here is the same claim stated as
 * something a person could tell somebody else about.
 */
export const COPY = {
  /** The welcome screen. One sentence, because there is one idea. */
  welcome: "It works while you do something else.",
  /**
   * The sub-line under it, and the line that is actually the product. The password sentence is here
   * because it is the only claim no competitor can make truthfully: everything else on this screen is
   * a claim about capability, and this one is a claim about limits.
   */
  welcomeBody:
    "Every coworker has a real browser on a computer of its own. You can watch it work, take the wheel whenever you want, and hand it back.",

  /** The demo screen's heading, changed as the demo moves through its beats. */
  demoIdle: "Watch it work.",
  demoWorking: "It is working.",
  demoNeedsYou: "It stopped and asked.",
  demoDone: "That is the whole product.",

  /**
   * The standing instruction under the screen, present on every beat.
   *
   * One sentence, and it is the invitation. A screen somebody only watches is a demo; a screen they
   * are told they may interrupt is a thing they are being trusted with. The button beside it is real
   * and is always live, so this is not a promise about a moment — it is a description of the state.
   */
  handoffHint: "Take the wheel any time. It waits.",

  /** What the person is told while a cold desktop is being woken. */
  waking: "Waking up a computer for you…",
} as const;
