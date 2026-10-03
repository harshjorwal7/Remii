import { eq, isNull, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { runActivity, threads } from "../src/db/schema";

/**
 * MOVE THE CONVERSATIONS THAT A DELEGATION PUT IN THE WRONG THREAD.
 *
 * A delegation into a coworker's own channel used to run in a thread whose id was the CHANNEL's id,
 * because `ownThreadFor` returned `channel.id` where the delivery wanted a thread. The work
 * completed and was written — into a conversation no person could open, because the transcript
 * screen reads the channel's mapped thread. So a person who asked for an email saw their Bot say
 * it had handed the work over, and then nothing: no draft, no question, no trace of the coworker
 * having done anything.
 *
 * The bug is fixed in `agents/own-channel.ts` and the seam now returns both ids by name. This
 * script is for the conversations the bug already stranded, and it exists as a script rather than a
 * migration on purpose:
 *
 *   - it repairs DATA written by a defect, and a schema migration is the wrong instrument for that;
 *   - it must run once, and a migration runs on every boot of every replica forever;
 *   - it needs a decision about what to do with the empty thread it leaves behind, and that is a
 *     judgement rather than a schema change.
 *
 * IT FINDS NOTHING BY GUESSING. A thread is only treated as stranded when all of the following are
 * true, and every one of them is checked:
 *
 *   1. its id is exactly some live channel's id — that is the bug's fingerprint, and it is what
 *      makes this safe to run against a whole deployment;
 *   2. that channel is mapped to a DIFFERENT thread, so there is somewhere correct to go;
 *   3. the mapped thread is empty, so nothing is being interleaved with a real conversation;
 *   4. the stranded thread has messages, so there is something to rescue.
 *
 * A thread that fails any of them is reported and left alone. Being conservative here is not
 * timidity: the alternative is moving a person's conversation into a thread they did not write it
 * in, and a repair script that can do that is worse than the bug.
 *
 * USAGE:  bun --env-file=../.env server/scripts/repair-stranded-handoff-threads.ts [--apply]
 *
 * Dry-run is the default. Nothing is written without `--apply`, and the summary is identical either
 * way so the dry run can be read as the plan.
 */

const apply = process.argv.includes("--apply");
const databaseUrl =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? "";
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const database = createDatabase(databaseUrl);

type Stranded = {
  channelId: string;
  channelName: string;
  strandedThreadId: string;
  realThreadId: string;
  strandedMessages: number;
  realMessages: number;
  strandedAgentId: string | null;
  realAgentId: string | null;
  activityRows: number;
  /**
   * When the stranded conversation happened, captured during DISCOVERY.
   *
   * Read here rather than inside the transaction because the messages are moved first and the
   * window is derived from them: read afterwards it is NULL, the update matches nothing, and the
   * script reports a clean success having stamped nothing. That is the worst shape a repair can
   * have — a silent no-op that looks like a fix.
   */
  windowStart: Date | null;
  windowEnd: Date | null;
  /**
   * The Bot that asked, so the attribution can be rewritten to its name.
   *
   * Read from the stranded conversation's own opening line rather than from the work queue: the
   * queue row is one hop and there may be several, and the conversation is the thing being repaired.
   */
  askingBotId: string | null;
};

const stranded = await database.execute<Stranded>(sql`
  with candidates as (
    select
      c.id::text                                   as channel_id,
      c.name::text                                 as channel_name,
      t.id::text                                   as stranded_thread_id,
      m.thread_id::text                            as real_thread_id,
      (select count(*)::int from thread_messages x where x.thread_id = t.id) as stranded_messages,
      (select count(*)::int from thread_messages y where y.thread_id = m.thread_id) as real_messages,
      t.agent_id::text                             as stranded_agent_id,
      rt.agent_id::text                            as real_agent_id,
      (select count(*)::int from run_activity ra where ra.thread_id = t.id) as activity_rows,
      (select min(created_at) from thread_messages z where z.thread_id = t.id) as window_start,
      (select max(created_at) from thread_messages z where z.thread_id = t.id) as window_end,
      (select substring(content::text from '([a-z0-9_-]+) has asked you to help') from thread_messages z
        where z.thread_id = t.id and z.content::text like '%has asked you to help%' limit 1) as asking_bot_id
    from channels c
    join intelligence_channel_mappings m on m.channel_id = c.id
    join threads t on t.id = c.id::text
    left join threads rt on rt.id = m.thread_id
    where c.deleted_at is null
      and m.thread_id <> c.id::text
  )
  select * from candidates
  where stranded_messages > 0
    and real_messages = 0
    and real_thread_id is not null
`);

/*
 * The raw result is SNAKE_CASE while the script is written in camelCase, and the mapping is explicit
 * rather than a cast.
 *
 * A cast would compile and would be wrong the moment somebody renamed a column: every field would
 * read `undefined` and the dry run would print a plan full of `undefined` and still be believed.
 * That is the failure mode this script is least able to have — it moves people's conversations.
 */
const list: Stranded[] = (
  Array.isArray(stranded)
    ? stranded
    : ((stranded as unknown as { rows?: unknown[] }).rows ?? [])
).map((raw) => {
  const row = raw as Record<string, unknown>;
  return {
    channelId: String(row.channel_id ?? ""),
    channelName: String(row.channel_name ?? ""),
    strandedThreadId: String(row.stranded_thread_id ?? ""),
    realThreadId: String(row.real_thread_id ?? ""),
    strandedMessages: Number(row.stranded_messages ?? 0),
    realMessages: Number(row.real_messages ?? 0),
    strandedAgentId: (row.stranded_agent_id as string | null) ?? null,
    realAgentId: (row.real_agent_id as string | null) ?? null,
    activityRows: Number(row.activity_rows ?? 0),
    windowStart: (row.window_start as Date | null) ?? null,
    windowEnd: (row.window_end as Date | null) ?? null,
    askingBotId: (row.asking_bot_id as string | null) ?? null,
  };
});

for (const row of list) {
  if (!row.channelId || !row.strandedThreadId || !row.realThreadId) {
    console.error(
      "A candidate came back without the ids this script needs. Stopping.",
    );
    process.exit(1);
  }
}

if (list.length === 0) {
  console.log(
    "Nothing stranded: no thread is named after a live channel's id.",
  );
  process.exit(0);
}

console.log(
  `\n${list.length} conversation(s) stranded by the delegation bug.\n`,
);
for (const row of list) {
  console.log(`  channel      ${row.channelName} (${row.channelId})`);
  console.log(
    `  stranded in  ${row.strandedThreadId}  (${row.strandedMessages} messages)`,
  );
  console.log(
    `  belongs in   ${row.realThreadId}  (${row.realMessages} messages)`,
  );
  console.log(
    `  agent        stranded=${row.strandedAgentId ?? "none"} real=${row.realAgentId ?? "none"}`,
  );
  console.log(
    `  activity rows pointing at the stranded thread: ${row.activityRows}`,
  );
  console.log(
    `  asked by      ${row.askingBotId ?? "(not found in the opening line)"}`,
  );
  console.log(
    `  ran between   ${row.windowStart?.toISOString() ?? "?"} and ${row.windowEnd?.toISOString() ?? "?"}`,
  );
  console.log("");
}

if (!apply) {
  console.log("Dry run. Nothing written. Re-run with --apply to move them.");
  process.exit(0);
}

for (const row of list) {
  await database.transaction(async (tx) => {
    /*
     * THE MESSAGES FIRST, and the order is the whole safety of this.
     *
     * `thread_messages.thread_id` cascades on delete, so deleting the stranded thread first would
     * take the conversation with it — the one thing this script exists to prevent. So the rows are
     * re-pointed while both threads still exist, and only then is the empty one removed.
     */
    await tx.execute(sql`
      update thread_messages
      set thread_id = ${row.realThreadId}
      where thread_id = ${row.strandedThreadId}
    `);

    /*
     * THE REAL THREAD TAKES THE COWORKER'S AGENT.
     *
     * A channel's thread is created before its Bot is known to have spoken in it, so the row can
     * carry no agent. A thread with messages and no agent is the transcript screen's "empty
     * conversation" case, which is the shape the person saw. Set only from the stranded thread, and
     * only where the real one has none, so nothing already correct is overwritten.
     */
    if (row.realAgentId === null && row.strandedAgentId !== null) {
      await tx
        .update(threads)
        .set({ agentId: row.strandedAgentId })
        .where(eq(threads.id, row.realThreadId));
    }

    /*
     * THE ACTIVITY ROWS POINT AT THE CONVERSATION, not the thread they were found in.
     *
     * A stranded thread is a channel id, so a run recorded against it belongs to that channel. This
     * is the only place a stranded run's channel can be recovered at all, and it is why the row is
     * worth keeping until after this.
     */
    await tx
      .update(runActivity)
      .set({
        channelId: row.channelId,
        threadId: row.realThreadId,
      })
      .where(eq(runActivity.threadId, row.strandedThreadId));

    /*
     * AND THE ASKER'S ROW, which was left with no channel at all.
     *
     * Matched on the Bot that asked rather than on the thread, because the asker's run was recorded
     * against a thread the browser minted and that maps to nothing — so there is no thread to join
     * on, and this is the only place the asker's channel is recoverable.
     *
     * THE WINDOW IS THE STRANDED CONVERSATION'S OWN TIMESTAMPS, captured during discovery.
     *
     * It was first taken from the stranded thread's activity rows, which are empty by construction,
     * and then from its messages inside this transaction — which are empty by then, because moving
     * them is the first thing the transaction does. Both times the window was NULL, the update
     * matched nothing, and the script reported a clean success having stamped nothing. A repair
     * that cannot fail is a repair nobody should run. The window is therefore read once, before
     * anything is written, and passed in.
     *
     * The bound is what stops this stamping the channel onto every run the coworker has ever done,
     * which is the kind of plausible-looking wrong answer this script must not give.
     */
    const movedForChannel = await tx.execute(sql`
      update run_activity
      set channel_id = ${row.channelId}
      where channel_id is null
        and bot_id in (
          select agent_id from channel_agents where channel_id = ${row.channelId}
        )
        and started_at between ${row.windowStart} and ${row.windowEnd}
      returning run_id
    `);
    const stamped =
      (movedForChannel as unknown as { rowCount?: number }).rowCount ?? 0;

    /*
     * THE STALE LABEL. A run that was waiting on somebody and then finished was left saying so.
     */
    await tx
      .update(runActivity)
      .set({ label: null, detail: null })
      .where(
        sql`run_id in (
          select run_id from run_activity
          where thread_id = ${row.strandedThreadId} and state in ('done', 'stopped')
        )`,
      );

    /*
     * THE ATTRIBUTION IS REWRITTEN TO THE COWORKER'S NAME, and this is the part that answers the
     * question the person actually asked.
     *
     * The opening line of a delegated conversation was built from `fromBotId`, so Coco's channel
     * opened with "general-assistant has asked you to help with this" — an identifier the person has
     * never seen, in the one sentence whose entire job is to say who is asking. `handoff-runner.ts`
     * now reads `fromName`, but the messages this script is moving were written before that, and
     * leaving them would mean the recovered conversation is the one place the name is still wrong.
     *
     * Keyed on the exact sentence the old code produced, and the name comes from the roster rather
     * than from this script, so nothing is renamed to whatever seemed right at the time.
     */
    const askerName = await tx
      .select({ name: sql<string>`coalesce(name, agent_id)` })
      .from(sql`agent_profiles`)
      .where(sql`agent_id = ${row.askingBotId ?? ""}`)
      .limit(1)
      .then((rows) => (rows as unknown as { name?: string }[])[0]?.name ?? null)
      .catch(() => null);
    if (askerName) {
      await tx.execute(sql`
        update thread_messages
        set content = replace(content::text, ${`${row.askingBotId} has asked you to help`}, ${`${askerName} has asked you to help`})::jsonb
        where thread_id = ${row.realThreadId}
          and content::text like ${`%${row.askingBotId} has asked you to help%`}
      `);
    }

    // Empty by now, and gone, so nothing lists a conversation that is not one.
    await tx.delete(threads).where(eq(threads.id, row.strandedThreadId));

    console.log(
      `  moved ${row.strandedMessages} messages into ${row.realThreadId}` +
        (stamped > 0
          ? `, stamped ${stamped} activity row(s) with the channel`
          : ""),
    );
  });
}

const stillStranded = await database.execute(sql`
  select count(*)::int as n
  from threads t
  join channels c on c.id::text = t.id
  where c.deleted_at is null
    and exists (select 1 from thread_messages m where m.thread_id = t.id)
`);
const left =
  (stillStranded as unknown as { rows?: { n: number }[] }).rows?.[0]?.n ?? 0;
console.log(
  `\nDone. Threads still named after a live channel and holding messages: ${left}.`,
);
process.exit(0);
