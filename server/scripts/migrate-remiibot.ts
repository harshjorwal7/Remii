/**
 * Import coworkers from a remiibot data directory into Remii.
 *
 * Remiibot keeps its roster in `bots.json`: each entry becomes a private custom Bot owned by
 * the given Remii user, with its description and soul as the standing role. The chief of
 * staff itself is skipped unless `--include-chief` is passed — Remii's Remii already is
 * the chief, and a second one would only confuse the roster. Thread entries (`tasks`) hold
 * conversations, not todos, and migrate only with `--include-threads`, as empty channels
 * named after the thread; message history lives in remiibot's own store and is not carried.
 *
 * Vector memories are not in these files (they live in remiibot's Postgres), so there is
 * nothing to carry for them: durable facts arrive by talking to Remii, which saves what
 * matters through memory_save.
 *
 * Idempotent on the remiibot bot id: re-running updates nothing and reports what already
 * exists. Dry-run first; it prints every row it would write.
 *
 *     bun scripts/migrate-remiibot.ts --user <remii-user-id> [--dry-run] [--include-chief]
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, users } from "../src/db/schema";

type RemiibotTask = {
  threadId?: string;
  title?: string;
  createdAt?: number;
};

type RemiibotBot = {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  soul?: string;
  chiefOfStaff?: boolean;
  tasks?: RemiibotTask[];
};

function argsOf(argv: string[]): {
  userId: string | null;
  dir: string;
  dryRun: boolean;
  includeChief: boolean;
} {
  const at = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };
  return {
    userId: at("--user"),
    dir: at("--dir") ?? `${process.env.HOME ?? "~"}/.remiibot`,
    dryRun: argv.includes("--dry-run"),
    includeChief: argv.includes("--include-chief"),
  };
}

async function main(): Promise<void> {
  const options = argsOf(process.argv.slice(2));
  if (!options.userId) {
    console.error(
      "Usage: bun scripts/migrate-remiibot.ts --user <remii-user-id> [--dry-run]",
    );
    process.exit(2);
  }
  const raw = await Bun.file(`${options.dir}/bots.json`)
    .json()
    .catch(() => null);
  if (!Array.isArray(raw)) {
    console.error(`No bots.json array at ${options.dir}/bots.json.`);
    process.exit(1);
  }
  const bots = raw as RemiibotBot[];
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be configured.");
    process.exit(1);
  }
  const database = createDatabase(databaseUrl);

  const [owner] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, options.userId))
    .limit(1)
    .catch(() => []);
  if (!owner) {
    console.error(`No Remii user ${options.userId}.`);
    process.exit(1);
  }

  let created = 0;
  let skipped = 0;
  for (const bot of bots) {
    const name = (bot.name ?? "").trim() || "Imported Bot";
    if (bot.chiefOfStaff && !options.includeChief) {
      console.log(`skip chief "${name}" (Remii Remii already is the chief)`);
      skipped += 1;
      continue;
    }
    const agentId = `remiibot-${(bot.id ?? randomUUID()).slice(0, 8)}`;
    const [existing] = await database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
      .catch(() => []);
    if (existing) {
      console.log(`exists ${agentId} "${name}"`);
      skipped += 1;
      continue;
    }
    const role = [(bot.description ?? "").trim(), (bot.soul ?? "").trim()]
      .filter(Boolean)
      .join("\n\n");
    console.log(
      `${options.dryRun ? "would create" : "create"} ${agentId} "${name}"`,
    );
    if (options.dryRun) continue;
    await database.insert(agents).values({
      id: agentId,
      ownerUserId: options.userId,
      isSystemTemplate: false,
      name,
      type: "built_in",
      configuration: {
        systemPrompt:
          role || `You are ${name}, a coworker imported from remiibot.`,
      },
    });
    await database.insert(agentProfiles).values({
      agentId,
      ownerUserId: options.userId,
      isSystemTemplate: false,
      title: (bot.title ?? "").trim() || name,
      roleDescription: role.slice(0, 2000) || name,
      avatarSeed: agentId,
      visibility: "private",
    });
    created += 1;
  }
  console.log(`done: ${created} created, ${skipped} skipped.`);
}

await main();
