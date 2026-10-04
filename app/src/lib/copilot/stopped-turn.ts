import { useAgent } from "@copilotkit/react-core/v2";
import { useEffect, useState } from "react";

/**
 * Why the last turn ended without an answer, for a surface that has to say so itself.
 *
 * A run can end three ways. It finishes, which needs no explanation. It fails in the browser, which
 * arrives as an error. Or the Bot's own stream stops producing anything and this deployment ends the
 * turn for it, which arrives as a RUN_ERROR carrying the sentence the server wrote (see
 * server/src/channels/stall-guard.ts). The last two both leave the same hole on screen: the composer
 * unlocks, the spinner disappears, and nothing says what happened.
 *
 * The reason is kept as a sentence rather than a flag because the reasons are not interchangeable. A
 * Bot that refused, a Bot whose endpoint is down and a Bot that simply stopped talking are three
 * different things to be told, and only the thing that ended the turn knows which one it was.
 */

/**
 * The sentence to show, in the words of whatever ended the turn.
 *
 * Falls back only when there is genuinely nothing to pass on. Saying "the Bot stopped without saying
 * why" is honest about that; inventing a cause would not be, and this is the one moment a person has
 * no other way to find out what went wrong.
 */
export function stoppedReason(reported: unknown): string {
  const said =
    reported instanceof Error
      ? reported.message
      : typeof reported === "string"
        ? reported
        : "";
  return said.trim() || "The Bot stopped without saying why.";
}

/**
 * DID THE SERVER SAY THIS RUN ENDED EARLY, whatever it managed to say on the way?
 *
 * The sentence is read off the run's own finish event, and only a sentence the SERVER wrote counts
 * as one: a model that chose to end its turn says so in prose, and a deployment whose agent is
 * remote may have written its own. An empty or absent `message` on a finish is the ordinary case —
 * a turn that simply completed — and is deliberately NOT an early end, because inventing a reason
 * for every successful turn would put a notice under every answer anybody ever got.
 *
 * THE CODES ARE NAMED, NOT COUNTED. `AGENT_STREAM_STALLED` is written by the stall watchdog
 * (`server/src/channels/stall-guard.ts`) and the rest are the server's own; a code is the one thing
 * that cannot be paraphrased away by an administrator rewording a policy message, which is exactly
 * why the wording alone is not enough.
 */
function endedEarly(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const { code, message } = event as { code?: unknown; message?: unknown };
  if (typeof message === "string" && message.trim() !== "") {
    return true;
  }
  return typeof code === "string" && code.trim() !== "";
}

/**
 * WHETHER A FINISH THAT PRODUCED TEXT STILL NEEDS SAYING IT ENDED EARLY.
 *
 * The rule used to be "a run that said anything is a finished run", and it was the reason a turn cut
 * off halfway through a task was drawn as a turn that finished: a model killed at its hundredth tool
 * call or its twentieth minute has usually said *something* on the way — "let me check that for
 * you" is a sentence a working agent emits constantly — so the partial answer suppressed the only
 * notice that would have explained it, and a person was left with a truncated reply and no reason.
 *
 * So the two conditions are separated rather than traded off. Text alone does not excuse a run the
 * server says it ended early, and its absence alone does not condemn one: a finish with no sentence
 * and no answer is still reported, which is what the callers did with it before.
 */
export function finishNeedsExplanation(
  event: unknown,
  answered: boolean,
): boolean {
  if (endedEarly(event)) return true;
  return !answered;
}

/**
 * Watch one Bot's runs and hold on to the reason the last one ended, if it ended badly.
 *
 * Bound by agent id rather than handed an agent, so a caller that only renders the packaged chat
 * does not have to reach for one: `useAgent` returns the same shared instance the chat itself binds
 * to, so this watches exactly the runs that chat starts.
 *
 * Cleared when the next run begins rather than on a timer. A sentence about a turn that is over
 * should stay until there is something newer to look at, and the person deciding when that is is the
 * one who sends the next message.
 */
export function useStoppedTurn(agentId: string): string | null {
  const { agent } = useAgent({ agentId });
  const [stopped, setStopped] = useState<string | null>(null);

  useEffect(() => {
    /*
     * `onRunFinishedEvent` IS HERE, AND ITS ABSENCE WAS THE BUG THIS HOOK HAD.
     *
     * A run that is cut off partway through a task ends with `RUN_FINISHED` as well as one that
     * finished. Two server limits do exactly that — the channel's continuous-execution deadline and
     * the loop breaker's tool-call cap — and both used to complete without a word. A hook watching
     * only the two failure events therefore saw nothing, and the surface rendered a Bot that had
     * stopped mid-task as one that had simply finished.
     *
     * `onRunErrorEvent` fires first for a limit that announces itself, and this handler is
     * idempotent through the same "only a newer run clears it" rule as above: the last word about a
     * turn wins, and both words come from the turn itself.
     *
     * A finish that produced a real answer is left alone UNLESS the run says it ended early. A Bot
     * that was cut off halfway usually said something on the way there — "let me check that" is a
     * sentence a working agent emits constantly — and treating any text as a finished turn is how a
     * truncated answer reached the screen drawn as a whole one. See `finishNeedsExplanation`.
     */
    const answered = () =>
      agent.messages.some(
        (message) =>
          message.role === "assistant" &&
          typeof message.content === "string" &&
          message.content.trim().length > 0,
      );

    const subscription = agent.subscribe?.({
      onRunInitialized: () => setStopped(null),
      onRunErrorEvent: ({ event }) => setStopped(stoppedReason(event?.message)),
      onRunFailed: ({ error }) => setStopped(stoppedReason(error)),
      onRunFinishedEvent: ({ event }) => {
        if (!finishNeedsExplanation(event, answered())) return;
        const stated =
          typeof event?.message === "string" ? event.message.trim() : "";
        setStopped(
          stated || "This turn ended before the Bot finished answering.",
        );
      },
    });
    return () => subscription?.unsubscribe();
  }, [agent]);

  return stopped;
}
