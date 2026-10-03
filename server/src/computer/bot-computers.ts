/**
 * The desktop one Bot owns, on the disk its person shares with its siblings.
 *
 * The same two problems as `user-computers` — knowing what exists, and not creating two of it at
 * once — with one difference that matters: what is unique here is the Bot, not the person. A person
 * may own many Bots and each of them gets its own screen.
 *
 * The disk is the deliberate part. `userId` is carried on every row rather than joined through the
 * Bot, because two different questions get asked of this row and they do not have the same answer:
 * "which shared folder does this Bot mount" is the person, while "which machine does it drive" is
 * the Bot. Deriving one from the other is how a Bot ends up on a stranger's disk.
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { botComputers } from "../db/schema/computer";
import { type ComputerStatusName, singleFlight } from "./user-computers";

export type BotComputer = {
  id: string;
  botId: string;
  userId: string;
  provider: string;
  sandboxId: string | null;
  status: ComputerStatusName;
  desiredStatus: "RUNNING" | "STOPPED";
  displayWidth: number | null;
  displayHeight: number | null;
  imageVersion: string | null;
  /** Who drives THIS Bot's screen. Several machines, so the wheel is per Bot, not per person. */
  controlHolder: "bot" | "human";
  controlSince: Date;
};

export class BotComputerRowExistsError extends Error {
  constructor() {
    super("This Bot already has a computer row.");
    this.name = "BotComputerRowExistsError";
  }
}

export function createBotComputerStore(database: Database) {
  return {
    async get(botId: string): Promise<BotComputer | null> {
      const rows = await database
        .select()
        .from(botComputers)
        .where(eq(botComputers.botId, botId))
        .limit(1);
      return (rows[0] as BotComputer | undefined) ?? null;
    },

    /** Every desktop a person owns, for the concurrency cap and for the "hold all" override. */
    async listForUser(userId: string): Promise<BotComputer[]> {
      const rows = await database
        .select()
        .from(botComputers)
        .where(eq(botComputers.userId, userId));
      return rows as unknown as BotComputer[];
    },

    async create(input: {
      id: string;
      botId: string;
      userId: string;
      provider: string;
      imageVersion?: string | null;
    }): Promise<BotComputer> {
      try {
        const inserted = await database
          .insert(botComputers)
          .values({
            id: input.id,
            botId: input.botId,
            userId: input.userId,
            provider: input.provider,
            imageVersion: input.imageVersion ?? null,
            status: "PROVISIONING",
            desiredStatus: "RUNNING",
          })
          .returning();
        return inserted[0] as BotComputer;
      } catch (error) {
        if (isBotUniqueViolation(error)) throw new BotComputerRowExistsError();
        throw error;
      }
    },

    async patch(
      botId: string,
      patch: Partial<{
        sandboxId: string | null;
        status: ComputerStatusName;
        desiredStatus: "RUNNING" | "STOPPED";
        displayWidth: number | null;
        displayHeight: number | null;
        imageVersion: string | null;
        lastStartedAt: Date | null;
        lastSeenAt: Date | null;
        controlHolder: "bot" | "human";
      }>,
    ): Promise<BotComputer | null> {
      const rows = await database
        .update(botComputers)
        .set({
          ...patch,
          updatedAt: new Date(),
          // Stamped on a change of hands only, so "who has had it since when" is answerable from
          // this one table and is not reset by an unrelated write such as a geometry update.
          ...(patch.controlHolder ? { controlSince: new Date() } : {}),
        })
        .where(eq(botComputers.botId, botId))
        .returning();
      return (rows[0] as BotComputer | undefined) ?? null;
    },

    /**
     * Hand back the wheel on every one of a person's Bots at once.
     *
     * The escape hatch a per-Bot wheel creates the need for: holding one Bot's screen is normal and
     * useful, but "stop everything, I need the machine" has to be possible without visiting each Bot
     * in turn. Scoped to one person so it cannot be aimed at someone else's fleet.
     *
     * Bots that are stopped are included deliberately — releasing a wheel on a machine that is not
     * running leaves no trace, whereas releasing only the running ones would leave a stale "human"
     * on a machine that comes back later and refuse its own Bot.
     */
    async releaseAllForUser(userId: string): Promise<number> {
      const rows = await database
        .update(botComputers)
        .set({
          controlHolder: "bot",
          controlSince: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(botComputers.userId, userId),
            eq(botComputers.controlHolder, "human"),
          ),
        )
        .returning({ id: botComputers.id });
      return rows.length;
    },

    async remove(botId: string): Promise<boolean> {
      const rows = await database
        .delete(botComputers)
        .where(eq(botComputers.botId, botId))
        .returning({ id: botComputers.id });
      return rows.length > 0;
    },
  };
}

export type BotComputerStore = ReturnType<typeof createBotComputerStore>;

/**
 * Run one provisioning attempt at a time per Bot, in this process.
 *
 * Delegated to the same guard the person-level store uses rather than a second copy: the failure it
 * prevents — two callers, two sandboxes, one unreachable — is identical, and two maps would mean two
 * places to forget to clear. Keyed by Bot, so two Bots of the same person provision in parallel,
 * which is the point of giving them separate screens.
 */
export function singleFlightPerBot<T>(
  botId: string,
  work: () => Promise<T>,
): Promise<T> {
  return singleFlight(`bot:${botId}`, work);
}

/**
 * Postgres' unique-violation on `bot_computers`, found wherever the driver put it.
 *
 * The same two wrinkles as the person-level store, both found by a failing test rather than by
 * reading: Drizzle wraps the driver error so the useful fields are on `cause`, and Bun's driver puts
 * the SQLSTATE in `errno` while `code` holds its own `ERR_POSTGRES_SERVER_ERROR` — so checking `code`
 * alone never fires and losing the race reads as an unrecognised failure instead of "use the row
 * that won". Bounded so a cycle in the chain cannot hang a request.
 */
function isBotUniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false;
  const record = error as {
    code?: unknown;
    errno?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  const state = record.code === "23505" || record.errno === "23505";
  const ours = record.constraint === "bot_computers_bot_id_unique";
  if (state && (ours || record.constraint === undefined)) return true;
  return isBotUniqueViolation(record.cause, depth + 1);
}
