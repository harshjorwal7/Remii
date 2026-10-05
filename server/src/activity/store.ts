import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { type RunActivityState, runActivity } from "../db/schema";

/**
 * What a Bot is doing, and what it handed to.
 *
 * ONE ROW PER RUN. A run moves through several states and this table says where it is, not how it
 * got there — see the note on the table in `db/schema/activity.ts`. Two consequences run through
 * everything below: a state change is an `update` of a row that already exists rather than an
 * `insert`, and a run that has never been seen is `upsert`ed rather than refused.
 *
 * THE LIVE VERSION IS NOT HERE. A reader wants two different things and this module serves both by
 * refusing to serve either badly. "What is working right now" is `open`, which is a partial-index
 * scan and answers in one round trip. "What did Remii do last Tuesday" is `chain`, which walks the
 * delegation edges. Between them they cover every question the roster and the transcript ask.
 */

export type RunActivity = {
  runId: string;
  actorUserId: string;
  botId: string;
  /** Null for a run with no conversation of its own, which is a scratch thread and not a defect. */
  channelId: string | null;
  threadId: string;
  parentRunId: string | null;
  state: RunActivityState;
  label: string | null;
  detail: string | null;
  startedAt: Date;
  endedAt: Date | null;
  error: string | null;
  transitions: number;
};

/** What a run is doing, as a roster row and a status line want it. */
export type RunActivityBrief = {
  runId: string;
  botId: string;
  channelId: string | null;
  state: RunActivityState;
  label: string | null;
  detail: string | null;
  startedAt: Date;
  /** Who this run was delegated from, when it was. The chain's edge. */
  parentRunId: string | null;
  /** The run whose answer this one is waiting to become, when it was delegated. */
  delegatedToBotId: string | null;
};

/** A state change, as the live feed carries it. */
export type RunActivityEvent = {
  runId: string;
  actorUserId: string;
  botId: string;
  channelId: string | null;
  state: RunActivityState;
  label: string | null;
  detail: string | null;
  startedAt: string;
  /** The run this one was delegated from, so a client can place it in a chain without a fetch. */
  parentRunId: string | null;
};

/**
 * The topic state changes are announced on.
 *
 * A separate topic from the channel one on purpose. The two have different lifetimes and different
 * readers: a channel activity is about who may hear something in a conversation, and a state change
 * is about one person's whole workspace. Sharing a topic would mean every state change walked every
 * channel member list to work out that it was not for them.
 */
export const RUN_ACTIVITY_TOPIC = "run_activity";

/** A label this code wrote. Never the task — see the table's note on why. */
export type RunActivityInput = {
  runId: string;
  actorUserId: string;
  botId: string;
  channelId?: string | null;
  threadId: string;
  parentRunId?: string | null;
};

