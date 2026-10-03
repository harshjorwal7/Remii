/**
 * The one computer a person owns, and how it is provisioned without a stampede.
 *
 * TWO PROBLEMS, AND THEY ARE NOT THE SAME ONE.
 *
 * The first is knowing what a user owns. That is a row, and `UNIQUE(user_id)` on it is the whole
 * model: a chat does not own a computer, a thread does not, and a user's computer outlives every
 * conversation. The row also stores the provider's own id, which nothing did before — the sandbox
 * name used to be recomputed from the owner slug on each call, so a renamed user addressed a
 * machine that no longer matched and there was no way to ask E2B what this database believed
 * it owned.
 *
 * The second is creating it. Two requests for a cold user are the normal case, not the exotic one:
 * a page that lists the computer and a page that watches it fire together, and the person reloads.
 * Both see "no computer", both call E2B, and the deployment pays for two sandboxes — of which
 * one is unreachable, because every later lookup resolves the row to the sandbox the first insert
 * won. That is why provisioning is single-flight and why the uniqueness is in the database: the
 * in-process guard handles the common case cheaply, and the unique index is what actually makes it
 * true, because the guard is per replica and the index is not.
 */
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { userComputers } from "../db/schema/computer";

/**
 * Where a user's computer is, as the spec's state machine.
 *
 * `desiredStatus` is separate from `status` because a start is not instant. Collapsing them means a
 * request arriving mid-transition is either fought or mis-reported, and a deployment that cannot
 * say whether a machine it is billing for is wanted is one that keeps paying for it.
 */
export const COMPUTER_STATUSES = [
  "NONE",
  "PROVISIONING",
  "READY",
  "RUNNING",
  "STOPPED",
  "PROVISIONING_FAILED",
  "ERROR",
  "DELETING",
  "DELETED",
] as const;

export type ComputerStatusName = (typeof COMPUTER_STATUSES)[number];

export type UserComputer = {
  id: string;
  userId: string;
  provider: string;
  sandboxId: string | null;
  status: ComputerStatusName;
  desiredStatus: "RUNNING" | "STOPPED";
  displayWidth: number | null;
  displayHeight: number | null;
  imageVersion: string | null;
  /** Who has the wheel. One mouse, one keyboard: this is what stops the two of them colliding. */
  controlHolder: "bot" | "human";
  controlSince: Date;
  /**
   * When it was last switched on, and when anyone last touched it.
   *
   * Declared here because `SELECT *` returns them and nothing admitted it: the store's `patch` has
   * always accepted both, and the idle sweep reads them, so a caller holding a row had no typed way to
   * ask when this computer was last used — which is the first question anybody asks about it.
   */
  lastStartedAt: Date | null;
  lastSeenAt: Date | null;
};

/**
 * What a Bot is told when a person has the wheel.
 *
 * Named, because it is the string the run shows and the sentence the Bot reads. "Action refused"
 * would be a refusal with no reason in it, and a Bot handed that would either retry or give up.
 */
export const HUMAN_HAS_CONTROL =
  "A person has control of this computer right now. Your action was not carried out. Wait until they hand the computer back, and say what you were about to do.";

/** Thrown when a user's row is being created by someone else, so the caller should read theirs. */
export class ComputerRowExistsError extends Error {
  constructor() {
    super("This user already has a computer row.");
    this.name = "ComputerRowExistsError";
  }
}

