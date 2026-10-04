import type { Message } from "@ag-ui/core";
import { useSyncExternalStore } from "react";
import type { QueuedMessage } from "@/components/channels/composer/queue";

/**
 * What stayed behind when the conversation screen unmounted.
 *
 * Every piece of run state inside `ChannelChat` used to be a `useState` or ref created at mount,
 * so leaving a conversation mid-work reset it to zero: no Working line, no Stop button, no parked
 * messages, no snapshot of the answer that is still streaming on the server. The server keeps
 * working — leaving never aborts a run — but the only thing a returning screen could see of it was
 * a four-second poll that says "running", which is true and nearly useless.
 *
 * This store lifts the parts a return trip needs OUT of the route, so a conversation this browser
 * has touched keeps its shape between visits: the parked corrections the person typed, whether a
 * turn in flight was started by this browser, and the last live transcript it drew. It is memory in
 * the tab, like the computer activity pane — it is a view of what this browser knows, not a
 * transcript, which is why it is not persisted.
 */

export type LiveRun = {
  /** What a person would call the Bot having the turn. See channel-chat for why this is a counter. */
  turns: number;
  /** The run `copilotkit.runAgent` opens, and nothing before it. */
  runs: number;
  /** Corrections typed mid-turn, which survive a visit elsewhere because they still have files behind them. */
  queued: readonly QueuedMessage[];
  /** The last live transcript this browser drew for the channel. */
  messages: readonly Message[];
};

const EMPTY: LiveRun = { turns: 0, runs: 0, queued: [], messages: [] };

const byChannel = new Map<string, LiveRun>();
const listeners = new Set<() => void>();

export function liveRun(channelId: string): LiveRun {
  return byChannel.get(channelId) ?? EMPTY;
}

/** One keyspace per channel; two channels running at once read disjoint halves of the map. */
export function patchLiveRun(channelId: string, patch: Partial<LiveRun>): void {
  const current = byChannel.get(channelId) ?? EMPTY;
  byChannel.set(channelId, { ...current, ...patch });
  for (const listener of listeners) listener();
}

export function bumpTurn(channelId: string, delta: 1 | -1): void {
  const current = byChannel.get(channelId) ?? EMPTY;
  patchLiveRun(channelId, { turns: current.turns + delta });
}

export function bumpRun(channelId: string, delta: 1 | -1): void {
  const current = byChannel.get(channelId) ?? EMPTY;
  patchLiveRun(channelId, { runs: current.runs + delta });
}

export function useLiveRun(channelId: string): LiveRun {
  return useSyncExternalStore(
    subscribe,
    () => liveRun(channelId),
    () => EMPTY,
  );
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Forget one conversation entirely — its counters, its parked messages and its live transcript.
 *
 * For a channel that is gone: a deleted conversation has nothing to return to, and its parked rows
 * are released by the deletion itself rather than by anything left holding them.
 *
 * Also what makes this store testable. It is module state on purpose — that is the entire point of
 * it — and a test file that renders the same channel in two tests is looking at one conversation
 * from both, exactly as the browser would. Every test in such a file starts by forgetting the
 * channel it is about to open, which is the honest way to say "this is a conversation that has not
 * happened yet" rather than quietly asserting on whatever the previous test left behind.
 */
export function forgetLiveRun(channelId: string): void {
  if (!byChannel.has(channelId)) return;
  byChannel.delete(channelId);
  for (const listener of listeners) listener();
}
