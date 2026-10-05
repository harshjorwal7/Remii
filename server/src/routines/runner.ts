/**
 * Running one firing of a routine with nobody's browser open.
 *
 * A turn normally has a person in front of it: their browser runs the agent, sees the reply, and
 * tells the server what was said, which is what moves the channel to the top of their roster and
 * lights the unread dot. A routine has none of that, so this file does that last step itself —
 * `recordActivity` — and it is the only place a headless turn does, which is why there is exactly
 * one of those calls per successful firing here and why the tests count them.
 *
 * TWO LEDGERS, AND THEY ARE NOT THE SAME LEDGER.
 *
 * The queue's attempt count (`server/src/work/queue.ts`) bounds retries of ONE FIRING: a consumer
 * that died mid-turn, a runner that is flapping, a lease that stopped being renewed. It answers
 * "how many times have we handed this one due moment out?".
 *
 * The fatigue rule below counts CONSECUTIVE FIRINGS THAT FAILED, in `routine_runs`, across days.
 * It answers "is this routine still worth firing at all?" — a Notion token that expired in March
 * fails every night, and no number of retries of any one night's firing will fix it.
 *
 * Conflating them is how a broken routine either spams a channel — a per-attempt notification
 * posting three times for one bad night — or retries for ever, because a rule counting attempts
 * within a firing never sees the routine that fails cleanly, once, every single night.
 */
import type { AgentActor } from "../agents/profile-types";
import { MAX_ROUTINE_DAILY_CREDITS } from "../billing/metering";
import type { ChannelStore } from "../channels/routes";
import { FATIGUE_THRESHOLD, type RoutineStore } from "./store";

/** Everything a headless turn needs, injectable so tests never dial a model. */
export type TurnRunner = (input: {
  ownerUserId: string; // the actor the run asserts — grants and connections resolve to them
  routineId: string; // what the trail names as having started this turn, rather than the owner
  agentId: string;
  threadId: string; // the owner's thread for the routine's channel
  instruction: string; // the user message of this turn
}) => Promise<{ replyText: string; creditsDeducted?: number }>;

export type RoutineRunner = { run(routineRunId: string): Promise<void> };

/**
 * How much of a failure's reason the channel notification carries.
 *
 * `recordActivity` caps its preview at 200 code points on its own, so this is not about safety, it
 * is about the sentence surviving: the prefix plus this much reason still fits, so the roster shows
 * a failure that says what failed rather than a truncated "This routine failed: Error: could not…".
 * The whole message is on the run row for anybody who wants all of it.
 */
const MAX_NOTIFIED_REASON = 160;

/**
 * Consecutive failed firings after which a routine stops being fired at all.
 *
 * Read from the store so the threshold that acts, the threshold the page reports progress toward,
 * and the wording below cannot drift apart. The sentence says "ten" because that is what
 * `FATIGUE_THRESHOLD` is; changing the constant without that word is a lie somebody reads at four
 * in the morning.
 */
const FATIGUE_LIMIT = FATIGUE_THRESHOLD;

const SWITCHED_OFF = `This routine has failed ${FATIGUE_LIMIT} times in a row, so I have switched it off. Ask me to turn it back on when whatever it needs is working.`;

/** The threshold the page reports progress against, re-exported so the two cannot drift. */
export { FATIGUE_LIMIT };

const CIRCUIT_BREAKER_OFF = `This routine consumed more than ${MAX_ROUTINE_DAILY_CREDITS} credits today, so I have switched it off to prevent runaway usage. Ask me to turn it back on when whatever it needs is working.`;