export type RunActivityStore = {
  /**
   * Record that a run has started, or move one that is already recorded.
   *
   * `onConflictDoUpdate` rather than an insert, because a run can be announced before this replica
   * has heard anything about it — a hop is delivered by a work queue, so the run that starts it was
   * written by a different server, or by a different request on this one. Refusing the second
   * arrival would lose the run that matters most, which is the one a person is waiting on.
   *
   * `startedAt` is left alone on conflict: the first sighting is when it began, and a later sighting
   * is this server learning about it. Overwriting would make every elapsed time wrong.
   */
  begin(input: RunActivityInput): Promise<RunActivity>;
  /**
   * Move a run to a state, and say so on the live feed.
   *
   * `endedAt` is set by the state, not by the caller: `done`, `stopped` and `failed` end a run and the
   * other three do not, and a caller that had to remember which is which would eventually get it
   * wrong in the direction that makes a finished run look busy for ever.
   *
   * `transitions` counts, and is not decoration. It is the number that says whether the live feed
   * and the row agree, and the guard against a Bot in a loop reading as a healthy long run.
   */
  transition(
    runId: string,
    state: RunActivityState,
    options?: {
      label?: string | null;
      detail?: string | null;
      error?: string | null;
      /**
       * The conversation this run is in, where the caller knows it. See the note in the body.
       */
      channelId?: string | null;
    },
  ): Promise<RunActivity | null>;
  /**
   * Record a run that is ABOUT to start because it was delegated, and the run that asked.
   *
   * Called by the delivery, which is the first party that knows both ids: it mints the addressed
   * Bot's run id itself, and the work item it claimed carries the run that asked. The hop has not
   * started when this is called, so the row is written now and the run's own `begin` finds it and
   * leaves `startedAt` alone.
   *
   * The edge is written HERE rather than at the start of the run because the run's own start cannot
   * see it: the thread lock is told a thread and a run, never the run that handed over, and a chain
   * whose edges are filled in afterwards is a chain a reader has to guess at.
   */
  recordDelegatedChild(input: {
    runId: string;
    actorUserId: string;
    botId: string;
    threadId: string;
    parentRunId: string;
    /**
     * The channel this run belongs to, where there is one.
     *
     * A hop into a coworker's own channel has the coworker's channel, which the Bot that asked is
     * not a member of and so cannot look up — the delivery is the only party that knows it. Absent
     * for a hop into a scratch thread, which no roster row should ever be made to wait for.
     */
    channelId?: string | null;
  }): Promise<RunActivity>;
  /** Everything still going, for one person. The roster's only query. */
  open(actorUserId: string): Promise<RunActivityBrief[]>;
  /**
   * End a run, but only if it has not ended already.
   *
   * The guard is the whole method. A run that failed transitions to `failed` where the failure is
   * known, and the thread lock releases afterwards on its way out — so a plain transition at release
   * would overwrite `failed` with `done` and lose the one state a person most needs to read. A
   * caller that says "done, unless you already know better" is the only shape that survives both
   * orders.
   */
  finish(
    runId: string,
    state?: Extract<RunActivityState, "done">,
  ): Promise<RunActivity | null>;
  /** One run, or null. */
  get(runId: string): Promise<RunActivity | null>;
  /**
   * Say a run is still going, and say whether it still was.
   *
   * THE COUNTERPART TO A HEARTBEAT'S ABSENCE, and the reason a chat run can be swept at all. A hop
   * proves liveness by renewing a `thread_locks` row; a person's own turn takes no lock, so before
   * this there was nothing for it to renew and nothing `sweepAbandonedRuns` could read. A run that
   * stopped mid-turn therefore held its channel's working pulse for ever.
   *
   * GUARDED ON `ended_at IS NULL` for the same reason `finish` is. A run that has already ended is
   * not alive however loudly it says otherwise, and a heartbeat that could revive it would resurrect
   * a settled row — reporting `thinking` for work that finished, which is the same class of lie as
   * the ghost it exists to clear, and worse because it would keep reappearing.
   *
   * Returns whether the row was still open, so a caller can stop beating a run that has been settled
   * out from under it rather than writing once a beat for ever to a row nobody will read.
   */
  heartbeat(runId: string): Promise<boolean>;
  /**
   * A delegation chain, newest first: the run a person started, then what it handed to, then that.
   *
   * Collected in the database rather than by asking for each run's children in turn, because a chain
   * is read as a list and asking per level is a round trip per Bot — on a three-hop chain that is
   * four queries to render one transcript.
   */
  chain(actorUserId: string, limit?: number): Promise<RunActivityBrief[]>;
  /**
   * The most urgent run per Bot, for a roster.
   *
   * A roster row is per CHANNEL and a channel has several Bots, so a list of open runs is not what
   * it can render: there is one place to put an indicator and several things competing for it. This
   * reduces each Bot to the one run that decides how it looks, and the caller reduces the channel
   * to the most urgent Bot.
   *
   * Only runs that have not ended are considered, apart from a failure — a run that broke is the
   * thing somebody needs to see, and it will never be "open" again. See {@link ACTIVITY_SEVERITY}.
   */
  /**
   * The most urgent run per (CHANNEL, Bot), for a roster.
   *
   * KEYED BY THE CHANNEL AS WELL AS THE BOT, and that is a bug that was on screen every day. Keyed
   * by Bot alone, one run lit every channel that Bot was in — and Remii is in all of them, so typing
   * in one conversation put a "working" pulse on every other conversation in the roster, and a person
   * looking at it had no way to tell a real four-way delegation from one conversation being answered.
   *
   * A run with no channel — a direct conversation with a Bot, which is not a roster row at all — is
   * keyed under {@link RUN_WITHOUT_CHANNEL} and read only as a fallback. See {@link activityKey}.
   */
  worstForChannels(actorUserId: string): Promise<Map<string, RunActivityBrief>>;
  /** Announce a state change to whoever is listening. Never awaited by a caller on a hot path. */
  publish(event: RunActivityEvent): Promise<void>;
};

