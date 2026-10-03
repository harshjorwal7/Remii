import { and, eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  channelAgents,
  channelMemberships,
  intelligenceChannelMappings,
  threads,
} from "../src/db/schema";

/**
 * GIVE BACK THE CONVERSATIONS THAT HAVE MESSAGES BUT NO THREAD.
 *
 * A transcript is read by asking the `threads` table who owns a thread and whether that person is
 * the one asking. A thread with messages and NO ROW is therefore not an empty conversation — it is
 * a conversation nobody is allowed to read, and the screen that would show it renders blank with
 * no error to explain why.
 *
 * That is not a hypothetical state. One of this deployment's channels was a blank page: its thread
 * held the whole fourteen-message run in which a person asked for an email and Remii handed the
 * work to Coco — the origin of the email thread that was repaired separately — and none of it could
 * be opened, because the thread had messages but no row to be authorized against. The write path
 * no longer produces this (`ensureThread` and `makeChannel` both insert), so this repairs what the
 * defect already wrote rather than preventing anything new.
 *
 * WHY A SCRIPT AND NOT A MIGRATION, for the same reasons as the stranded-handoff repair: it
 * repairs data written by a defect, it must run once, and a migration would run on every boot of
 * every replica forever.
 *
 * WHO OWNS A BACKFILLED THREAD IS NOT GUESSED. The owner is read from `intelligence_channel_mappings`,
 * which records the person a channel was mapped for and is the same row the transcript screen
 * resolves the thread through. A thread is only repaired when ALL of the following hold:
 *
 *   1. it has no row in `threads` — that is the defect;
 *   2. it has messages, so there is a conversation to recover;
 *   3. exactly one live channel maps to it, so there is one unambiguous owner;
 *   4. that mapping names a person who still exists;
 *   5. that person is a member of that channel, so the mapping agrees with the roster.
 *
 * A thread that fails any of them is reported and left alone. Two channels claiming one thread, or a
 * mapping to a person who is not a member, are exactly the situations where a repair could hand one
 * person's conversation to another, and a script that can do that is worse than the bug.
 *
 * A backfilled row is also given the channel's own agent when the channel has exactly one, because a
 * single-coworker channel is what the thread belongs to; a multi-coworker channel leaves it null
 * rather than picking one at random.
 *
 * USAGE:  bun --env-file=../.env server/scripts/repair-threads-without-rows.ts [--apply]
 *
 * Dry-run is the default and the summary is identical either way, so the dry run reads as the plan.
 */

const apply = process.argv.includes("--apply");
const databaseUrl =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? "";
if (!databaseUrl) throw new Error("DATABASE_URL is not set.");
const database = createDatabase(databaseUrl);

type Plan = {
  threadId: string;
  channelId: string;
  userId: string;
  agentId: string | null;
  messageCount: number;
  lastMessageAt: Date | null;
};

/** Every thread that has messages but no row, with the one channel that claims it. */
const orphans = await database.execute(sql`
  select m.thread_id,
         count(*)::int as message_count,
         max(tm.created_at) as last_message_at
  from intelligence_channel_mappings m
  join thread_messages tm on tm.thread_id = m.thread_id
  left join threads t on t.id = m.thread_id
  where t.id is null
  group by m.thread_id
  order by max(tm.created_at) desc
`);

const plans: Plan[] = [];
const skipped: { threadId: string; reason: string }[] = [];

for (const row of orphans as unknown as {
  thread_id: string;
  message_count: number;
  last_message_at: Date;
}[]) {
  const threadId = row.thread_id;

  const mappings = await database
    .select({
      channelId: intelligenceChannelMappings.channelId,
      userId: intelligenceChannelMappings.userId,
    })
    .from(intelligenceChannelMappings)
    .where(eq(intelligenceChannelMappings.threadId, threadId));

  if (mappings.length !== 1) {
    skipped.push({
      threadId,
      reason: `${mappings.length} live channels map to it; ownership would be ambiguous`,
    });
    continue;
  }
  const mapping = mappings[0]!;

  // The mapping must name a person who exists and belongs to the channel that claims the thread.
  const membership = await database
    .select({ userId: channelMemberships.userId })
    .from(channelMemberships)
    .where(
      and(
        eq(channelMemberships.channelId, mapping.channelId),
        eq(channelMemberships.userId, mapping.userId),
      ),
    );
  if (membership.length === 0) {
    skipped.push({
      threadId,
      reason: `channel ${mapping.channelId} does not have ${mapping.userId} as a member`,
    });
    continue;
  }

  const agents = await database
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(eq(channelAgents.channelId, mapping.channelId));
  if (agents.length > 1) {
    skipped.push({
      threadId,
      reason: `channel ${mapping.channelId} has ${agents.length} coworkers; no single owner agent`,
    });
    continue;
  }

  plans.push({
    threadId,
    channelId: mapping.channelId,
    userId: mapping.userId,
    agentId: agents[0]?.agentId ?? null,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at,
  });
}

console.log(`threads with messages but no row: ${orphans.length}`);
console.log(`would repair: ${plans.length}`);
for (const plan of plans) {
  console.log(
    `  ${plan.threadId}  channel=${plan.channelId}  user=${plan.userId}  agent=${plan.agentId ?? "-"}  messages=${plan.messageCount}  last=${plan.lastMessageAt?.toISOString?.() ?? plan.lastMessageAt}`,
  );
}
console.log(`would skip: ${skipped.length}`);
for (const skip of skipped) console.log(`  ${skip.threadId}: ${skip.reason}`);

if (!apply) {
  console.log("\ndry run — nothing written. Re-run with --apply to repair.");
} else if (plans.length === 0) {
  console.log("\nnothing to repair.");
} else {
  for (const plan of plans) {
    await database
      .insert(threads)
      .values({
        id: plan.threadId,
        userId: plan.userId,
        agentId: plan.agentId,
        createdAt: plan.lastMessageAt ?? new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
  }
  console.log(`\nrepaired ${plans.length} thread(s).`);
}

// A thread that gains a row must read back as owned; anything else means the repair did not take.
const verify = await database.execute(sql`
  select count(*)::int as still_orphaned
  from (
    select distinct m.thread_id
    from intelligence_channel_mappings m
    join thread_messages tm on tm.thread_id = m.thread_id
    left join threads t on t.id = m.thread_id
    where t.id is null
  ) s
`);
console.log(
  `threads still missing a row: ${(verify as unknown as { still_orphaned: number }[])[0]?.still_orphaned ?? "?"}`,
);
process.exit(0);