export function createUserComputerStore(database: Database) {
  return {
    async get(userId: string): Promise<UserComputer | null> {
      const rows = await database
        .select()
        .from(userComputers)
        .where(eq(userComputers.userId, userId))
        .limit(1);
      return (rows[0] as UserComputer | undefined) ?? null;
    },

    /**
     * Create the row, or report that somebody already did.
     *
     * The failure is a thrown error rather than a swallowed one because losing this race is a normal,
     * expected outcome — not a fault — and the caller has a real job when it happens: read the row
     * that won and use its sandbox. Reporting it as success-with-null would send it on to provision
     * a second machine.
     */
    async create(input: {
      id: string;
      userId: string;
      provider: string;
      imageVersion?: string | null;
      controlHolder?: "bot" | "human";
    }): Promise<UserComputer> {
      try {
        const inserted = await database
          .insert(userComputers)
          .values({
            id: input.id,
            userId: input.userId,
            provider: input.provider,
            imageVersion: input.imageVersion ?? null,
            status: "PROVISIONING",
            desiredStatus: "RUNNING",
            ...(input.controlHolder
              ? { controlHolder: input.controlHolder }
              : {}),
          })
          .returning();
        return inserted[0] as UserComputer;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ComputerRowExistsError();
        throw error;
      }
    },

    async patch(
      userId: string,
      patch: Partial<{
        sandboxId: string | null;
        status: ComputerStatusName;
        desiredStatus: "RUNNING" | "STOPPED";
        displayWidth: number | null;
        displayHeight: number | null;
        imageVersion: string | null;
        lastStartedAt: Date | null;
        lastSeenAt: Date | null;
        controlHolder?: "bot" | "human";
      }>,
    ): Promise<UserComputer | null> {
      const rows = await database
        .update(userComputers)
        .set({
          ...patch,
          updatedAt: new Date(),
          // A change of hands is stamped, so "who has had it since when" is answerable without a
          // second table. Untouched by any other patch, which is why it is set from the patch
          // rather than reset on every write.
          ...(patch.controlHolder ? { controlSince: new Date() } : {}),
        })
        .where(eq(userComputers.userId, userId))
        .returning();
      return (rows[0] as UserComputer | undefined) ?? null;
    },

    async remove(userId: string): Promise<boolean> {
      const rows = await database
        .delete(userComputers)
        .where(eq(userComputers.userId, userId))
        .returning({ id: userComputers.id });
      return rows.length > 0;
    },
  };
}

export type UserComputerStore = ReturnType<typeof createUserComputerStore>;

/**
 * Postgres' unique-violation, found wherever it ended up.
 *
 * Two things make this harder than checking one property, and both were found by the test failing
 * rather than by reading:
 *
 * - Drizzle wraps a driver failure in its own `DrizzleQueryError`, so the interesting fields are on
 *   the wrapped error, not the thrown one. Hence the walk down `cause`.
 * - This project drives Postgres through Bun's own driver (`drizzle-orm/bun-sql`), and Bun reports
 *   the SQLSTATE in `errno`, with `code` holding the driver's own `ERR_POSTGRES_SERVER_ERROR`. A
 *   check for `code === "23505"` therefore never fires, and losing the provisioning race surfaced as
 *   an unrecognised failure instead of "read the row that won" — which is the one thing the loser
 *   of that race has to do.
 *
 * `constraint` is checked as well because it says which uniqueness was hit, rather than assuming
 * every unique violation in this insert is the one we meant to catch.
 *
 * Bounded so a cycle in a driver's error chain cannot hang a request.
 */
function isUniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false;
  const record = error as {
    code?: unknown;
    errno?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  const state = record.code === "23505" || record.errno === "23505";
  const ours = record.constraint === "user_computers_user_id_unique";
  if (state && (ours || record.constraint === undefined)) return true;
  return isUniqueViolation(record.cause, depth + 1);
}

/**
 * One provisioning attempt at a time per user, in this process.
 *
 * This is the cheap half. It stops the common case — a listing and a viewer racing — from ever
 * reaching E2B twice, and it returns the SAME promise to every caller, so a second arrival waits
 * for the first answer instead of starting a parallel one. It is not the guarantee: it is per
 * replica, and a deployment runs several. The unique index on `user_id` is the guarantee, and this
 * exists so that guarantee is almost never exercised.
 */
// Typed on `unknown` because the helper below is generic: the map is keyed by user and holds
// whatever the caller's work returned, so pinning the value type would forbid every other use.
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Run `work` once per user at a time, and share the result with everyone who arrived meanwhile.
 *
 * The entry is removed in a `finally`, so a failure does not wedge a user forever: the next request
 * retries rather than inheriting a rejected promise for the life of the process.
 */
export function singleFlight<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const started: Promise<T> = (async () => work())().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started;
}

/** Exposed for tests, which must not inherit another test's in-flight entry. */
export function resetSingleFlight(): void {
  inFlight.clear();
}
