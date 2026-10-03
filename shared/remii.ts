/**
 * Which Bot holds the computer.
 *
 * There is ONE desktop per person, and exactly one Bot is allowed to drive it: Remii, the
 * chief of staff. Every other Bot a person creates works through connected apps and APIs, and when a
 * job needs a browser or a screen it asks Remii rather than pretending it can see a screen.
 *
 * Why one Bot and not one per Bot: a desktop is billed by the hour it is switched on, so "a computer
 * per Bot" turns a person with five coworkers into five machines, and the price of the product stops
 * depending on how much work it does. One computer per person is what makes a flat monthly price
 * honest, and it is the same shape as the rest of the deployment: the person is the unit of account,
 * not the Bot.
 *
 * The cost of that choice is paid in one place — a Bot that cannot see a screen has to ask for one.
 * `message_bot` is the tool for it, and it already relays Remii's answer back into the asking Bot's
 * own conversation, so the handoff costs the person nothing.
 *
 * Shared because both halves have to agree and neither can be the one to decide: the server gates the
 * desktop tools on it, and the app decides which Bot is the default everywhere no explicit choice was
 * made. The literal appeared in both trees, hardcoded, in a dozen places — the value is a database key
 * and a product promise at the same time, so it is declared once.
 *
 * RENAMED FROM `"general-assistant"`, and the old value is gone rather than kept as an alias. It was a
 * poor name for what this Bot is: it is not a general assistant, it is the one that holds the computer and
 * hands work to the others, and the generic name is what made the product's centre of gravity read as an
 * also-ran. Every row that names it is rewritten by `0072_remii_rename` — this is a primary key in
 * `agent_profiles` and a foreign key target from `channel_agents`, `bot_computers` and `channels`, so the
 * migration drops those constraints, rewrites, and restores them. An alias would have been cheaper and
 * would have left two ids for one Bot, which is the state where "who holds the computer" has two answers.
 */

/**
 * The well-known id Remii is stored under. It is a primary key in `agent_profiles`.
 *
 * `remii`, not `remi`: the product is spelled with two i's everywhere a person sees it, and the id
 * travels into URLs, audit rows and support conversations.
 */
export const REMII_AGENT_ID = "remii";

/** The name the person sees. Not the id: the id appears in URLs and audit rows. */
export const REMII_AGENT_NAME = "Remii";

/**
 * Whether this Bot is the one that holds the computer.
 *
 * The single gate. The desktop tools, the computer guidance in the system prompt, the pre-warm and
 * the metering all hang off this, so there is exactly one place that decides who may drive a screen.
 */
export function botHoldsTheComputer(botId: string | null | undefined): boolean {
  return botId === REMII_AGENT_ID;
}

/**
 * The sentence a Bot without a computer is given when it asks for one.
 *
 * Named because it is what the model reads, and because the alternative is worse: a Bot holding a
 * button that is never there reaches for the familiar explanation, and the familiar explanation of a
 * missing capability is a permission somebody is withholding. This deployment has no such somebody —
 * the person asking is the only one who grants — so the remedy is another Bot, not an approver.
 */
export const NO_COMPUTER_SENTENCE =
  "You do not have a computer. You can see no screen and you can drive no mouse and keyboard. " +
  "Remii has the computer. If this work needs a browser, a page, or anything on a screen, hand it to " +
  "Remii with message_bot, say exactly what you need done there, and wait for its answer to come back. " +
  "Do the work yourself with your connected apps if a tool already covers it.";