/** Measured in code points, like every other cap in this area, so nothing is cut mid-pair. */
function shorten(reason: string): string {
  const codePoints = Array.from(reason);
  if (codePoints.length <= MAX_NOTIFIED_REASON) return reason;
  return `${codePoints.slice(0, MAX_NOTIFIED_REASON - 1).join("")}…`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRoutineRunner(options: {
  routineStore: RoutineStore;
  channelStore: ChannelStore;
  runTurn: TurnRunner;
  /**
   * Whether the Bot that would carry this out is paused, and why.
   *
   * Injected rather than read from a store, so this file keeps depending on nothing but the
   * routine and channel stores, and so a deployment with no profile store simply does not check.
   * A read that throws answers "not paused": refusing every routine on a transient database error
   * would silently stop the whole feature, which is a far worse failure than one paused coworker
   * slipping a single firing.
   */
  pausedMessage?: (agentId: string) => Promise<string | null>;
}): RoutineRunner {
  const { routineStore, channelStore, runTurn, pausedMessage } = options;

  async function runOnce(routineRunId: string): Promise<void> {
    const context = await routineStore.runContext(routineRunId);
    /*
     * A deleted routine's queued run is nobody's problem. The routine is gone, its runs cascaded
     * with it, and there is no row left to finish — so there is nothing to record and nothing to
     * say to anybody. The firing is dropped on the floor deliberately.
     */
    if (!context) return;

    const { routineId, ownerUserId, agentId, channelId, instruction } = context;
    // Everything below is done AS the owner: their channel, their thread, their grants.
    const owner: AgentActor = { id: ownerUserId, role: "user" };

    /** One activity record, from the routine's Bot, or a logged miss. Never a throw. */
    async function say(text: string): Promise<void> {
      try {
        await channelStore.recordActivity(owner, channelId, {
          text,
          agentId,
          at: new Date(),
        });
      } catch (error) {
        /*
         * A channel that cannot be written to must not turn a recorded outcome into an unrecorded
         * one. The run row is the ledger; this call is the courtesy of saying so where a person
         * will see it, and losing the courtesy is not worth losing the ledger.
         */
        console.error(
          JSON.stringify({
            type: "routine-activity-unrecorded",
            routineId,
            routineRunId,
            reason: reasonOf(error),
          }),
        );
      }
    }

    /*
     * `get` as the owner already filters soft-deleted channels and non-members, so null covers all
     * three ways this can be over: the channel was deleted, the row is gone, or the owner is no
     * longer in it. No second check, and no turn — a reply with nowhere to land is model spend for
     * nothing.
     *
     * This is why `routines.channel_id` is not a foreign key: the routine survives its channel so
     * the routines page can show it as broken, and the person can point it somewhere else.
     */
    const channel = await channelStore.get(owner, channelId);
    if (!channel) {
      await routineStore.finishRun(
        routineRunId,
        "skipped",
        "the channel is gone",
      );
      return;
    }

    /*
     * A PAUSED COWORKER IS NOT A FAILURE, and this is where that is decided.
     *
     * The pause is enforced in three other places — the handoff desk, bot administration, and the
     * chat turn's own pre-run gate — and none of them covers a routine: a routine neither hops nor
     * is typed at, so a Bot somebody deliberately stopped kept being woken at three in the morning
     * and billed for the privilege.
     *
     * SKIPPED, NOT FAILED, and that distinction is the whole point. A skip is neither a failure nor
     * a reset (see `consecutiveFailures`), so a routine paused for a fortnight does not walk into
     * the fatigue rule and switch itself off on the tenth missed night — the pause is the owner's
     * decision and it is temporary, whereas the fatigue rule exists for a Notion token that expired
     * in March and will still be broken next month. Failing here would also post "This routine
     * failed" into the channel on the first paused night, which invents a problem that does not
     * exist.
     *
     * Nothing is said in the channel either. Whoever paused the Bot already knows, and a routine
     * announcing its own unavailability every night is noise on a conversation nobody is reading.
     */
    if (pausedMessage) {
      let pause: string | null = null;
      try {
        pause = await pausedMessage(agentId);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "routine-pause-check-failed",
            routineId,
            routineRunId,
            reason: reasonOf(error),
          }),
        );
      }
      if (pause !== null) {
        await routineStore.finishRun(
          routineRunId,
          "skipped",
          pause ? `the coworker is paused: ${pause}` : "the coworker is paused",
        );
        return;
      }
    }

    /*
     * ROUTINE CIRCUIT BREAKER: Halt routine if it has consumed more than 30 credits in a single day.
     */
    try {
      const dailyCredits = await routineStore.dailyCreditsConsumed(routineId);
      if (dailyCredits >= MAX_ROUTINE_DAILY_CREDITS) {
        await routineStore.setEnabled(ownerUserId, routineId, false);
        await routineStore.finishRun(
          routineRunId,
          "skipped",
          "daily credit limit exceeded",
          0,
        );
        await say(CIRCUIT_BREAKER_OFF);
        return;
      }
    } catch (circuitError) {
      console.error(
        JSON.stringify({
          type: "routine-circuit-breaker-precheck-failed",
          routineId,
          routineRunId,
          reason: reasonOf(circuitError),
        }),
      );
    }

    let replyText: string;
    let turnCredits = 1;
    try {
      const turnResult = await runTurn({
        ownerUserId,
        routineId,
        agentId,
        threadId: channel.threadId,
        instruction,
      });
      replyText = turnResult.replyText;
      if (turnResult.creditsDeducted !== undefined) {
        turnCredits = turnResult.creditsDeducted;
      }
    } catch (error) {
      const reason = reasonOf(error);
      await routineStore.finishRun(routineRunId, "failed", reason, turnCredits);

      /*
       * THE FATIGUE RULE, read after the failure is recorded — the count has to include this
       * firing, or the tenth failure in a row reads as the ninth and the routine keeps going.
       *
       * Its own try/catch, around the read and the switching-off as well as the message: this all
       * happens after `finishRun`, and nothing in it is allowed to throw its way out of a firing
       * whose failure is already on the row.
       */
      try {
        const failures = await routineStore.consecutiveFailures(routineId);
        if (failures === 1) {
          // Only the first failure after a success. A routine that fails every night at three has
          // one line in the channel, not one line a night for a month.
          await say(`This routine failed: ${shorten(reason)}`);
        } else if (failures >= FATIGUE_LIMIT) {
          // A dead integration should not burn model spend for ever. Switched off, and said out
          // loud, because a routine that goes quiet without explaining itself is worse than one
          // that fails.
          await routineStore.setEnabled(ownerUserId, routineId, false);
          await say(SWITCHED_OFF);
        }
      } catch (fatigueError) {
        console.error(
          JSON.stringify({
            type: "routine-fatigue-rule-failed",
            routineId,
            routineRunId,
            reason: reasonOf(fatigueError),
          }),
        );
      }

      try {
        const dailyCredits = await routineStore.dailyCreditsConsumed(routineId);
        if (dailyCredits >= MAX_ROUTINE_DAILY_CREDITS) {
          await routineStore.setEnabled(ownerUserId, routineId, false);
          await say(CIRCUIT_BREAKER_OFF);
        }
      } catch {}

      return;
    }

    /*
     * The reply, then the outcome. `say` cannot throw, and `finishRun` is finish-once, so neither
     * order can lose the run row — this one is the browser's order: what was said lands in the
     * channel, and then the firing is closed.
     */
    await say(replyText);
    await routineStore.finishRun(
      routineRunId,
      "succeeded",
      undefined,
      turnCredits,
    );

    try {
      const dailyCredits = await routineStore.dailyCreditsConsumed(routineId);
      if (dailyCredits >= MAX_ROUTINE_DAILY_CREDITS) {
        await routineStore.setEnabled(ownerUserId, routineId, false);
        await say(CIRCUIT_BREAKER_OFF);
      }
    } catch (circuitError) {
      console.error(
        JSON.stringify({
          type: "routine-circuit-breaker-postcheck-failed",
          routineId,
          routineRunId,
          reason: reasonOf(circuitError),
        }),
      );
    }
  }

  return {
    async run(routineRunId) {
      /*
       * `run` never throws. Every outcome a routine can have — a gone channel, a refused model, a
       * routine deleted underneath the firing — is recorded on the run row above rather than raised
       * at whoever is draining the queue. This backstop is for the ones that are not outcomes at
       * all, a store that cannot be reached being the honest example: said out loud, because the
       * alternative is a firing that vanishes without a line anywhere.
       */
      try {
        await runOnce(routineRunId);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "routine-run-crashed",
            routineRunId,
            reason: reasonOf(error),
          }),
        );
      }
    },
  };
}
