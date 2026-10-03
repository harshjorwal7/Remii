import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { MascotChoice } from "../../../../shared/mascot-ids";

/**
 * A channel as the browser sees it.
 *
 * `threadId` is what makes two channels with the same coworker independent conversations, and
 * `active` is false once a linked coworker has been deleted: the transcript stays readable, but
 * nothing more can be said in it.
 */
export type AgentChannel = {
  id: string;
  name: string;
  agentIds: string[];
  /**
   * The chosen mascot of each agent in this channel, by agent id.
   *
   * Present because a channel announces the agent and nothing else: without it a roster row or a
   * channel header would have to fetch every agent's profile just to draw a face, and would show a
   * different face from the profile screen whenever that fetch had not landed. An agent with no
   * chosen mascot is simply absent, and the client seeds from the id — which is why this is not
   * pre-filled with defaults.
   */
  mascots: Record<string, Partial<MascotChoice>>;
  threadId: string;
  active: boolean;
  /**
   * ISO-8601 when something was last said here, or null for a conversation nobody has used.
   *
   * The conversation screen needs this to tell two silences apart: a new conversation with no
   * history, and one whose history this deployment cannot reach. See `channel-chat.tsx`.
   */
  lastMessageAt: string | null;
};

/** A channel plus what the roster renders about it. */
export type ChannelSummary = AgentChannel & {
  /** A few words about the conversation, or null. The roster falls back to `name`. */
  summary: string | null;
  lastMessage: string | null;
  lastMessageAgentId: string | null;
  /** ISO-8601. Ordering falls back to this, so a channel just created sorts to the top. */
  createdAt: string;
  /** Whether this member pinned the channel. Pinned channels sort first in the roster. */
  pinned: boolean;
  /** ISO-8601 when this member last had the channel open, or null for never. The caller's, only. */
  lastReadAt: string | null;
  /**
   * Whether a turn is running in this channel right now.
   *
   * Socket-only and transient: the server never persists it and the roster query never returns it,
   * so it is undefined until a busy event arrives and is dropped whenever the roster is refetched.
   * A headless turn — a handoff hop, a relay — sets it, which is how the roster shows work the
   * browser never streamed.
   */
  busy?: boolean;
  /**
   * What is running in this channel right now, or null when nothing is.
   *
   * Persisted-server truth, unlike `busy` above: the server reduces every run in the channel to the
   * one that decides how the row looks, so this is a decision already made rather than something the
   * browser has to work out from a list. Null means idle, which is a fact and not an absence of
   * information.
   */
  activity?: ChannelActivityBrief | null;
};

/**
 * A run's state, as far as a roster row can act on it.
 *
 * Four fields and no run id on purpose: a row draws a mark and a word. The states are the server's
 * and are not renamable here, because the server is what ranks them.
 */
export type ChannelActivityBrief = {
  state:
    | "thinking"
    | "delegated"
    | "waiting_on_you"
    | "stopped"
    | "failed"
    | "done";
  /** "With Research Desk" — who or what the run is waiting on. */
  label: string | null;
  /** The failure, when the run broke. */
  detail: string | null;
  botId: string;
};

export const channelKeys = {
  all: ["channels"] as const,
  list: () => ["channels", "list"] as const,
  detail: (channelId: string) => ["channels", "detail", channelId] as const,
  running: (channelId: string) => ["channels", "running", channelId] as const,
};

