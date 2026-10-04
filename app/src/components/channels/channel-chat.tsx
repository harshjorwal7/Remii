import type { Message } from "@ag-ui/core";
import {
  type Attachment,
  CopilotChatConfigurationProvider,
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { attachmentModality } from "@/components/channels/chat-messages";
import {
  ComponentCommandPicker,
  RepoCommandPicker,
} from "@/components/channels/command-picker";
import { toAgentOptions } from "@/components/channels/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  seedMessage,
  takeFirstMessage,
  transcriptMessages,
} from "@/components/channels/transcript-messages";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { attachmentUrl } from "@/lib/channels/attachments";
import {
  recordChannelActivityMutationOptions,
  setChannelBusy,
} from "@/lib/channels/mutations";
import type { ChannelActivityBrief } from "@/lib/channels/queries";
import {
  type AgentChannel,
  type ChannelSummary,
  channelKeys,
  channelRunningQueryOptions,
} from "@/lib/channels/queries";
import { useComposerCommands } from "@/lib/commands/use-composer-commands";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { afterMs, joinWithin } from "@/lib/copilot/join-thread";
import {
  bumpRun,
  bumpTurn,
  liveRun,
  patchLiveRun,
  useLiveRun,
} from "@/lib/copilot/live-runs";
import { repairUnansweredToolCalls } from "@/lib/copilot/repair-history";
import {
  finishNeedsExplanation,
  stoppedReason,
} from "@/lib/copilot/stopped-turn";
import { readThreadMessages } from "@/lib/copilot/thread-messages";
import { queryClient } from "@/query-client";
import { newId } from "../../lib/new-id";

/**
 * How long a stalled thread join is worth waiting for before it is ended.
 *
 * Ended, not outrun. See `lib/copilot/join-thread.ts` for what a connect left in flight does to the
 * next message sent.
 */
const JOIN_DEADLINE_MS = 1500;

/**
 * Backstop for a message typed before the runtime agent exists; it must not be discarded.
 */
const SEND_WITHOUT_RUNTIME_AFTER_MS = 1500;

type ChannelActivitySignature = {
  agentId: string;
  at: string;
  text: string;
};

function sameActivity(
  left: ChannelActivitySignature | null,
  right: ChannelActivitySignature | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.agentId === right.agentId &&
    left.at === right.at &&
    left.text === right.text
  );
}

export function channelHistoryNotice({
  restoring,
  messageCount,
  lastMessageAt,
  historyAvailability,
  historyReadFailed = false,
  unreadable,
}: {
  restoring: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  historyAvailability: "ready" | "unavailable";
  historyReadFailed?: boolean;
  unreadable: number;
}): string | null {
  if (restoring) return null;

  if (
    historyAvailability === "unavailable" &&
    (historyReadFailed || (messageCount === 0 && lastMessageAt !== null))
  ) {
    return "Earlier messages are temporarily unavailable. You can keep using this conversation.";
  }

  if (unreadable > 0) {
    return unreadable === 1
      ? "One earlier message could not be read and is not shown. The rest of this conversation is complete."
      : `${unreadable} earlier messages could not be read and are not shown. The rest of this conversation is complete.`;
  }

  return null;
}

/**
 * Insert missing durable messages before their next shared ID, keeping local content and order.
 * A shorter read can still contain missing turns after unreadable rows are filtered out. Without a
 * following shared anchor, append the missing tail: the store cannot place it among local-only rows.
 * Return the original array when nothing was added so refreshes can wait for the store to catch up.
 */
function mergeStoredMessages(local: Message[], stored: Message[]): Message[] {
  const localIds = new Set(local.map((message) => message.id));
  const seenStored = new Set<string>();
  const before = new Map<string, Message[]>();
  let pending: Message[] = [];
  for (const message of stored) {
    if (seenStored.has(message.id)) continue;
    seenStored.add(message.id);
    if (localIds.has(message.id)) {
      if (pending.length > 0) before.set(message.id, pending);
      pending = [];
    } else {
      pending.push(message);
    }
  }
  if (before.size === 0 && pending.length === 0) return local;
  return [
    ...local.flatMap((message) => [...(before.get(message.id) ?? []), message]),
    ...pending,
  ];
}

/**
 * The uploaded id and filename an `Attachment` carries once it is `ready`, read from the
 * `metadata` the composer's `onUpload` stamped on it — see `composer/attachments.ts`. Not the
 * SDK's own `attachment.id`, which is a client-side handle for the upload placeholder rather than
 * the id this deployment stored the file under.
 */
function uploadedAttachment(attachment: Attachment): {
  attachmentId: string;
  filename?: string;
} {
  const metadata = attachment.metadata as
    | { attachmentId?: unknown; filename?: unknown }
    | undefined;
  const attachmentId = metadata?.attachmentId;
  if (typeof attachmentId !== "string") {
    throw new Error("Attachment is missing its uploaded id.");
  }
  const filename =
    typeof metadata?.filename === "string" ? metadata.filename : undefined;
  return filename ? { attachmentId, filename } : { attachmentId };
}

/**
 * One attachment, turned into the part shape a stored message carries.
 *
 * THE MODALITY COMES FROM THE BYTES, NOT FROM `attachment.type`, AND THIS IS THE ONLY PLACE IT CAN.
 *
 * `attachment.type` is the browser's claim, fixed before the upload and never reconciled with what
 * the file turned out to be. The server stopped trusting it — `resolvePart` decides an attachment's
 * modality with `classifyAttachment` on its own sniffed `mimeType` — but that correction lives on
 * the server and never comes back here. What this function writes IS the stored message, so a
 * `document` written here is what every later render of that message reads, for ever: a screenshot
 * whose part the browser mislabelled drew a grey file card over the picture, and the transcript's
 * document probe then paid a whole-file read per render for the privilege.
 *
 * Narrowed through the source union rather than read straight off, for the reason `parkedTiles` in
 * `chat-transcript.tsx` narrows the same field: a `data` source's `mimeType` is `file.type`, the
 * very claim being refused, and only a `url` source has been past the server. `attachmentModality`
 * falls back to the declared type when there is no corroborated one, so an attachment that somehow
 * arrives unuploaded is written exactly as it used to be.
 *
 * The comment this replaces said only "image" and "document" reach here because the composer's
 * upload config accepts no other kind of file. That reason is no longer true — the config's
 * `accept` is now the wildcard, and it is `screenPickedFiles` that holds the line. The conclusion still
 * holds; the justification had rotted, which is why the modality is now derived rather than cast.
 */
