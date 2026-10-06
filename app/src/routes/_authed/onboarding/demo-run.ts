import type { Message } from "@ag-ui/core";
import {
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { createChannelMutationOptions } from "@/lib/channels/mutations";
import {
  type AgentChannel,
  type ChannelActivityBrief,
  channelRunningQueryOptions,
} from "@/lib/channels/queries";
import { afterMs, joinWithin } from "@/lib/copilot/join-thread";
import { newId } from "@/lib/new-id";
import { queryClient } from "@/query-client";
import { REMII_AGENT_ID } from "../../../../../shared/remii";
import { DEMO_BUDGET_MS, DEMO_TASK, type DemoPhase } from "./demo";

/**
 * How long a thread join is given before the message goes anyway.
 *
 * The same 1.5s as `channel-chat.tsx:66`, and for the same reason: a connect left in flight replaces
 * the agent's messages on the next run and loses anything added in between, so it has to end rather
 * than be outrun. Reused rather than retuned because a demo thread is no more forgiving than a real
 * one — it is a real thread with a real run on it.
 */
const JOIN_DEADLINE_MS = 1_500;

/**
 * How long a send waits for the runtime agent before going without it.
 *
 * Also the same value, and also for the same reason: `deliver` in `channel-chat.tsx` treats an agent
 * that has not reported ready as a reason to stop waiting rather than a reason to never send, and two
 * copies of that decision with different numbers is how a run ends up sent into a void on one screen
 * and not another.
 */
const READY_DEADLINE_MS = 1_500;

/**
 * The plain text of an assistant turn, or empty.
 *
 * AG-UI lets a message's content be a string or an array of parts, and a Bot turn that carried a
 * component or an attachment arrives as the second shape. This reads the first and takes the text
 * parts of the second, because the only thing this screen shows is prose. Written out rather than
 * borrowed from the transcript because the transcript's version answers "what should this message
 * DRAW" and this one answers "what did it SAY" — different questions, and they diverge on exactly the
 * turns a demo produces.
 */
export function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

/**
 * The conversation the demo runs in, created once.
 *
 * `createChannelMutationOptions` used exactly as written, including its `onSuccess` invalidating the
 * roster — which is not incidental here. The wizard hands this channel to the person when onboarding
 * ends, so it has to be in the roster cache by the time they land on `/`, or their first conversation
 * is a row that appears a beat late and looks like something they have to go and look for.
 *
 * A channel needs no message to exist, or to appear: the server orders on
 * `coalesce(lastMessageAt, createdAt)` precisely so a channel somebody is about to use is not buried,
 * and the sidebar already relies on that when the roster is empty. So this is allowed to be empty when
 * it resolves, and the message that follows is what gives it a preview.
 *
 * The guard is a ref rather than the mutation's own flags because those flags change on every render
 * and this effect would then re-run on each transition — sending the same task twice, which is the one
 * way this hook could cost a person real money.
 */
export function useDemoChannel(enabled: boolean) {
  const create = useMutation(createChannelMutationOptions(queryClient));
  const asked = React.useRef(false);

  React.useEffect(() => {
    if (!enabled || asked.current) return;
    asked.current = true;
    create.mutate([REMII_AGENT_ID]);
  }, [create, enabled]);

  return {
    channel: create.data ?? null,
    /** Whether this deployment could not even make the conversation. */
    failed: create.isError,
  };
}

/**
 * What Remii is doing in the demo conversation.
 *
 * `channelRunningQueryOptions` used as written, for the reasons its own docblock gives at length: the
 * envelope key is `activity` and reading `.activity` off the result returns `undefined`, which reads
 * as "nothing is running" on a thread that is busy; and it polls only while something is running, so
 * a finished demo costs nothing.
 *
 * `enabled` is false until there is a channel, which is what lets this be one unconditional hook —
 * `useAgent` in `DemoTurn` needs the same thing and gets it from a component boundary instead.
 */
export function useDemoActivity(
  channel: AgentChannel | null,
): ChannelActivityBrief | null {
  /*
   * SPREAD AND NOT PASSED AS A SECOND ARGUMENT.
   *
   * `useQuery(options, filters)` reads its second parameter as a `QueryClient`, so handing it
   * `{ enabled }` there is not "add a flag" — it is "find me a client", and the compiler says so by
   * offering an overload in which `enabled` is a property of a `QueryClient`. Merging into the options
   * object is the form this version of the library accepts, and the query is built fresh either way
   * because `queryOptions` returns a plain object rather than a frozen one.
   */
  const { data } = useQuery({
    ...channelRunningQueryOptions(channel?.id ?? ""),
    enabled: channel !== null,
  });
  return data ?? null;
}

/**
 * What the run has reported back to the screen above it.
 */
export type DemoRunReport = {
  phase: DemoPhase;
  /** Remii's reply, once there is one. Markdown, because a Bot's prose is markdown. */
  reply: string | null;
};

/**
 * Start the demo.
 *
 * Renders NOTHING. This is the machinery, not the screen: it owns the one decision the whole
 * demonstration rests on — that what is being watched is a real run on a real thread, started by the
 * same three calls `deliver` in `channel-chat.tsx` makes — and none of the drawing.
 *
 * WHY NOT MOUNT `ChannelChat` AND LET IT DRAW. Because it is the conversation screen: a transcript, a
 * composer, mention chips, an attachment strip, a Stop button and a queue, inside a wizard with one
 * idea and at most two steps. Everything on it would be a second thing to read while the person is
 * trying to watch a cursor move. Reusing the run mechanics and drawing our own surface is the trade,
 * and it is the one worth making — the transcript is not the point, the screen is.
 *
 * WHY IT IS ITS OWN COMPONENT RATHER THAN A HOOK. `useAgent` registers against a real thread id, and
 * a hook called from a component that renders before the channel exists would have to pass a
 * placeholder and then re-register. Splitting here means the hook is only ever mounted on a channel
 * that is already true, which is the same reason `channel-chat.tsx` takes a channel as a prop instead
 * of fetching one.
 *
 * WHAT IS DELIBERATELY MISSING FROM `deliver`, and why each omission is safe HERE and only here:
 *
 * - **History restore.** `deliver` reads the durable thread back on mount and merges it, because a
 *   channel a person is returning to holds messages this tab has never seen. A demo channel is brand
 *   new with one message on it, so there is nothing to restore and no read to wait for.
 * - **Skill and instruction turns.** The demo task is one sentence with no `/` chip on it, so there is
 *   no instruction to prepend as a system turn ahead of it.
 * - **Tool-call repair.** `deliver` repairs unanswered tool calls before sending, because providers
 *   reject a later turn whose earlier calls have no result. There is no earlier turn.
 * - **The busy flag.** `deliver` reports `busy` to the roster so a sidebar row shows a dot. There is
 *   no sidebar during onboarding — the route is deliberately outside `_app` — and this screen takes
 *   its state from the run and the activity brief, which are both more accurate than a flag set before
 *   the run exists.
 * - **The failure throw.** `deliver` throws so the composer can put a person's words back. Nothing here
 *   was typed, so there is nothing to put back, and the phase carries the failure instead.
 */
export function DemoTurn({
  budgetMs = DEMO_BUDGET_MS,
  channel,
  onReport,
}: {
  budgetMs?: number;
  channel: AgentChannel;
  onReport: (report: DemoRunReport) => void;
}) {
  const { copilotkit } = useCopilotKit();
  /*
   * The brief, read here rather than passed in.
   *
   * TanStack dedupes by query key, so this and the one the status line above asks for are one request
   * and one cache entry, not two polls. It is read here because the run's PHASE depends on it — Remii
   * asking is what moves this screen from `working` to `needs-you` — and a prop would mean the answer to
   * "is it blocked on a person" arrives one render late, which is the one transition on this screen that
   * has to be immediate.
   */
  const activity = useDemoActivity(channel);
  const { agent, isReady } = useAgent({
    /*
     * Channel-scoped, exactly as `channel-chat.tsx:285` scopes it, so the demo's durable thread is
     * this conversation's own. A run started on the bare agent id lands in whatever thread the
     * coworker last spoke on, which on a fresh deployment is a thread nobody is on — the answer would
     * exist and nothing would ever draw it again.
     */
    agentId: `channel:${channel.id}`,
    runtimeAgentId: REMII_AGENT_ID,
    threadId: channel.threadId,
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
    ],
  });

  const report = React.useRef(onReport);
  report.current = onReport;

  /*
   * The join gate. Every turn waits on this rather than on the connect's own state, because a message
   * added while the connect is in flight is erased by it — `join-thread.ts` says so in its first line
   * of prose, and `deliver` is built around it. A promise created once and opened by the effect, rather
   * than a boolean, because the code that waits on it may start before the effect has run.
   */
  const openJoin = React.useRef<() => void>(() => {});
  const joined = React.useRef<Promise<void> | null>(null);
  if (joined.current === null) {
    joined.current = new Promise<void>((resolve) => {
      openJoin.current = resolve;
    });
  }

  React.useEffect(() => {
    if (!isReady) return;
    let current = true;

    void (async () => {
      try {
        await joinWithin({
          connect: copilotkit.connectAgent({ agent }),
          deadline: afterMs(JOIN_DEADLINE_MS),
          detach: () => agent.detachActiveRun(),
          /*
           * No `keepAttached`. Unlike a channel somebody walked away from, there is no run on this
           * thread before this screen starts one, so the deadline may end the connect as freely as it
           * would on any thread at rest — which is the whole reason `joinWithin` asks at all.
           */
        });
      } catch {
        /*
         * A join that throws is a join that is over, and it must not take the gate with it: the run
         * below waits on that gate, so a rejection here would be a demonstration that never happens.
         */
      }
      if (current) openJoin.current();
    })();

    return () => {
      current = false;
      openJoin.current();
    };
  }, [agent, copilotkit, isReady]);

  /*
   * Every assistant turn as it lands, so the reply is the last thing said rather than everything said
   * so far. `OnMessagesChanged` fires on every token, which makes this the one place in the wizard
   * that reacts at token rate — deliberately, because it is the only way to watch an answer being
   * written rather than waiting for it to exist. It writes one set and one piece of state and reads
   * nothing: no layout, no measurement, and the only thing downstream of it is a paragraph of prose.
   */
  const said = React.useRef<Set<string>>(new Set());
  const seenReply = React.useRef<string | null>(null);

  React.useEffect(() => {
    for (const message of agent.messages) {
      if (message.role !== "assistant" || said.current.has(message.id))
        continue;
      said.current.add(message.id);
      const text = textOf(message).trim();
      if (!text || text === seenReply.current) continue;
      seenReply.current = text;
      report.current({ phase: "working", reply: text });
    }
  }, [agent.messages]);

  /* The run itself, once per channel — the guard is what stops a re-render sending it twice. */
  const started = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!isReady || started.current === channel.id) return;
    started.current = channel.id;

    let cancelled = false;
    let overTime: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      /* Bounded: the same "go without it" the real send does. */
      await Promise.race([
        joined.current ?? Promise.resolve(),
        afterMs(READY_DEADLINE_MS),
      ]);
      if (cancelled) return;

      /* The join, always. A message added under an in-flight connect is erased by it. */
      await joined.current;
      if (cancelled) return;

      report.current({ phase: "working", reply: seenReply.current });

      /*
       * The budget. It does not stop the run and it does not report an error — it stops the WIZARD
       * waiting. The conversation carries on over there whether or not this screen is still watching,
       * which is the honest way to describe what happened and the reason a slow deployment does not
       * also look like a broken one.
       */
      overTime = setTimeout(() => {
        if (!cancelled && !theBriefHasFailed.current)
          report.current({ phase: "over-time", reply: seenReply.current });
      }, budgetMs);

      agent.addMessage({ content: DEMO_TASK, id: newId(), role: "user" });

      try {
        await copilotkit.runAgent({ agent });
      } catch {
        /*
         * SWALLOWED, and the reason matters. A refused run would otherwise leave the screen on
         * `working` forever — a working state on a conversation that has stopped, which is a lie told
         * to somebody deciding whether to trust the product. And just as false is the alternative: a
         * success state on a run that never happened. `failed` is the honest shape of it, and the way
         * out of it is that the conversation is real and the person has not been told a lie about what
         * is in it.
         */
        if (!cancelled) {
          report.current({ phase: "failed", reply: seenReply.current });
        }
        return;
      }

      if (!cancelled) {
        report.current({ phase: "settled", reply: seenReply.current });
      }
    })();

    return () => {
      cancelled = true;
      if (overTime) clearTimeout(overTime);
    };
  }, [agent, budgetMs, channel.id, copilotkit, isReady]);

  /*
   * Remii stopping to ask is the beat worth building the whole screen around, and it is ANNOUNCED by
   * the server rather than inferred from the absence of tokens. `channelRunningQueryOptions` is the
   * same poll the conversation screen uses, so this reads the same fact the roster reads.
   *
   * The brief is only allowed to move the phase forward. `needs-you` is not sticky, because Remii
   * asks, is answered and carries on, and a screen still asking for a password after it has moved on
   * would be worse than never asking.
   */
  const waiting = activity?.state === "waiting_on_you";
  const failed = activity?.state === "failed";
  const wasWaiting = React.useRef(false);
  const theBriefHasFailed = React.useRef(false);

  React.useEffect(() => {
    /*
     * Report the brief's failure ONCE, on the first poll that saw it — not on the one that followed.
     *
     * The brief is polled every four seconds and the error text does not change between them, and
     * `report.current` hands the wizard a fresh object either way, so a per-poll call here is a re-render
     * of a screen that has very little to re-render about every four seconds, forever. The ref already
     * exists for the other reason — keeping the run's answer from clobbering it — and the two reasons
     * are the same reason: the first time is the only time there is anything new to say.
     */
    if (failed && !theBriefHasFailed.current) {
      theBriefHasFailed.current = true;
      report.current({ phase: "failed", reply: seenReply.current });
      return;
    }
    if (failed) return;
    if (waiting && !wasWaiting.current) {
      wasWaiting.current = true;
      report.current({ phase: "needs-you", reply: seenReply.current });
    } else if (!waiting) {
      wasWaiting.current = false;
    }
  }, [failed, waiting]);

  return null;
}