/**
 * Whether a run is going in this conversation, for a screen that has just mounted.
 *
 * POLLED, AND NOT DERIVED FROM THE ROSTER SOCKET, because the socket is for surfaces that were already
 * open. A person who starts a long task, clicks into another conversation, and comes back has missed
 * every event since they left, so their roster cache has nothing about it — and every piece of run state
 * inside the conversation is per-mount and starts at zero (`useAgent` registers a fresh agent,
 * `turnsInFlight` and `runsInFlight` are `useState`). The screen is therefore certain the conversation
 * is idle at exactly the moment a run is still going.
 *
 * What that costs is the Stop button missing for as long as the run lasts. What it costs that nobody
 * sees is worse: the next message is refused by the runner, and the refusal reaches the browser as an
 * empty 200 that reads as success — so the message is swallowed with no reply, no error and no spinner,
 * repeatedly, until the orphaned run finally ends.
 *
 * A poll rather than a subscription because there is nothing to subscribe to: a run on a thread the
 * browser is not currently streaming announces itself over the runtime's own SSE, which is per-agent and
 * dies with the tab. One small read every few seconds, only while a conversation is open, is the honest
 * cost of asking a question this process genuinely cannot answer for itself.
 *
 * Only polled while something is running (see `refetchInterval` below): an idle conversation costs one
 * request on mount and then nothing, because there is no state change to notice.
 */
export function channelRunningQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.running(channelId),
    queryFn: async (): Promise<ChannelActivityBrief | null> => {
      /*
       * The envelope key IS `activity`, so `client` has already unwrapped the brief by the time this
       * returns. Reading `.activity` off it would be reading `.state` off a brief-shaped object and
       * getting `undefined` — which does not throw, and so reads as "nothing is running" on a thread
       * that is busy. That is the entire bug this query exists to fix, reproduced one layer down.
       *
       * `null` when the server answered `null`: the shape is honest about idle rather than inventing a
       * flag beside it.
       */
      return await client<ChannelActivityBrief | null>(
        `/api/channels/${channelId}/activity`,
        "activity",
        {
          fallback:
            "Could not check whether this conversation is still working",
        },
      );
    },
    /*
     * While something is running, every few seconds; once nothing is, never.
     *
     * The interval is a function of the last answer rather than a constant, because the two states have
     * different costs. A live run needs a poll to notice it ended — that is what takes the Working line
     * and the Stop button down. An idle conversation has no state change coming, so polling it is a
     * request per interval for the rest of the person's time on that screen, asking a question whose
     * answer they already have.
     *
     * `false` rather than `0`: the first is "do not refetch", the second is an interval of zero.
     */
    refetchInterval: (query) => (query.state.data ? RUNNING_POLL_MS : false),
  });
}

/**
 * How often a live conversation is asked whether it is still live.
 *
 * Four seconds, and the tradeoff is legibility against load. Too short and an idle-then-busy conversation
 * spends real time talking to the server; too long and a run that ends leaves a Stop button on screen
 * for four seconds after the answer arrived, which is long enough for somebody to press it and be told
 * there is nothing to stop. This is also the cadence at which a conversation that has just been left
 * stops believing it is idle, which is the bug being fixed.
 */
const RUNNING_POLL_MS = 4_000;

/** One page of channels, and where the next one starts. */
export type ChannelPage = {
  channels: ChannelSummary[];
  nextCursor: string | null;
};

/**
 * The sidebar's channels, a page at a time.
 *
 * It used to ask for every channel this person has, one row per channel-agent pair, on every render.
 * Nothing removes a channel, so somebody who talks to their Bot daily accumulates thousands and the
 * query grows monotonically for as long as they use the product.
 *
 * The pages are flattened for the caller, so the sidebar and the socket that patches it both see one
 * array in recency order and neither has to know this is paged.
 */
export function channelListQueryOptions() {
  return infiniteQueryOptions({
    queryKey: channelKeys.list(),
    initialPageParam: "",
    queryFn: async ({ pageParam }): Promise<ChannelPage> => {
      const suffix = pageParam
        ? `?cursor=${encodeURIComponent(pageParam as string)}`
        : "";
      const response = await client(`/api/channels${suffix}`, {
        fallback: "Could not load channels",
      });
      return (await response.json()) as ChannelPage;
    },
    getNextPageParam: (page: ChannelPage) => page.nextCursor ?? undefined,
    select: (data): ChannelSummary[] =>
      data.pages.flatMap((page) => page.channels),
  });
}

export function channelQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.detail(channelId),
    queryFn: async (): Promise<AgentChannel> => {
      return client(`/api/channels/${channelId}`, "channel", {
        fallback: "Could not load this channel",
      });
    },
  });
}