function toAttachmentPart(attachment: Attachment) {
  const { attachmentId, filename } = uploadedAttachment(attachment);
  const { source } = attachment;
  const mimeType =
    source.type === "url" && source.mimeType ? source.mimeType : undefined;
  return {
    type: attachmentModality(attachment.type, mimeType),
    source: { type: "url" as const, value: attachmentUrl(attachmentId) },
    metadata: filename ? { attachmentId, filename } : { attachmentId },
  };
}

/**
 * A plain string when there is nothing attached, exactly as every message in every channel has
 * always been sent — never a single-element array wrapping the same text, which every existing
 * reader would take a different path for no gain. With attachments, the text goes first as its
 * own part and is left out entirely when empty, since an empty text part is noise the model has
 * to read past.
 *
 * Exported for the test that pins this wire format. Reaching it through `deliver`/`say` would mean
 * standing up `useAgent`'s runtime, the thread join and the ready/join gates around it just to
 * observe a pure string-in-object-out mapping — none of that machinery bears on what this function
 * decides, so a narrow export is the honest way to test the contract without restructuring the
 * module around a test.
 */
export function toMessageContent(
  trimmed: string,
  attachments: readonly Attachment[],
) {
  if (attachments.length === 0) return trimmed;
  const refs = attachments.map(toAttachmentPart);
  return trimmed ? [{ type: "text" as const, text: trimmed }, ...refs] : refs;
}

/** What the roster's "last thing said" reads when a message carried no caption. */
function describeAttachments(attachments: readonly Attachment[]): string {
  if (attachments.length === 1) {
    const { filename } = uploadedAttachment(attachments[0]);
    return filename ? `Sent ${filename}` : "Sent an attachment";
  }
  return `Sent ${attachments.length} attachments`;
}

/**
 * One channel's conversation with one coworker.
 *
 * The local agent id is channel-scoped so two channels with the same coworker keep separate
 * durable threads.
 */
