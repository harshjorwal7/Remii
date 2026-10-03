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
     * A finish that produced a real answer is a finished turn and is left alone. A Bot that was cut
     * off halfway is exactly the case this hook exists to catch, and its partial answer stays on
     * screen underneath the sentence — the explanation sits under the transcript, not over it.
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
        if (answered()) return;
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