/**
 * How badly a state wants a person's attention, highest first.
 *
 * The order is a judgement about what a roster is FOR, and it is deliberately not the order the
 * states were declared in.
 *
 * `waiting_on_you` is highest because it is the only state where the run cannot continue and the
 * person is the thing it is blocked on: an unanswered question is not work in progress, it is work
 * that has stopped and is now waiting to be unblocked, and it waits indefinitely and silently.
 * `failed` is next for the same reason — nothing will fix it but a person. `thinking` outranks
 * `delegated` because a Bot doing something is closer to an answer than one waiting on a coworker
 * that may itself be waiting. `stopped` is last and is not attention at all: somebody asked for it,
 * so it is a fact, not an alarm.
 */
/**
 * The key a run is reduced under: its channel and its Bot, or a placeholder for a run in no channel.
 *
 * A separator that cannot appear in either part, so no pair of ids can be spelled two ways. A
 * separator that COULD appear would be a quiet way to make one run look like another.
 */
export const RUN_WITHOUT_CHANNEL = "*";

export function activityKey(channelId: string | null, botId: string): string {
  return `${channelId ?? RUN_WITHOUT_CHANNEL}\u0000${botId}`;
}

export const ACTIVITY_SEVERITY: Readonly<Record<RunActivityState, number>> = {
  waiting_on_you: 4,
  failed: 3,
  thinking: 2,
  delegated: 1,
  stopped: 0,
  done: -1,
};

const TERMINAL: ReadonlySet<RunActivityState> = new Set<RunActivityState>([
  "done",
  "stopped",
  "failed",
]);

/** The wire form of a row: what a listener needs, and nothing that identifies the person twice. */
const asEvent = (row: typeof runActivity.$inferSelect): RunActivityEvent => ({
  runId: row.runId,
  actorUserId: row.actorUserId,
  botId: row.botId,
  channelId: row.channelId,
  state: row.state as RunActivityState,
  label: row.label,
  detail: row.detail,
  startedAt: row.startedAt.toISOString(),
  parentRunId: row.parentRunId,
});

/** A state, in the order a reader should prefer the most recent one. */
const asBrief = (row: typeof runActivity.$inferSelect): RunActivityBrief => ({
  runId: row.runId,
  botId: row.botId,
  channelId: row.channelId,
  state: row.state as RunActivityState,
  label: row.label,
  detail: row.detail,
  startedAt: row.startedAt,
  parentRunId: row.parentRunId,
  delegatedToBotId: null,
});