export function ChannelChat({
  activity,
  channel,
  runtimeAgentId,
}: {
  /** What is running in this channel, or null. Drawn above the composer. */
  activity?: ChannelActivityBrief | null;
  channel: AgentChannel;
  runtimeAgentId: string;
}) {
  // The core attaches the frontend tool registry; direct agent runs do not.
  const { copilotkit } = useCopilotKit();
  // Mentions are scoped to the channel's permitted agents.
  const { data: agentProfiles } = useQuery(agentListQueryOptions());
  const channelAgentId = `channel:${channel.id}`;
  const { agent, isReady } = useAgent({
    agentId: channelAgentId,
    runtimeAgentId,
    threadId: channel.threadId,
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
    ],
  });

  /**
   * First-message seed from the compose screen. It is taken once per mount and retained until the
   * agent has its own messages because joining a fresh thread can temporarily empty the agent.
   */
  const [pendingFirst] = useState(() => takeFirstMessage(channel.id));
  const [seed] = useState<Message | null>(() =>
    pendingFirst ? seedMessage(pendingFirst.text, newId()) : null,
  );
  /** Resolved at stash time in channel/new; delivered with the seed so a `/` chip on the first message is real. */
  const seedInstructionsRef = useRef<string[]>(
    pendingFirst?.instructions ?? [],
  );

  /** Cleared by the send-on-mount effect without restarting it. */
  const seedRef = useRef(seed);
  seedRef.current = seed;

  /** Promise gate for ordering the first message after the thread join when possible. */
  const openJoinGate = useRef<() => void>(() => {});
  const joinGate = useRef<Promise<void> | null>(null);
  if (joinGate.current === null) {
    joinGate.current = new Promise<void>((resolve) => {
      openJoinGate.current = resolve;
    });
  }
  const joinGatePromise = joinGate.current;

  /** Promise gate so messages typed before runtime readiness wait instead of being discarded. */
  const openReadyGate = useRef<() => void>(() => {});
  const readyGate = useRef<Promise<void> | null>(null);
  if (readyGate.current === null) {
    readyGate.current = new Promise<void>((resolve) => {
      openReadyGate.current = resolve;
    });
  }
  const readyGatePromise = readyGate.current;
  const isReadyRef = useRef(isReady);
  isReadyRef.current = isReady;

  /*
   * THE AGENT IS READ WHEN IT IS USED, NEVER CAPTURED BEFORE A WAIT. `useAgent` hands back a
   * provisional agent until the proxied one is registered, and a different object afterwards. The
   * stale one still runs and still reaches the thread, so the answer is stored and shows up on the
   * next reload while the rendered agent sits empty. `say` waits, so it spans that swap.
   */
  const agentRef = useRef(agent);
  agentRef.current = agent;

  /**
   * History has been asked for and has not arrived. True for a channel opened from the roster, where
   * an empty transcript is also a real answer; false for one started from the compose screen, which
   * already has the message that started it.
   */
  const [restoring, setRestoring] = useState(seed === null);
  /**
   * How many stored turns this app could not read.
   *
   * Held rather than derived, because the transcript is the running agent's once history is handed
   * over: `agent.messages` is what was restored, and what was dropped on the way in is not
   * recoverable from it.
   */
  const [unreadable, setUnreadable] = useState(0);
  const [historyAvailability, setHistoryAvailability] = useState<
    "ready" | "unavailable"
  >("ready");
  const [historyReadFailed, setHistoryReadFailed] = useState(false);
  // Mount reads and Bot refreshes share one ordering: only the newest read owns the notice.
  const historyReadVersion = useRef(0);
  // One history read per thread, shared across this mount's re-runs.
  // `useAgent` hands back a provisional agent until the proxied one registers
  // (and StrictMode mounts twice), and the activity watcher below pulls on
  // roster updates: without sharing, one open meant several concurrent full
  // downloads that raced the deadline and read as chats that never load. A
  // settled read leaves the map so a later activity refresh can ask for new
  // durable messages.
  const historyReadsRef = useRef(
    new Map<string, Promise<Awaited<ReturnType<typeof readThreadMessages>>>>(),
  );
  const readHistoryShared = useCallback(
    (threadId: string) => {
      const shared = historyReadsRef.current.get(threadId);
      if (shared) return shared;
      const started = readThreadMessages(threadId, runtimeAgentId);
      historyReadsRef.current.set(threadId, started);
      started.then(
        () => {
          if (historyReadsRef.current.get(threadId) === started) {
            historyReadsRef.current.delete(threadId);
          }
        },
        () => {
          if (historyReadsRef.current.get(threadId) === started) {
            historyReadsRef.current.delete(threadId);
          }
        },
      );
      return started;
    },
    [runtimeAgentId],
  );
  useEffect(() => {
    if (isReady) openReadyGate.current();
  }, [isReady]);

  // Join the gateway socket, restore durable history, then release the first-message gate.
  useEffect(() => {
    if (!isReady) return;
    let current = true;
    const version = ++historyReadVersion.current;

    void (async () => {
      /*
       * The history read starts BESIDE the join, not after it. It used to
       * wait for the socket join (up to 1.5s of its own deadline) before the
       * history fetch even began, so a heavy thread spent half its 2.5s
       * budget before the first byte — and every open lost the race and read
       * as chats that never load. The two disagree about nothing: the join
       * orders the live run, the read restores the past.
       */
      const history = readHistoryShared(channel.threadId);
      try {
        // Bounded, and finished when it returns; `join-thread.ts` has why that matters.
        await joinWithin({
          connect: copilotkit.connectAgent({ agent }),
          deadline: afterMs(JOIN_DEADLINE_MS),
          detach: () => agent.detachActiveRun(),
          /*
           * NOT DETACHED FROM A THREAD THAT IS STILL WORKING.
           *
           * The deadline exists so a connect left over from a channel at rest cannot replace this
           * agent's messages on the next run. It is a reasonable assumption until the thread turns out
           * not to be at rest — and a conversation this person walked away from and came back to is
           * exactly that: their run never stopped, because leaving a conversation does not abort it, so
           * `connect` has just reattached to a live run and the events arriving on it are the answer they
           * came back for.
           *
           * Detaching at the deadline severed that ~1.5s in, and `agent.isRunning` went false as it did,
           * so the Stop button flashed and disappeared — the same symptom as never having drawn it,
           * arriving by the other route.
           *
           * BOTH terms, because neither is sufficient alone at this instant. `agent.isRunning` is what
           * the reattach just established, but only once the connect has had a moment to deliver
           * something; `serverRunningRef` may not have resolved yet, since the poll and this join start
           * together. Whichever lands first is enough, and asking only one of them reintroduces the bug
           * for the other's latency.
           */
          keepAttached: () => agent.isRunning || serverRunningRef.current,
        });
      } catch {
        /*
         * A join that throws is a join that is over. It must not take the gate with it: everything
         * typed afterwards waits on that gate, so a throw here would silence the conversation
         * rather than degrade it. History is restored below either way.
         */
      }

      try {
        // Awaited here, started beside the join above: the full 2.5s budget
        // belongs to the read, not to whatever the socket was doing.
        const stored = await history;
        const isCurrent = current && version === historyReadVersion.current;
        if (isCurrent) {
          // The gateway snapshot can lag the store. Keep its valid local rows even when the
          // corresponding stored row is unreadable, while restoring other readable additions.
          const messages = mergeStoredMessages(agent.messages, stored.messages);
          if (messages !== agent.messages) agent.setMessages(messages);
        }
        /*
         * Said on screen rather than only counted. A turn the history store holds and this app cannot
         * parse is left out of the transcript, and a record people read back must not have a hole in
         * it that nothing accounts for. Set even when nothing was restored: a thread whose every turn
         * is unreadable is exactly the case where silence would read as "this conversation is empty".
         */
        if (isCurrent) {
          setUnreadable(stored.unreadable);
          setHistoryAvailability(stored.availability);
          // A gateway snapshot may be partial; neither it nor a later send proves this read succeeded.
          setHistoryReadFailed(stored.availability === "unavailable");
        }
      } finally {
        // Cleared on failure too: placeholders over an empty transcript promise messages that are
        // never coming.
        if (current) setRestoring(false);
        // Release even on join/restore failure; the gate orders messages, not withholds them.
        openJoinGate.current();
      }
    })();

    return () => {
      current = false;
    };
  }, [copilotkit, agent, isReady, channel.threadId, readHistoryShared]);

  /*
   * A turn nobody here streamed, surfaced while the channel is open.
   *
   * A relayed handoff answer runs on the server and lands in this thread with no browser attached.
   * The roster hears about it — the activity socket patches the channel-list cache — but this
   * transcript restores history once, on mount, and would show the new turn only after leaving and
   * coming back. So it watches that same cache: when this channel's `lastMessageAt` advances to a
   * moment a Bot authored, the durable history is read again. Riding the roster's own cache rather
   * than a second subscription means "the sidebar updated" and "the transcript refreshes" are the
   * one signal, and cannot drift apart.
   *
   * The same merge as mount places a recovered durable prefix before its shared local anchors,
   * preserving current content and local-only messages in both the transcript and the next run.
   *
   * Retried briefly, because the roster is patched when the turn is on record with the runner and
   * the platform's read of the thread can be a beat behind it.
   */
  useEffect(() => {
    const authoredActivity = (): ChannelActivitySignature | null => {
      const cache = queryClient.getQueryData<{
        pages: { channels: ChannelSummary[] }[];
      }>(channelKeys.list());
      const summary = cache?.pages
        .flatMap((page) => page.channels)
        .find((row) => row.id === channel.id);
      // Only a Bot's turn is news here; a person's own line arrives through the run that sent it.
      if (
        !summary ||
        summary.lastMessageAgentId === null ||
        summary.lastMessageAt === null ||
        summary.lastMessage === null
      ) {
        return null;
      }
      return {
        agentId: summary.lastMessageAgentId,
        at: summary.lastMessageAt,
        text: summary.lastMessage,
      };
    };

    const initialActivity = authoredActivity();
    let lastSeen = initialActivity;
    let cancelled = false;

    const pull = () => {
      const version = ++historyReadVersion.current;
      const isCurrent = () =>
        !cancelled && version === historyReadVersion.current;
      void (async () => {
        let sawReady = false;
        for (const delayMs of [0, 750, 1500]) {
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          if (!isCurrent()) return;
          const stored = await readThreadMessages(
            channel.threadId,
            runtimeAgentId,
          );
          if (!isCurrent()) return;
          if (stored.availability === "unavailable") {
            // Only an exhausted refresh with no successful read is a failure to announce. Keep the
            // last known ready notice when the store already answered this refresh cycle.
            if (delayMs === 1500 && !sawReady) {
              setHistoryAvailability("unavailable");
              setHistoryReadFailed(true);
            }
            continue;
          }
          sawReady = true;
          // A ready read owns the notice even when every readable id is already on screen.
          setUnreadable(stored.unreadable);
          setHistoryAvailability("ready");
          setHistoryReadFailed(false);
          const current = agentRef.current;
          const messages = mergeStoredMessages(
            current.messages,
            stored.messages,
          );
          if (messages === current.messages) continue;
          current.setMessages(messages);
          return;
        }
      })();
    };

    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      const activity = authoredActivity();
      if (activity && !sameActivity(activity, lastSeen)) {
        lastSeen = activity;
        if (sameActivity(selfReportedBotActivity.current, activity)) return;
        pull();
      }
    });
    void (async () => {
      await joinGatePromise;
      if (
        !cancelled &&
        initialActivity &&
        !sameActivity(selfReportedBotActivity.current, initialActivity)
      ) {
        pull();
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [channel.id, channel.threadId, joinGatePromise, runtimeAgentId]);

  // Tool calls from this conversation act on this coworker's own computer.
  useActiveBot(runtimeAgentId);

  /*
   * The whole `/` surface for this Bot: its skills, its components and its repositories. The send
   * path resolves chips against this same list rather than a second query, so what a chip stands
   * for cannot go missing between the menu being drawn and the message being sent.
   */
  const composerCommands = useComposerCommands(runtimeAgentId);
  const commands = composerCommands.commands;
  const historyNotice = channelHistoryNotice({
    restoring,
    messageCount: agent.messages.length,
    lastMessageAt: channel.lastMessageAt,
    historyAvailability,
    historyReadFailed,
    unreadable,
  });

  // Run failures arrive as events and are reported only for turns started in this mount.
  const [runError, setRunError] = useState<string | null>(null);
  const awaitingReply = useRef(false);
  /**
   * WHY THIS TURN ENDED WITHOUT AN ANSWER, KEPT WHERE `deliver` CAN STILL SEE IT — because the one
   * thing that knows is a subscriber, and the one thing that has to act on it is an `await`.
   *
   * `copilotkit.runAgent` DOES NOT REJECT ON A FAILED RUN. `CopilotKitCore.runAgent` catches
   * everything the agent throws, reports it through `emitError` as `AGENT_RUN_FAILED`, and returns
   * `{ result: undefined, newMessages: [] }` — a value indistinguishable from a run that finished
   * with nothing to say. So a gateway 503, a stream that dies, a model that refuses the request:
   * every one of them arrived here as a resolved promise, and `say` reported success for a turn
   * that never reached the server.
   *
   * WHAT THAT COST, WHICH IS THE REASON THIS EXISTS. `say` resolving is what every caller reads as
   * "it went". The composer clears the box and gives up the chips it was riding; the queue empties
   * into a draft nothing retries; `conversation-view.tsx` never runs either of the failure paths it
   * has written for exactly this. The person is left with the failed turn in the transcript and a
   * notice under it, the words unretryable, and the files behind them staged rows that nothing on
   * any screen points at any more. The notice is honest and everything under it was not.
   *
   * READ OFF THE SAME `fail` THE NOTICE IS, and deliberately not from a second subscription of its
   * own. `fail` already answers the one question a separate subscriber would get wrong: a turn the
   * PERSON stopped also reaches `onRunFailed`, with an abort, and `onStop` clears `awaitingReply`
   * before it — so Stop is not a failure here and nothing restores a draft somebody chose to end.
   *
   * ONE SLOT FOR ONE TURN AT A TIME, the same assumption `awaitingReply` beside it already makes.
   * Two overlapping turns — a component button pressed during a composer send — would have the
   * second clear the first's reason, which reports the earlier turn as successful. That is the
   * pre-existing shape of `awaitingReply`, not a new one, and narrowing it means giving a run a
   * handle that `copilotkit.runAgent` does not hand back.
   */
  const turnFailure = useRef<string | null>(null);
  const assistantMessagesBeforeRun = useRef<Set<string>>(new Set());

  /*
   * TWO DIFFERENT FACTS ABOUT ONE TURN, AND NEITHER OF THEM IS `agent.isRunning`.
   *
   * `turnsInFlight` counts what a person would call the Bot having the turn: from the moment `say`
   * is entered until the whole thing has come back, browser actions in the middle included. It is
   * what decides whether the next thing typed is sent or parked, and what tells the queue its wait
   * is over.
   *
   * `runsInFlight` counts what Stop can actually reach: the run `copilotkit.runAgent` opens, and
   * nothing before it. A turn can be in flight for a second and a half before that, while `say`
   * waits for the runtime agent, and a Stop drawn in that window aborts a controller nobody has
   * made yet.
   *
   * Both are read from the tab-wide store rather than a local `useState` — they belong to the
   * conversation, and the conversation outlives this mount. `lib/copilot/live-runs.ts` has the full
   * note on why: a fresh mount starts this screen's facts at zero, which is the bug this whole
   * indirection exists to stop.
   *
   * `agent.isRunning` looks like both and is neither. It reports the run on the wire, and a turn
   * that is offered a frontend decision is several runs in a row: the Bot asks, the run ENDS so
   * the browser can answer, and another run starts carrying the answer. The agent reports itself
   * idle in every one of those gaps — the truth about the wire and a lie about the turn.
   * Computer actions are server tools now (`server/src/computer/desktop-tools.ts`); the tools that
   * genuinely split a turn in two are the gallery and decision tools the browser renders.
   *
   * Counters rather than booleans because nothing stops a second turn being started from a
   * component button while the first is still going, and two overlapping turns must not have the
   * first one to finish declare the conversation idle.
   */
  const live = useLiveRun(channel.id);
  const turnsInFlight = live.turns;
  const runsInFlight = live.runs;

  /*
   * WHETHER THIS SCREEN IS STILL THERE.
   *
   * The one thing a `finally` after unmount must not do is tell the roster that work has stopped, because
   * the work has not. Leaving a conversation does not abort its run — nothing here calls `abortRun` on
   * unmount, deliberately, since closing a tab is not a request to stop working — so `say`'s cleanup runs
   * long after this component is gone and posts `busy: false` for a run that is still going. The roster
   * then shows an idle conversation whose transcript is about to grow an answer nobody is watching, and
   * coming back shows a conversation with no Working line and no Stop button on a thread that is busy.
   *
   * The live counters survive unmount — they live in the tab-wide store now — but the question this
   * flag answers is a different one: is there still a SCREEN here that has any business announcing
   * anything? It is what stops a `finally`, long after the person left the conversation, from telling
   * the roster that a turn it is still finishing has ended.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /*
   * THE LAST LIVE TRANSCRIPT, KEPT FOR THE RETURN TRIP.
   *
   * `agent.messages` is owned by this mount's `useAgent` and is discarded with it. The store is
   * where a conversation's outline survives leaving it, so every change to the live transcript is
   * mirrored there, and a returning screen can paint it before history or connect catches up.
   */
  useEffect(() => {
    const subscription = agent.subscribe?.({
      onMessagesChanged: ({ messages }) => {
        patchLiveRun(channel.id, { messages });
      },
    });
    return () => subscription?.unsubscribe();
  }, [agent, channel.id]);

  /*
   * WHAT THE SERVER SAYS IS HAPPENING IN THIS CONVERSATION, which is not the same question as what this
   * screen has streamed.
   *
   * Everything above is per-mount and therefore zero on arrival: `agent.isRunning` belongs to a `useAgent`
   * instance registered on mount, and both counters are `useState`. So a person who starts a long task,
   * goes to another conversation and comes back lands on a screen that is certain nothing is running,
   * holding no Stop button, while their run is still going on the server.
   *
   * This is the read that closes that gap, and it feeds the two things a person can act on:
   *
   *  - `stoppable`, so the Stop button is offered for a run that really exists. Stop is thread-scoped, so
   *    it reaches the server's run from a mount that never started it — the button appearing here works.
   *  - `pending`, so the next thing typed is parked rather than sent into a thread the runner will
   *    refuse. Sending is survivable now that the runner supersedes, but it silently discards whatever
   *    the orphaned run had already done; parking does not.
   *
   * It is deliberately NOT OR-ed into `pending` in a way that could strand the composer: the poll only
   * runs while something is live, so the one thing this can get wrong is being briefly true about a run
   * that just ended, and `runsInFlight`/`turnsInFlight` take over the instant a local run is involved.
   */
  const { data: serverActivity } = useQuery(
    channelRunningQueryOptions(channel.id),
  );
  /** Whether a run the server can still be asked about is going. See the query's own note. */
  const serverRunning = serverActivity !== null && serverActivity !== undefined;
  /*
   * The same fact, in a ref, for the join below.
   *
   * A ref because the join effect must not depend on the poll: adding `serverRunning` to its dependency
   * array would tear the join down and re-run it every four seconds for as long as a run is live, and
   * each re-run replaces the agent's messages — losing whatever was added in between. The join is a
   * one-shot on mount and reads this at the one moment it needs the answer.
   */
  const serverRunningRef = useRef(serverRunning);
  serverRunningRef.current = serverRunning;

  /**
   * Tell the roster what was just said. Failures here must not block the conversation.
   */
  const recordActivity = useMutation(recordChannelActivityMutationOptions());
  const selfReportedBotActivity = useRef<ChannelActivitySignature | null>(null);

  const report = (text: string, agentId: string | null) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const at = new Date().toISOString();
    if (agentId !== null) {
      selfReportedBotActivity.current = { agentId, at, text: trimmed };
    }
    recordActivity.mutate({
      agentId,
      at,
      channelId: channel.id,
      text: trimmed,
    });
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  /**
   * Everything `say` does once it has something worth sending, split out so the counter it is
   * wrapped in covers every way out of here, a throw included.
   */
  const deliver = async (
    trimmed: string,
    instructions: string[],
    attachments: Attachment[],
  ) => {
    // Wait briefly for the runtime agent instance before adding the message.
    if (!isReadyRef.current) {
      await Promise.race([
        readyGatePromise,
        afterMs(SEND_WITHOUT_RUNTIME_AFTER_MS),
      ]);
    }

    /*
     * EVERY TURN WAITS FOR THE JOIN, not just the first of a new channel: a message added while the
     * connect is in flight is erased by it either way. Unbounded only in appearance — the join
     * effect bounds itself and opens this gate from a `finally`. If that effect never ran there is
     * no runtime agent, and no connect in flight to wait on.
     */
    if (isReadyRef.current) {
      await joinGatePromise;
    }

    // Every wait is behind us, so this is the agent the screen is actually rendering. Read once and
    // used throughout, so the message, the repair and the run cannot land on two different agents.
    const target = agentRef.current;

    setRunError(null);
    turnFailure.current = null;
    assistantMessagesBeforeRun.current = new Set(
      target.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.id),
    );
    awaitingReply.current = true;

    /*
     * THE SKILL GOES IN FRONT OF THE MESSAGE, AS A SYSTEM TURN. A `/` chip is one token in the
     * composer; what it stands for is the instruction added here, ahead of what the person typed, so
     * the Bot reads the job before the request.
     *
     * A system message rather than text prepended to theirs, because the two are not the same kind
     * of thing: the transcript should show what a person said, and pasting the skill into their
     * words puts sentences in their mouth and makes the reply quote instructions back at them.
     *
     * `transcriptMessages` draws user and assistant turns, so this never appears on screen — the
     * chip is what says a skill was used, and it stays visible in the message they sent.
     */
    for (const instruction of instructions) {
      target.addMessage({
        content: instruction,
        id: newId(),
        role: "system",
      });
    }

    target.addMessage({
      content: toMessageContent(trimmed, attachments),
      id: newId(),
      role: "user",
    });
    report(trimmed || describeAttachments(attachments), null);

    // Providers reject later turns if prior tool calls have no result; repair before sending.
    const repaired = repairUnansweredToolCalls(target.messages);
    if (repaired !== target.messages) {
      target.setMessages(repaired as typeof target.messages);
    }

    bumpRun(channel.id, 1);
    try {
      await copilotkit.runAgent({ agent: target });
    } finally {
      bumpRun(channel.id, -1);
    }

    /*
     * A TURN THAT DID NOT HAPPEN FAILS THE SEND, which is the only way anything upstream can tell.
     * See `turnFailure` for why the resolved promise above says nothing about that.
     *
     * AFTER the `finally`, not inside the `try`: the run is over either way, so the counter that
     * draws the Stop button must come down before this throws. Throwing from inside would leave
     * `runsInFlight` high for a run that has already ended.
     *
     * WHAT THE THROW REACHES, so it is clear this is a message and not a crash. The composer's
     * `catch` puts the words and the chips back; `conversation-view.tsx` puts a drained queue back
     * as retryable entries carrying their files. Nothing here reports the failure — `runError` was
     * already set from the same `fail` that set this, and the transcript already draws it — so this
     * adds a retry, not a second sentence.
     *
     * THE MESSAGE STAYS ON SCREEN. `deliver` added it above and nothing takes it away: it is what
     * the failed turn WAS, it is what the notice under it is about, and removing it would delete a
     * partial answer that a mid-stream failure had already produced. The restored draft beside it
     * is the retry, the same way a failed composer send has always put its words back while the
     * transcript kept the turn.
     */
    if (turnFailure.current !== null) {
      throw new Error(turnFailure.current);
    }
  };

  /**
   * Send a user turn through the channel, including activity reporting and history repair.
   *
   * Every user turn in this channel goes through here — what the composer sends, the seed from the
   * compose screen, and a button inside a rendered component. That is what makes the counter worth
   * keeping here rather than in the view: the view sees only the turns it started itself, and a
   * queue that drains on the wrong one of those posts a correction into the middle of an answer.
   */
  const say = async (
    text: string,
    instructions: string[] = [],
    attachments: Attachment[] = [],
  ) => {
    const trimmed = text.trim();
    // A pasted screenshot with no caption is still a message to send: `canSendDraft` already
    // unlocks the button for exactly this case, so refusing it here would leave the button
    // enabled and inert.
    if (!trimmed && attachments.length === 0) return;

    bumpTurn(channel.id, 1);
    if (liveRun(channel.id).turns === 1) {
      void setChannelBusy({ channelId: channel.id, busy: true });
    }
    try {
      await deliver(trimmed, instructions, attachments);
    } finally {
      bumpTurn(channel.id, -1);
      /*
       * ONLY WHILE THIS SCREEN IS STILL HERE, and this is the point of `mountedRef`.
       *
       * The turn does not end when the browser stops watching it. Leaving a conversation does not abort
       * its run, so this `finally` runs for a run that is still going on the server — and posting
       * `busy: false` for it tells the roster this conversation is idle. The roster is what the sidebar
       * draws and what this same file's `activity` comes from, so the consequence is not a stale dot in
       * one list: coming back shows a conversation with no Working line and no Stop button, on a thread
       * that is busy, and the next message goes into a run nobody can see.
       *
       * The counter itself is still decremented above, unconditionally, because that count is what
       * stays correct across unmount and a count that leaked would be wrong on the next mount. Only
       * the announcement is suppressed — there is no longer a screen here that has any business
       * making one.
       */
      if (liveRun(channel.id).turns === 0 && mountedRef.current) {
        void setChannelBusy({ channelId: channel.id, busy: false });
      }
    }
  };

  useEffect(() => {
    const fail = (message: string) => {
      if (!awaitingReply.current) return;
      awaitingReply.current = false;
      // Both halves of one fact: the sentence the transcript shows, and the reason `deliver` throws
      // so the draft behind the turn is restored rather than counted as sent. See `turnFailure`.
      turnFailure.current = message;
      setRunError(message);
    };
    const subscription = agent.subscribe?.({
      // Both surfaces fall back to the same sentence, from the same place, so a person who uses
      // both is not told two different things about the same silence.
      onRunErrorEvent: ({ event }) => fail(stoppedReason(event?.message)),
      onRunFailed: ({ error }) => fail(stoppedReason(error)),
      onRunFinishedEvent: ({ event }) => {
        const wasOurs = awaitingReply.current;
        awaitingReply.current = false;
        if (!wasOurs) return;

        /*
         * A FINISH IS NOT ALWAYS AN ANSWER.
         *
         * `RUN_FINISHED` is what a completed run ends with, and it is also what an aborted one used
         * to end with — the server emitted it bare, with no reason, on every abort. So this handler
         * cannot assume the turn produced something: it can assume the run stopped.
         *
         * Two ways it can stop without an answer, and both leave the same hole. A channel deadline
         * (see `RunBuiltAgent` in server/src/copilot.ts) and the loop breaker's tool-call cap
         * (server/src/billing/metering.ts) both end a turn partway through a task. Both now carry a
         * sentence, and `onRunErrorEvent` above reports it. What is left here is a finish with
         * neither an explanation nor an answer, which would clear the Working indicator and report
         * success for a turn that never had one — so it is reported for what it is.
         *
         * AND A RUN THAT DID ANSWER IS STILL REPORTED WHEN THE SERVER SAYS IT ENDED EARLY. It used
         * to return early on any text at all, on the reasoning that a truncated turn still deserves
         * to show the partial answer it managed to produce — which it does, and which is not a
         * reason to withhold the one sentence explaining why it stopped. A working model says "let me
         * check that" and is then killed at its hundredth tool call, so "said something" and
         * "finished" are not the same claim. `finishNeedsExplanation` is the shared rule, so this
         * surface and `/bot` cannot drift into telling people different things about one silence.
         */
        const reply = [...agent.messages]
          .reverse()
          .find(
            (message) =>
              message.role === "assistant" &&
              !assistantMessagesBeforeRun.current.has(message.id),
          );
        const content = typeof reply?.content === "string" ? reply.content : "";
        if (content) {
          reportRef.current(content, runtimeAgentId);
        }

        const stated =
          typeof event?.message === "string" ? event.message.trim() : "";
        const notice =
          stated || "This turn ended before the Bot finished answering.";

        /*
         * A TURN THAT ANSWERED IS REPORTED, NOT FAILED, however it ended.
         *
         * These are two different claims and `fail` used to make both at once. The notice is what a
         * person reads under the transcript; the throw is what puts their words back in the box and
         * the parked message back in the queue, because the send did not happen. A turn cut short
         * AFTER answering did happen — the answer is on screen and in the roster — so restoring a
         * draft would ask them to send the same thing twice and read as though nothing had been
         * said. Only a turn with nothing to show for itself is a send that did not happen.
         */
        if (content) {
          if (finishNeedsExplanation(event, true)) setRunError(notice);
          return;
        }
        fail(notice);
      },
    });
    return () => subscription?.unsubscribe();
  }, [agent, runtimeAgentId]);

  /** Stable reference for effects and component callbacks. */
  const sayRef = useRef(say);
  sayRef.current = say;

  /**
   * Component buttons speak as user turns without forcing every transcript card to re-render.
   *
   * The rejection is swallowed HERE rather than left to the void, and that is not a style choice:
   * `say` throws on a failed turn now (see `turnFailure`), and a voided promise with nothing on the
   * end of it is an unhandled rejection — in this repository's test runner, a failure attributed to
   * whichever test happened to be running when it surfaced. There is nothing to restore for this
   * caller either way: the words came from a button inside a rendered card, not from a box somebody
   * is still holding, and the failed turn is already reported by `runError` under the transcript.
   */
  const askFromComponent = useCallback((text: string) => {
    void sayRef.current(text).catch(() => undefined);
  }, []);

  /**
   * Send the create-channel seed once. No waiting of its own: `say` owns that for every turn, and a
   * second copy of the ordering here was the one that could disagree with it.
   */
  useEffect(() => {
    const pending = seedRef.current;
    if (!pending) return;
    seedRef.current = null;

    // Swallowed for the reason `askFromComponent` above records: `say` throws on a failed turn, and
    // the seed has no box to go back into — it was typed on a screen that has already navigated
    // away. The transcript keeps the seeded message and the notice under it says what happened.
    void sayRef
      .current(
        typeof pending.content === "string" ? pending.content : "",
        seedInstructionsRef.current,
      )
      .catch(() => undefined);

    // Keep `seed` in state; transcriptMessages gives it up once the agent holds a user turn.
  }, []);

  return (
    // Activity renderers resolve their agent through this SDK context. It must match useAgent's
    // channel instance so an action continues this thread instead of looking for a default agent.
    <CopilotChatConfigurationProvider
      agentId={channelAgentId}
      threadId={channel.threadId}
    >
      <ConversationProvider ask={askFromComponent}>
        <ConversationView
          agents={toAgentOptions(agentProfiles, channel.agentIds)}
          channelId={channel.id}
          /*
           * THE TURN, not the run. `say` waits for the runtime agent and the join before a run starts,
           * and `agent.isRunning` alone leaves that gap unmarked — which is the one moment the
           * "Thinking" line exists for. Same value as `pending`, deliberately.
           */
          activity={activity ?? serverActivity ?? null}
          busy={agent.isRunning || turnsInFlight > 0 || serverRunning}
          // Skills granted to this Bot, its components, and its repositories.
          commands={commands}
          // Lets the `/components` and `/repo` pickers drop a chip into the draft.
          editorRef={composerCommands.editorRef}
          // Readiness is handled by `say`; deletion is the only disabled-chat state.
          disabled={!channel.active}
          /*
           * THE AGENT'S TRANSCRIPT ONCE IT HOLDS ONE, THE STORE'S UNTIL THEN.
           *
           * A fresh mount renders nothing until connect and history restore catch up, which is
           * exactly the gap a person coming back to a conversation in the middle of its answer
           * should not have. The store is that mount's only other view of this thread, so it wins
           * the while agent.messages is empty. The rows key on ids, and history merge dedupes on
           * the same ids, so the swap from store to agent is a continuation, not a repaint.
           */
          messages={transcriptMessages(
            agent.messages.length > 0 ? agent.messages : live.messages,
            seed,
          )}
          notice={
            /*
             * Two things can be worth saying at once — a deleted coworker and a history with holes in
             * it — and they are independent, so neither is an `else` for the other.
             */
            <>
              {historyNotice ? (
                <p className="pb-2 text-sm text-muted-foreground" role="status">
                  {historyNotice}
                </p>
              ) : null}
              {channel.active ? null : (
                <p className="pb-2 text-sm text-muted-foreground" role="status">
                  This coworker has been deleted. The conversation stays
                  readable, but it can no longer reply.
                </p>
              )}
            </>
          }
          onSubmit={async (draft) => {
            // `draft.agentId` carries the @mentioned coworker, but nothing routes on it yet: this
            // channel is pinned to one `runtimeAgentId` for the life of its thread, so honouring a
            // per-message mention is a change to that binding, not to the composer.
            //
            // `commandIds` are the `/` chips that survived into the send, in the order they were
            // typed. Resolved against the same list the menu was built from, so a chip left over from
            // a skill that has since been revoked resolves to nothing rather than to a stale
            // instruction — the menu is refetched, and this reads from it.
            const instructions = draft.commandIds
              .map(
                (id) => commands.find((command) => command.id === id)?.prompt,
              )
              .filter((instruction): instruction is string =>
                Boolean(instruction),
              );

            await say(draft.text, instructions, draft.attachments);
          }}
          /**
           * Stop through the core so the abort signal reaches frontend tools; `say` repairs any
           * unanswered tool call before the next turn.
           */
          onStop={() => {
            awaitingReply.current = false;
            /*
             * INVALIDATE FIRST, THEN STOP.
             *
             * The order is load-bearing and it was the other way round. `stopAgent` reaches the SDK's
             * `abortRun`, which builds its URL and can THROW synchronously — with no runtime URL
             * configured, or under a DOM whose `URL` rejects the base. Everything after it in this handler
             * is then skipped, so putting the invalidation second meant that on exactly the failure this
             * handler exists to recover from — stopping a run — the screen was never re-read, and the
             * Stop button stayed on screen for a run that had just been asked to end.
             *
             * Asking first is also more correct on the merits. The invalidation does not depend on the
             * stop having been delivered: it re-reads what the server says, and the server is the only
             * thing that knows whether the run is still going. Whether the request then succeeds is
             * expressed by what the re-read returns, not by skipping it.
             *
             * Invalidated rather than set to null, and for the same reason: overwriting the answer would
             * assert that the run stopped the instant the request left. It may not have, and a
             * conversation that believes it is idle while the Bot works is the bug this all exists to fix.
             * Re-reading asks.
             */
            void queryClient.invalidateQueries({
              queryKey: channelKeys.running(channel.id),
            });
            /*
             * AND THE STOP ITSELF MUST NOT BE ABLE TO BREAK THIS SCREEN.
             *
             * `stopAgent` is the SDK's, and it can throw synchronously before it sends anything —
             * `abortRun` builds a URL from the runtime base, which is not configured in every context and
             * is rejected outright by some DOMs. An exception here does not just fail the stop: it
             * propagates out of a React event handler, so the person pressing Stop gets an error boundary
             * over the conversation they were trying to interrupt.
             *
             * Reported, not swallowed. A stop that did not happen is a real failure the person should be
             * able to see, and `runError` is where the transcript already says what ended a turn — so the
             * screen says the press did not reach the Bot and keeps working, rather than either pretending
             * it stopped or falling over.
             */
            try {
              copilotkit.stopAgent({ agent });
            } catch (error) {
              setRunError(
                error instanceof Error
                  ? `The stop could not be sent: ${error.message}`
                  : "The stop could not be sent.",
              );
            }
          }}
          /*
           * The turn, not the run. A browser action ends one run and starts another, and telling the
           * conversation it is idle in between is what would drain a parked correction into the
           * middle of an answer: a second turn racing the first on one thread, with a fabricated
           * result stitched over a tool call that is still executing.
           *
           * `serverRunning` is OR-ed in because the local facts are per-mount and a conversation this
           * person walked away from and came back to has none. Without it, a run still going on the
           * server is invisible to the composer: the next thing typed is sent into a thread the runner
           * refuses, and — because that refusal reaches the browser as an empty 200 that reads as
           * success — the message is swallowed with no reply and no error. Parking it instead costs one
           * turn of latency and discards nothing.
           */
          pending={agent.isRunning || turnsInFlight > 0 || serverRunning}
          /*
           * A channel outlives its turns, so it is the screen where waiting is worth offering. A
           * correction typed mid-answer is held here, in this tab, and runs as one follow-up turn the
           * moment this one is over — including when it is over because somebody pressed the button
           * above.
           */
          queueWhileBusy
          restoring={restoring}
          /*
           * The run, not the turn. Stop reaches a run through the core's abort controller, and that
           * controller does not exist until `say` has finished waiting for the runtime agent — so
           * this is the one place the narrower fact is the honest one to draw a button from.
           *
           * WITH THE SERVER'S ANSWER, and this is the fix for a Stop button that vanishes when you
           * navigate back. Both local terms are per-mount and zero on arrival, so a conversation with a
           * live run on it drew Send — with nothing to stop it and, worse, a next message silently
           * swallowed. Stop is addressed by THREAD (`/agent/:id/stop/:threadId`) and takes no run id, so
           * a mount that never started the run can still end it: `agent` is registered by the time this
           * button can be pressed, and it carries this channel's thread id.
           */
          stoppable={agent.isRunning || runsInFlight > 0 || serverRunning}
          /*
           * At the END OF THE TRANSCRIPT rather than above the composer, which is where this used to
           * be. A turn that ends without an answer leaves a gap exactly where the reply was going to
           * appear, and the person is already looking at it; an explanation in the composer area is a
           * different part of the screen from the thing it explains.
           *
           * `runError` carries whatever ended the turn, in that thing's own words. A Bot that stopped
           * streaming says so, because the deployment's stall watchdog writes that sentence into the
           * run before closing it; see server/src/channels/stall-guard.ts.
           */
          stopped={runError ?? undefined}
        />
        {/*
         * The `/components` and `/repo` pickers, which insert a chip and are otherwise invisible.
         * A Dialog rather than a panel inside the composer because the pick is chosen from artwork,
         * and artwork needs room the composer's two hundred pixels do not have.
         */}
        <ComponentCommandPicker
          agentId={runtimeAgentId}
          onOpenChange={(next) => {
            if (!next) composerCommands.closePicker();
          }}
          onPick={composerCommands.insert}
          open={composerCommands.picker === "components"}
        />
        <RepoCommandPicker
          agentId={runtimeAgentId}
          onOpenChange={(next) => {
            if (!next) composerCommands.closePicker();
          }}
          onPick={composerCommands.insert}
          open={composerCommands.picker === "repo"}
        />
      </ConversationProvider>
    </CopilotChatConfigurationProvider>
  );
}
