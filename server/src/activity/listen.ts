import postgres from "postgres";

/**
 * The subset of a logger this module uses.
 *
 * Spelled out rather than imported so the listener can be handed a stub in a test, and so it does
 * not care which logger the process happens to be running — a subscription that cannot be
 * constructed is not something a test should have to work around.
 */
type Log = {
  debug(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
};

import { RUN_ACTIVITY_TOPIC, type RunActivityEvent } from "./store";

/**
 * Watches for run activity announced by any instance, and tells this one.
 *
 * WHY A NOTIFY AND NOT A SUBSCRIPTION. Every state change is already written to `run_activity`, and
 * a reader could simply be told "go and look again". That is a query per event, on a table that
 * changes on every tool call of every run, for a fact the writer already had in its hand: a client
 * drawing a mark needs the state that was just written, not the newest state, and by the time a
 * query runs a second run may already have moved the row on. The writer publishes the transition it
 * just made; this listens and forwards it.
 *
 * WHY A SEPARATE LISTENER AT ALL. `LISTEN` holds a connection for the life of the subscription, and
 * the process that wrote a row is not necessarily the one holding the sockets. A single replica
 * would be fine forwarding in-process, and would then be the deployment that breaks first when a
 * second is added — with the roster going quietly stale on whichever replica did not make the
 * write. Listening is what makes the fan-out right for a second replica as well as the first.
 *
 * SHAPE, MIRRORS `startChannelActivityListener` in `channels/events.ts`, and the reader that must
 * agree with it is the same. A reconnection is answered by asking clients to refetch rather than
 * resumed, because the events that crossed the gap are not recoverable and a roster that quietly
 * misses a run is worse than one that refetches.
 */
export type RunActivityListener = { stop: () => Promise<void> };

export async function startRunActivityListener(
  databaseUrl: string,
  onEvent: (event: RunActivityEvent) => void,
  log?: Log,
  /** Told after a reconnection, so the client can be asked to refetch. */
  onResync?: () => void,
): Promise<RunActivityListener> {
  const connection = postgres(databaseUrl, { max: 1 });

  /*
   * Skipped on the first establish, so the signal means one thing.
   *
   * The first establish has no earlier subscription behind it, so nothing can have been missed, and
   * a resync there would claim a gap that does not exist.
   */
  let subscribed = false;
  const resync = () => {
    if (!subscribed) {
      subscribed = true;
      return;
    }
    log?.debug("run activity listener: reconnected, asking for a refetch");
    try {
      onResync?.();
    } catch (error) {
      log?.warn("run activity listener: resync handler threw", { err: error });
    }
  };

  try {
    await connection.listen(
      RUN_ACTIVITY_TOPIC,
      (payload) => {
        const event = readEvent(payload);
        if (!event) return;
        try {
          onEvent(event);
        } catch (error) {
          log?.warn("run activity listener: handler threw", { err: error });
        }
      },
      resync,
    );
  } catch (error) {
    await connection.end().catch(() => {});
    throw error;
  }

  return {
    stop: async () => {
      await connection.end().catch(() => {});
    },
  };
}

/**
 * Whether a notification carries an event worth forwarding.
 *
 * The writer's own type is not enough: a `NOTIFY` payload is whatever reached the channel, and this
 * process did not necessarily write it. Every field the hub reads is checked, and the run id is
 * checked for shape rather than for existence, because this is the boundary where a string from
 * another process becomes a socket message.
 */
function readEvent(payload: string): RunActivityEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const event = parsed as Record<string, unknown>;
  if (typeof event.runId !== "string" || event.runId.length === 0) return null;
  if (typeof event.actorUserId !== "string" || event.actorUserId.length === 0) {
    return null;
  }
  if (typeof event.botId !== "string" || event.botId.length === 0) return null;
  if (!isRunActivityState(event.state)) return null;
  if (event.label !== null && typeof event.label !== "string") return null;
  if (event.detail !== null && typeof event.detail !== "string") return null;
  if (typeof event.startedAt !== "string") return null;
  if (event.channelId !== null && typeof event.channelId !== "string")
    return null;
  if (event.parentRunId !== null && typeof event.parentRunId !== "string") {
    return null;
  }
  return {
    runId: event.runId,
    actorUserId: event.actorUserId,
    botId: event.botId,
    channelId: (event.channelId as string | null) ?? null,
    state: event.state,
    label: (event.label as string | null) ?? null,
    detail: (event.detail as string | null) ?? null,
    startedAt: event.startedAt,
    parentRunId: (event.parentRunId as string | null) ?? null,
  };
}

function isRunActivityState(
  value: unknown,
): value is RunActivityEvent["state"] {
  return (
    value === "thinking" ||
    value === "delegated" ||
    value === "waiting_on_you" ||
    value === "stopped" ||
    value === "failed" ||
    value === "done"
  );
}
