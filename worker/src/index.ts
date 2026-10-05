/**
 * The local stand-in for the routines CronJob: `server/scripts/fire-routines.ts`, looped.
 *
 * That script runs one sweep and exits — a CronJob outside the process is what makes it recurring,
 * and a failed run is meant to page somebody. A laptop running the dev stack has no CronJob around
 * it, so this file supplies the recurrence itself, in-process, by importing the very same sweep
 * (`offerDueRoutines`, `dispatchClaimedRoutines`) and the same stores/queue construction. It never
 * spawns the script as a child process — shelling out to run it every 30 seconds would be a second,
 * divergent implementation of what a sweep is, with its own bugs to keep in sync with the first.
 *
 * WHY THIS LOOP MUST NOT DIE ON THE FIRST DB BLIP, unlike the script it wraps: `fire-routines.ts`
 * lets a phase's exception propagate so the CronJob's run is marked failed and a person is paged —
 * that is correct there, because a fresh pod is one `kubectl` restart away and paging is cheap
 * compared to routines silently going stale. This process has no restart policy watching it; it is
 * somebody's laptop, left running. A worker that exited because Postgres hiccuped for two seconds
 * would need a human to notice and restart it, which is worse than a worker that logs the failure and
 * tries again on the next tick. So every phase below gets its own try/catch, and nothing here ever
 * lets a phase's error reach the top and take the process down.
 */
import { createDatabase } from "../../server/src/db/client";
import { createRoutineStore } from "../../server/src/routines/store";
import {
  ROUTINE_FIRE_KIND,
  dispatchClaimedRoutines,
  offerDueRoutines,
  type RoutineSweepOptions,
} from "../../server/src/routines/sweep";
import { createWorkQueue } from "../../server/src/work/queue";
import {
  cronTickUrl,
  loadWorkerEnv,
  memoryConsolidateUrl,
  routineRunUrl,
} from "./env";
import { shouldRunNightly } from "./nightly";
import { runTelegramLoop } from "./telegram";
import { workerStatus } from "./status";

console.info(`Remii worker status: ${workerStatus().status}`);

/*
 * The worker's three settings, parsed and validated in one place (`./env`).
 *
 * Refused up front, for the reason `fire-routines.ts` refuses up front: a loop that
 * started anyway would open a run row for every routine it offers itself and collect
 * a 401 on every dispatch, forever, with the only evidence a line in the server's
 * audit trail. Said once, loudly, before the first tick, is the difference between a
 * worker that failed to start and a deployment where routines quietly do nothing.
 *
 * Read from the environment rather than from `DeploymentConfig`/`loadConfig`, and
 * deliberately so. `loadConfig` demands the whole server deployment's configuration —
 * Intelligence credentials, key encryption, auth — because it answers "what can this
 * deployment do". This process is handed exactly three settings by `scripts/start.sh`
 * (`DATABASE_URL`, `SERVER_INTERNAL_URL`, `WORKER_SHARED_SECRET`); calling
 * `loadConfig(process.env)` here would refuse to start over settings this loop has no
 * opinion about and does not need.
 */
const { workerSharedSecret, serverInternalUrl, databaseUrl, owner } =
  loadWorkerEnv();

const database = createDatabase(databaseUrl);
const queue = createWorkQueue(database);
const routineStore = createRoutineStore(database);

/**
 * Hand one opened run to the server, which owns everything about running it.
 *
 * Identical to `fire-routines.ts`'s `dispatch`: the run id is all that crosses, the header string
 * (casing and the one space included) is the whole credential the server compares, and anything but
 * a 202 throws — naming the status, because that is the whole diagnosis a person reading
 * `last_error` needs.
 */
async function dispatch(routineRunId: string): Promise<void> {
  const response = await fetch(routineRunUrl(serverInternalUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${workerSharedSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ routineRunId }),
    // The `for(;;)` loop below has no CronJob around it at all, so nothing bounds this call from
    // outside the process the way `activeDeadlineSeconds` bounds the CronJob's job; a wedged server
    // must not stall the only thing firing routines.
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 202) {
    throw new Error(
      `the server answered ${response.status} rather than 202 when handed a routine run`,
    );
  }
}

