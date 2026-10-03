import { eq } from "drizzle-orm";
import { type ExecutionMode, parseExecutionMode } from "./config";
import type { Database } from "./db/client";
import { userPreferences } from "./db/schema/core";

/**
 * One person's execution switch: whether their coworkers act directly or ask first.
 *
 * WHAT THIS IS FOR. The deployment default (`BOT_EXECUTION_MODE`, direct unless configured)
 * is one answer for everybody; a person who wants their own Bots to confirm before acting
 * externally should not need an administrator. Null means "inherit the deployment", which is
 * also what a fresh row looks like — there is no second representation of "default".
 *
 * WHAT IT IS NOT. It is not a grant and it changes nothing about what a coworker may call.
 * In `ask-first` mode the run is instructed to put external, side-effecting actions to the
 * person via `ask_person` before doing them; internal work is never gated. The worst a bad
 * value can do is make a Bot ask more often, which is why failures to read it fall back to
 * the deployment default rather than failing the turn.
 */
export type ExecutionModeStore = {
  /** The person's own choice, or null to inherit the deployment default. */
  read: (userId: string) => Promise<ExecutionMode | null>;
  /**
   * Save, or clear back to inherit. Returns what is stored: the mode, or null when the row
   * is gone. Accepts null/undefined/"" as "inherit".
   */
  write: (
    userId: string,
    mode: ExecutionMode | null | undefined | string,
  ) => Promise<ExecutionMode | null>;
};

export class InvalidExecutionModeError extends Error {
  constructor(value: string) {
    super(
      `Execution mode must be "direct", "ask-first" or empty (inherit), not ${JSON.stringify(value)}.`,
    );
    this.name = "InvalidExecutionModeError";
  }
}

export function createExecutionModeStore(
  database: Database,
): ExecutionModeStore {
  return {
    async read(userId) {
      const [row] = await database
        .select({ executionMode: userPreferences.executionMode })
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1);

      return parseExecutionMode(row?.executionMode ?? undefined) ?? null;
    },

    async write(userId, mode) {
      if (mode === null || mode === undefined || String(mode).trim() === "") {
        await database
          .delete(userPreferences)
          .where(eq(userPreferences.userId, userId));
        return null;
      }
      let parsed: ExecutionMode;
      try {
        const value = parseExecutionMode(String(mode));
        if (!value) throw new InvalidExecutionModeError(String(mode));
        parsed = value;
      } catch (error) {
        if (error instanceof InvalidExecutionModeError) throw error;
        throw new InvalidExecutionModeError(String(mode));
      }

      await database
        .insert(userPreferences)
        .values({ userId, executionMode: parsed })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: { executionMode: parsed, updatedAt: new Date() },
        });
      return parsed;
    },
  };
}

/**
 * The ask-first directive, appended to a run's standing instructions.
 *
 * Beside the person's own instructions rather than inside any Bot's role, because it is a
 * fact about the person (how they want to be worked for), it applies to every built-in Bot
 * alike, and removing it is one row delete rather than a package edit. Internal work is
 * explicitly ungated: the point is effects on the world, and a Bot that asks before
 * remembering something has misunderstood the switch.
 */
export function askFirstGuidance(): string {
  return [
    "Execution mode is ask-first: before any external, side-effecting action — sending mail or messages, posting, deleting, changing anything outside this conversation — call ask_person with the exact action and stop there, and only proceed once the person says to. Answering, reading, organizing, remembering, searching and drafting never need asking.",
  ].join("\n\n");
}
