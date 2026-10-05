/**
 * The connection that a pooler would quietly ruin.
 *
 * Two things this repository does are properties of one socket, not of one query, and neither of
 * them survives being handed to a different backend session:
 *
 * - `LISTEN`. The subscription belongs to the session that asked for it, so under transaction or
 *   statement pooling the notification is delivered to whichever backend happens to hold the
 *   transaction that happened to be open, and the server that was listening never hears it. The
 *   symptom is silence, not an error: four listeners, none of them faulted, and work that stops
 *   arriving.
 * - `pg_try_advisory_lock`. A session lock is released when the session ends, so a pooler that
 *   recycles the backend drops the lock the sweep is holding and lets a second server start the
 *   same sweep. `audit-retention.ts` and `activity-retention.ts` both run up to 200 batches on the
 *   strength of having taken that lock.
 *
 * `prepare: false` for the same family of reason. postgres.js prepares statements by default, and a
 * prepared statement lives in a backend session under a generated name. A pooler that moves the
 * next query to a different backend gets a miss on the plan and, once it decides to re-prepare, a
 * name collision with whatever else is on that backend. The cost of not preparing is a re-parse per
 * query, which is the cheap direction to be wrong in for connections that exist to receive events
 * rather than to run a hot loop.
 */
import postgres from "postgres";

/**
 * One dedicated connection for a listener or a sweep, on the unpooled endpoint.
 *
 * `max: 1` because a listener that could be handed a second connection is a listener subscribed on
 * one socket and read from another.
 */
export function createUnpooledConnection(databaseUrl: string) {
  return postgres(databaseUrl, { max: 1, prepare: false });
}