const options: RoutineSweepOptions = { routineStore, queue, dispatch, owner };

/** How often both sweep phases run. A laptop's clock, standing in for the CronJob's schedule. */
const TICK_MS = 30_000;

/*
 * How often the queue is purged of finished (and wedged) `routine.fire` items, in ticks rather than
 * milliseconds, so the two cadences cannot drift apart by editing one constant and not the other.
 *
 * Once every 120 ticks — roughly hourly at a 30-second tick — not once a tick. `queue.purge` deletes
 * rows older than the 24-hour window it is given below; running that DELETE every 30 seconds is three
 * orders of magnitude more query load than the window needs, for a retention job whose whole job is
 * to keep a day's worth of history. Hourly still purges comfortably inside the 24h window, with
 * enormous room to spare if a tick is ever missed.
 */
const PURGE_EVERY_N_TICKS = 120;
const PURGE_OLDER_THAN_MS = 24 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let tick = 0;

/** The UTC day consolidation last SUCCEEDED on. See `shouldRunNightly` in ./nightly.ts. */
let lastConsolidationDay = "";

/** The UTC day the morning brief last SUCCEEDED on. Same cadence, tracked apart. */
let lastBriefDay = "";

/** When either nightly pass was last attempted, whatever the outcome. */
let lastNightlyAttempt = 0;