export function createRunActivityStore(database: Database): RunActivityStore {
  /*
   * Announce a row this store has just written.
   *
   * HERE, RATHER THAN AT EVERY CALL SITE, because the store is the only thing that knows a state
   * changed. A caller that remembered to publish would be one caller in five: the run that starts,
   * the run that delegates, the run that breaks, the child that begins — five places to remember,
   * and the roster is only as good as the most recent one somebody forgot.
   *
   * Never fatal and never rethrown. A live mark that is missed is corrected by the next transition
   * or by the next refetch, and this runs on the path of a run that is about to answer somebody.
   */
  const announce = async (
    row: typeof runActivity.$inferSelect,
    publish: (event: RunActivityEvent) => Promise<void>,
  ) => {
    try {
      await publish(asEvent(row));
    } catch {
      // See above. The row is written either way.
    }
  };

  const store: RunActivityStore = {
    async begin(input) {
      const [row] = await database
        .insert(runActivity)
        .values({
          runId: input.runId,
          actorUserId: input.actorUserId,
          botId: input.botId,
          channelId: input.channelId ?? null,
          threadId: input.threadId,
          parentRunId: input.parentRunId ?? null,
          state: "thinking",
          /*
           * The run's FIRST beat, written with the row rather than left for the first interval.
           *
           * A run that begins and is never heard from again — a process killed between here and the
           * first beat, or a turn that never streams — has to be a candidate the sweeper can see, and
           * a null beat would exclude it from a sweep that only reads lapsed beats. Stamping it now
           * makes "this run has not been heard from in over a minute" the same question whichever side
           * of the first interval the run died on.
           */
          lastHeartbeatAt: new Date(),
        })
        .onConflictDoUpdate({
          target: runActivity.runId,
          set: {
            // Everything a later sighting can legitimately add, and nothing that would move a
            // moment in time. `startedAt` is deliberately absent: it is when the run began, and this
            // server is only now finding out.
            channelId: sql`coalesce(excluded.channel_id, ${runActivity.channelId})`,
            parentRunId: sql`coalesce(excluded.parent_run_id, ${runActivity.parentRunId})`,
          },
        })
        .returning();
      if (!row)
        throw new Error(`run activity ${input.runId} could not be recorded`);
      await announce(row, store.publish);
      return row;
    },

    async transition(runId, state, options = {}) {
      const ended = TERMINAL.has(state) ? new Date() : null;
      const [row] = await database
        .update(runActivity)
        .set({
          state,
          // An explicit null clears the previous value, which matters for the pairs that are
          // mutually exclusive: a `waiting_on_you` that resolves into `thinking` must not keep
          // saying what it was waiting for, and `failed` must not keep a `done` run's clean record.
          ...(options.label !== undefined ? { label: options.label } : {}),
          /*
           * The channel, where the caller knows it and the row does not.
           *
           * A run's thread is whatever the browser sent, and a hop's is a scratch thread, so the
           * channel cannot be derived from either. The delegation is the one moment both ends are
           * known by name — the asking conversation and the coworker's — so it is where this is
           * said. Absent leaves whatever was there, which is what a caller that does not know
           * should get.
           */
          ...(options.channelId !== undefined
            ? { channelId: options.channelId }
            : {}),
          ...(options.detail !== undefined ? { detail: options.detail } : {}),
          ...(options.error !== undefined ? { error: options.error } : {}),
          ...(ended ? { endedAt: ended } : {}),
          transitions: sql`${runActivity.transitions} + 1`,
        })
        .where(eq(runActivity.runId, runId))
        .returning();
      if (row) await announce(row, store.publish);
      return row ?? null;
    },

    async recordDelegatedChild(input) {
      const [row] = await database
        .insert(runActivity)
        .values({
          runId: input.runId,
          actorUserId: input.actorUserId,
          botId: input.botId,
          threadId: input.threadId,
          parentRunId: input.parentRunId,
          // Not defaulted from the parent: a run in a coworker's own channel is in a DIFFERENT
          // channel from the one that asked, and inheriting would put a working indicator on the
          // asker's row for work happening somewhere the asker cannot see.
          channelId: input.channelId ?? null,
          state: "thinking",
          // As in `begin`: the first beat travels with the row. See the note there.
          lastHeartbeatAt: new Date(),
        })
        .onConflictDoUpdate({
          target: runActivity.runId,
          set: {
            // Only the edge, and only if there is not one already: a run's parent is a fact about
            // how it began, and two different answers would mean one run is claimed twice.
            parentRunId: sql`coalesce(${runActivity.parentRunId}, excluded.parent_run_id)`,
            // The same for the channel, which `begin` cannot supply later because a run that starts
            // in a thread has no way to know which conversation that thread belongs to.
            channelId: sql`coalesce(${runActivity.channelId}, excluded.channel_id)`,
          },
        })
        .returning();
      if (!row) {
        throw new Error(`delegated run ${input.runId} could not be recorded`);
      }
      return row;
    },

    async open(actorUserId) {
      const rows = await database
        .select()
        .from(runActivity)
        .where(
          and(
            eq(runActivity.actorUserId, actorUserId),
            isNull(runActivity.endedAt),
          ),
        )
        .orderBy(desc(runActivity.startedAt));
      return rows.map(asBrief);
    },

    async worstForChannels(actorUserId) {
      /*
       * Reduced here rather than by the caller.
       *
       * A channel holds several Bots and one roster row, so "the run for this channel" has to pick
       * between them, and the choice has to be the same choice every time or an indicator changes
       * as rows arrive. Done in the store so the severity order and the per-Bot reduction cannot
       * drift apart — the caller is left with a map it can merge with, not a rule to reimplement.
       */
      const rows = await database
        .select()
        .from(runActivity)
        .where(
          and(
            eq(runActivity.actorUserId, actorUserId),
            or(isNull(runActivity.endedAt), eq(runActivity.state, "failed")),
          ),
        )
        .orderBy(desc(runActivity.startedAt));
      const worst = new Map<string, RunActivityBrief>();
      for (const row of rows) {
        const brief = asBrief(row);
        const key = activityKey(brief.channelId, brief.botId);
        const held = worst.get(key);
        if (
          !held ||
          ACTIVITY_SEVERITY[brief.state] > ACTIVITY_SEVERITY[held.state]
        ) {
          worst.set(key, brief);
        }
      }
      return worst;
    },

    async finish(runId, state = "done") {
      /*
       * Guarded on `ended_at is null`, which is the entire reason this method exists separately
       * from `transition`. See its note on the type.
       *
       * A row whose run was never recorded returns null rather than being created here: a finish
       * without a begin is a run this deployment never saw start, and inventing one would put a
       * finished row on the roster with a start time nobody can account for.
       */
      const [row] = await database
        .update(runActivity)
        .set({
          state,
          endedAt: new Date(),
          /*
           * THE LABEL AND THE DETAIL GO WITH IT, and this is the last place a run can still be
           * lying.
           *
           * A run that asked a question and was answered finishes through here, and its row was
           * left reading `done` with the label "Needs your answer" — the state said the run was
           * finished and the words beside it said it was still waiting for somebody. Nothing drew
           * it (a finished run draws nothing) which is exactly why it survived: the wrong words
           * were only ever visible in a table nobody reads.
           *
           * A finished run is not waiting on anyone and is not broken, so it carries neither. The
           * history of what it was doing is in `transitions` and in the audit trail, which is where
           * a question about it belongs.
           */
          label: null,
          detail: null,
          transitions: sql`${runActivity.transitions} + 1`,
        })
        .where(and(eq(runActivity.runId, runId), isNull(runActivity.endedAt)))
        .returning();
      return row ?? null;
    },

    async get(runId) {
      const [row] = await database
        .select()
        .from(runActivity)
        .where(eq(runActivity.runId, runId))
        .limit(1);
      return row ?? null;
    },

    async heartbeat(runId) {
      // No `announce` here, and that is deliberate rather than an omission. A heartbeat changes
      // nothing a person can see: the state, the label and the detail are all untouched, so every
      // replica's roster already draws this run correctly and there is nothing to redraw. Publishing
      // would turn a per-beat write into a per-beat `pg_notify` fanned out to every connected tab,
      // to say something no tab displays differently.
      const beat = await database
        .update(runActivity)
        .set({ lastHeartbeatAt: new Date() })
        .where(and(eq(runActivity.runId, runId), isNull(runActivity.endedAt)))
        .returning({ runId: runActivity.runId });
      return beat.length > 0;
    },

    async chain(actorUserId, limit = 50) {
      const rows = await database
        .select()
        .from(runActivity)
        .where(eq(runActivity.actorUserId, actorUserId))
        .orderBy(desc(runActivity.startedAt))
        .limit(limit);
      const briefs = rows.map(asBrief);
      /*
       * Fill in each hop's target from the next row down.
       *
       * The edge is recorded on the CHILD — `parent_run_id` says who handed to it — so a chain read
       * newest-first already has every child above its parent. That makes the target the row
       * immediately before, and no second query is needed. A run with nothing after it is a leaf, and
       * a leaf delegated to nobody.
       */
      for (let index = 0; index < briefs.length - 1; index += 1) {
        const child = briefs[index];
        const parent = briefs[index + 1];
        if (child?.parentRunId && child.parentRunId === parent?.runId) {
          child.delegatedToBotId = parent.botId;
        }
      }
      return briefs;
    },

    async publish(event) {
      await database.execute(
        sql`select pg_notify(${RUN_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
      );
    },
  };

  return store;
}
