import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { REMII_AGENT_ID } from "../../../shared/remii";
import type { AgentActor } from "../agents/profile-types";
import type { ChannelStore } from "../channels/routes";
import type { Database } from "../db/client";
import { cronJobs } from "../db/schema";
import type { TurnRunner } from "../routines/runner";

/**
 * Remi's scheduled jobs, fired by the worker's minute ticker.
 *
 * Claim → run → release, the same shape as the routines sweep: an atomic UPDATE claims due
 * rows with a lease token, the server runs the turn, and release writes the next run (or
 * disables after ten consecutive failures). A firing runs the job's stored prompt as the
 * owner, in their 1:1 channel with the job's Bot, and the reply lands there as activity.
 */

const LEASE_MS = 10 * 60_000;
const FATIGUE_LIMIT = 10;
const CLAIM_LIMIT = 5;
/** Spelled as text: Postgres has no make_interval(msecs) and will not type a bare number here. */
const leaseInterval = `${LEASE_MS} milliseconds`;

export type CronJobRow = typeof cronJobs.$inferSelect;

type RawCronRow = {
  id: string;
  user_id: string;
  bot_id: string | null;
  name: string;
  expression: string;
  timezone: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  failures: number;
  trigger_config: unknown;
};

/** `database.execute` answers in raw snake_case; the rest of this file reads camelCase. */
function toCronJobRow(raw: RawCronRow): CronJobRow {
  const date = (value: string | null): Date | null =>
    value ? new Date(value) : null;
  return {
    id: raw.id,
    userId: raw.user_id,
    botId: raw.bot_id,
    name: raw.name,
    expression: raw.expression,
    timezone: raw.timezone,
    enabled: raw.enabled,
    lastRunAt: date(raw.last_run_at),
    nextRunAt: date(raw.next_run_at),
    lockedAt: date(raw.locked_at),
    lockedBy: raw.locked_by,
    lastError: raw.last_error,
    failures: raw.failures ?? 0,
    triggerConfig: raw.trigger_config as never,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function nextAfter(
  expression: string,
  timezone: string,
): Promise<Date | null> {
  try {
    // Croner loads on first schedule, not at boot.
    const { Cron } = await import("croner");
    return (new Cron(expression, { timezone }).nextRun() ??
      null) as Date | null;
  } catch {
    return null;
  }
}

export async function claimDueCronJobs(
  database: Database,
  leaseToken: string = randomUUID(),
): Promise<{ jobs: CronJobRow[]; leaseToken: string }> {
  const rows = (await database.execute(sql`
    UPDATE cron_jobs
    SET locked_at = now(), locked_by = ${leaseToken}
    WHERE id IN (
      SELECT id FROM cron_jobs
      WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now()
        AND (locked_at IS NULL OR locked_at < now() - ${leaseInterval}::interval)
      ORDER BY next_run_at ASC
      LIMIT ${CLAIM_LIMIT}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `)) as unknown as RawCronRow[];
  return { jobs: rows.map(toCronJobRow), leaseToken };
}

export type CronRunnerDeps = {
  database: Database;
  channelStore: ChannelStore;
  runTurn: TurnRunner;
  defaultBotId?: string;
};

async function channelFor(
  channelStore: ChannelStore,
  owner: AgentActor,
  botId: string,
) {
  return channelStore.direct(owner, botId);
}

/**
 * Run every due job once. Never throws: a firing that fails is released with its error and
 * fatigue count, and the loop moves on. Mirrors the routines runner's fatigue rule (ten
 * consecutive failures switches the job off and says so in the channel).
 */
export async function runCronTick(deps: CronRunnerDeps): Promise<{
  claimed: number;
  ran: number;
  failed: number;
}> {
  const { database, channelStore, runTurn } = deps;
  const { jobs, leaseToken } = await claimDueCronJobs(database);
  let ran = 0;
  let failed = 0;

  for (const job of jobs) {
    // A different worker (or an older tick) may hold this row; the lease says it is ours.
    if (job.lockedBy !== leaseToken) continue;
    const owner: AgentActor = { id: job.userId, role: "user" };
    const botId = job.botId ?? deps.defaultBotId ?? REMII_AGENT_ID;
    const prompt =
      (job.triggerConfig as { prompt?: unknown } | null)?.prompt ?? job.name;
    const instruction =
      typeof prompt === "string" && prompt.trim()
        ? `<scheduled-task name="${job.name}">${prompt}</scheduled-task>`
        : `Run the scheduled task "${job.name}".`;
    try {
      const channel = await channelFor(channelStore, owner, botId);
      const result = await runTurn({
        ownerUserId: job.userId,
        routineId: `cron:${job.id}`,
        agentId: botId,
        threadId: channel.threadId,
        instruction,
      });
      try {
        await channelStore.recordActivity(owner, channel.id, {
          text: result.replyText,
          agentId: botId,
          at: new Date(),
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "cron-activity-unrecorded",
            jobId: job.id,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      const next = await nextAfter(job.expression, job.timezone ?? "UTC");
      await database
        .update(cronJobs)
        .set({
          lastRunAt: new Date(),
          nextRunAt: next,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
          failures: 0,
          ...(next ? {} : { enabled: false }),
        })
        .where(eq(cronJobs.id, job.id));
      ran += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed += 1;
      try {
        const failures = (job.failures ?? 0) + 1;
        const next =
          failures >= FATIGUE_LIMIT
            ? null
            : ((await nextAfter(job.expression, job.timezone ?? "UTC")) ??
              null);
        await database
          .update(cronJobs)
          .set({
            lastRunAt: new Date(),
            nextRunAt: next,
            lockedAt: null,
            lockedBy: null,
            lastError: reason.slice(0, 500),
            failures,
            ...(failures >= FATIGUE_LIMIT ? { enabled: false } : {}),
          })
          .where(eq(cronJobs.id, job.id));
        if (failures === 1 || failures >= FATIGUE_LIMIT) {
          try {
            const channel = await channelFor(channelStore, owner, botId);
            await channelStore.recordActivity(owner, channel.id, {
              text:
                failures >= FATIGUE_LIMIT
                  ? `This scheduled task has failed ten times in a row, so I have switched it off: ${job.name}. Ask me to turn it back on when whatever it needs is working.`
                  : `This scheduled task failed: ${reason.slice(0, 160)}`,
              agentId: botId,
              at: new Date(),
            });
          } catch {
            // The ledger row above is what matters; the courtesy message is best effort.
          }
        }
      } catch (releaseError) {
        console.error(
          JSON.stringify({
            type: "cron-release-failed",
            jobId: job.id,
            reason:
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
          }),
        );
      }
    }
  }

  return { claimed: jobs.length, ran, failed };
}