async function runOneTick(): Promise<void> {
  tick += 1;

  /*
   * Both sweep phases, in one try/catch: this is the phase that runs every tick, and the one
   * `fire-routines.ts` lets throw. Here it does not — it is logged and the loop moves on to the next
   * tick 30 seconds later, per the file header above. A routine due right now that was missed by a
   * failed tick is still due on the next one; nothing about being late loses it (see `DEFAULT_GRACE_MS`
   * in `../../server/src/routines/sweep.ts`).
   */
  try {
    const { offered } = await offerDueRoutines(options);
    const report = await dispatchClaimedRoutines(options);
    console.info(
      JSON.stringify({
        type: "routine-sweep",
        offered,
        considered: report.considered,
        fired: report.fired,
        skipped: report.skipped,
      }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        type: "routine-sweep-tick-failed",
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  // The purge phase, on its own much longer cadence and its own try/catch: a purge failure this hour
  // is worth logging and retrying next hour, not a reason to stop offering and firing routines.
  // Also on the very first tick: a laptop restarted every 40 minutes would otherwise never survive
  // to tick 120, and would never reap.
  if (tick === 1 || tick % PURGE_EVERY_N_TICKS === 0) {
    try {
      const purged = await queue.purge({
        kind: ROUTINE_FIRE_KIND,
        olderThanMs: PURGE_OLDER_THAN_MS,
      });
      console.info(JSON.stringify({ type: "routine-sweep-purge", purged }));
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "routine-sweep-purge-failed",
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /*
   * Nightly memory consolidation, once per UTC day. The server merges duplicate memories and
   * resolves contradictions per user; this loop only supplies the clock. Dry-run until the
   * operator sets MEMORY_CONSOLIDATE_DRY_RUN=false: decisions are logged, nothing is linked.
   *
   * Each pass below has its own try/catch and its own day flag, so neither one is taken down by
   * the other failing, and neither touches the routines sweep.
   */
  const nowNightly = Date.now();
  const dryRun = process.env.MEMORY_CONSOLIDATE_DRY_RUN !== "false";

  // Each pass decides for itself, and is marked done only once it has actually worked. See
  // ./nightly.ts: marking the day before the request is what cost a whole UTC day to one timeout.
  if (shouldRunNightly(nowNightly, lastConsolidationDay, lastNightlyAttempt)) {
    lastNightlyAttempt = nowNightly;
    try {
      const response = await fetch(memoryConsolidateUrl(serverInternalUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${workerSharedSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ dryRun }),
        signal: AbortSignal.timeout(55_000),
      });
      const summary = (await response.json().catch(() => null)) as {
        users?: number;
        merged?: number;
        superseded?: number;
      } | null;
      // Only a response that arrived counts. A 500 is the server having received the pass and
      // failing it, which is a different thing from never arriving, and neither is a success.
      if (response.ok) {
        lastConsolidationDay = new Date(nowNightly).toISOString().slice(0, 10);
      }
      console.info(
        JSON.stringify({
          type: "memory-consolidation",
          status: response.status,
          dryRun,
          users: summary?.users ?? 0,
          merged: summary?.merged ?? 0,
          superseded: summary?.superseded ?? 0,
        }),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "memory-consolidation-failed",
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /*
   * The morning brief: one clock and one log line family with consolidation above, but tracked
   * separately so neither pass is lost because the other failed. It used to be nested inside the
   * consolidation block, which meant a failed consolidation silently took the brief down with it.
   */
  if (shouldRunNightly(Date.now(), lastBriefDay, lastNightlyAttempt)) {
    try {
      const briefed = await fetch(
        `${serverInternalUrl}/internal/memory/brief`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${workerSharedSecret}`,
            "content-type": "application/json",
          },
          body: "{}",
          signal: AbortSignal.timeout(55_000),
        },
      );
      const briefSummary = (await briefed.json().catch(() => null)) as {
        users?: number;
        briefed?: number;
      } | null;
      if (briefed.ok) {
        lastBriefDay = new Date().toISOString().slice(0, 10);
      }
      console.info(
        JSON.stringify({
          type: "memory-brief",
          status: briefed.status,
          users: briefSummary?.users ?? 0,
          briefed: briefSummary?.briefed ?? 0,
        }),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "memory-brief-failed",
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  // Remi's scheduled jobs, every other tick (about once a minute). The server claims due rows,
  // runs each as its owner and releases them; this loop only supplies the clock. Its own
  // try/catch, so a cron failure never touches the routines sweep above.
  if (tick % 2 === 0) {
    try {
      const response = await fetch(cronTickUrl(serverInternalUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${workerSharedSecret}`,
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(55_000),
      });
      const summary = (await response.json().catch(() => null)) as {
        claimed?: number;
        ran?: number;
        failed?: number;
      } | null;
      console.info(
        JSON.stringify({
          type: "cron-tick",
          status: response.status,
          claimed: summary?.claimed ?? 0,
          ran: summary?.ran ?? 0,
          failed: summary?.failed ?? 0,
        }),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "cron-tick-failed",
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

async function main(): Promise<void> {
  // Telegram alongside routines, when a bot token is configured. Its own loop (long-poll),
  // because stuffing a 25-second wait into the 30-second sweep tick would serialize the two:
  // a quiet Telegram would make every routine late. Absent without a token.
  //
  // Opt out with TELEGRAM_POLL=false (local development against a bot token
  // production already polls: two getUpdates loops 409 each other and both
  // sides lose messages). The link/username display keeps working — only the
  // incoming-message loop stops.
  if (
    process.env.TELEGRAM_BOT_TOKEN?.trim() &&
    process.env.TELEGRAM_POLL !== "false"
  ) {
    void runTelegramLoop({
      botToken: process.env.TELEGRAM_BOT_TOKEN.trim(),
      serverInternalUrl,
      workerSharedSecret,
    }).catch((error: unknown) => {
      console.warn(
        JSON.stringify({
          type: "telegram-loop-died",
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  } else {
    console.info(
      JSON.stringify(
        process.env.TELEGRAM_POLL === "false"
          ? {
              type: "telegram-disabled",
              note: "TELEGRAM_POLL is false, so Telegram messages are not polled here.",
            }
          : {
              type: "telegram-disabled",
              note: "TELEGRAM_BOT_TOKEN is not set, so Telegram messages are not polled.",
            },
      ),
    );
  }
  // Loop for ever, one tick every TICK_MS, awaiting each tick fully before scheduling the next so two
  // ticks are never in flight at once.
  for (;;) {
    await runOneTick();
    await sleep(TICK_MS);
  }
}

void main();
