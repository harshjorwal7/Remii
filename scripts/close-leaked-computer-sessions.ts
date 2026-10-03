/**
 * Close the one session the metering leak left open, and debit it.
 *
 * A one-off, because the defect that produced the row is fixed in `provisioner.ts` and this is the
 * cleanup for the row it already produced. `computerMeter.open` declines to open a second session
 * while one is open, so until this row is closed that person is billed for nothing at all while
 * E2B's own meter charges the account in full.
 *
 * The end time is the moment the machine was actually stopped, read off the computer row, rather
 * than now — a session that ran from 00:49 to 01:26 must be charged for those 37 minutes and not
 * for however long it took to notice.
 *
 * Deletes nothing. Every number here is recomputed from the row's own `startedAt`, so running it
 * twice is a no-op: `close` finds no open session and returns null.
 */

import { eq } from "drizzle-orm";
import { createComputerMeter } from "../server/src/billing/computer-meter";
import { createDatabase } from "../server/src/db/client";
import { userComputers } from "../server/src/db/schema/computer";

const database = createDatabase(process.env.DATABASE_URL!);
const meter = createComputerMeter(database);

const open = await database.execute(
  `select s.id, s.user_id, s.started_at,
          c.updated_at as machine_stopped_at
     from computer_sessions s
     left join user_computers c on c.user_id = s.user_id
    where s.ended_at is null`,
);

for (const row of open as unknown as Array<{
  id: string;
  user_id: string;
  started_at: Date;
  machine_stopped_at: Date | null;
}>) {
  // Clamped to now, because a machine row that has not been touched since the session opened is
  // not evidence that anything ran for the whole gap.
  const endedAt = new Date(
    Math.min(row.machine_stopped_at?.getTime() ?? Date.now(), Date.now()),
  );
  const result = await meter.close({
    userId: row.user_id,
    reason: "idle",
    endedAt,
  });
  console.log(
    `closed ${row.id}: ${result?.seconds ?? 0}s, $${(result?.costUsd ?? 0).toFixed(6)}`,
  );
}

await database.$client.end({ timeout: 5 });
