import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { remiInstances } from "../db/schema";

/**
 * One person's Remi instance: how their engine is tuned.
 *
 * WHAT THIS IS FOR. The deployment default answers for everybody until somebody wants their
 * own model: which slug their turns run on, and on which provider. Nulls inherit, so a
 * person who never touched this has no row and nothing to keep in step — the same absent
 * shape user preferences take, for the same reason.
 *
 * WHAT IT IS NOT. It is not auth and not identity: who may sign in and who may do what
 * stays where it was. A bad slug fails the turn with the provider's own sentence rather
 * than refusing it here, because the store cannot know which slugs a vendor publishes.
 */
export type RemiInstance = {
  modelSlug: string | null;
  modelProvider: "openai" | "abliteration" | null;
};

export type RemiInstanceStore = {
  read: (userId: string) => Promise<RemiInstance>;
  write: (
    userId: string,
    patch: { modelSlug?: string | null; modelProvider?: string | null },
  ) => Promise<RemiInstance>;
};

export class InvalidInstanceModelError extends Error {
  constructor(value: string) {
    super(`Model provider must be "openai" or "abliteration", not ${JSON.stringify(value)}.`);
    this.name = "InvalidInstanceModelError";
  }
}

function toInstance(row?: {
  modelSlug: string | null;
  modelProvider: string | null;
}): RemiInstance {
  // Rows written before Anthropic was removed can still name it. Treating an unknown
  // provider as "unset" lets those users fall back to the deployment default instead of
  // failing every turn on a provider that no longer exists.
  const provider =
    row?.modelProvider === "openai" || row?.modelProvider === "abliteration"
      ? row.modelProvider
      : null;
  return {
    modelSlug: row?.modelSlug?.trim() ? row.modelSlug : null,
    modelProvider: provider,
  };
}

export function createRemiInstanceStore(database: Database): RemiInstanceStore {
  return {
    async read(userId) {
      const [row] = await database
        .select({
          modelSlug: remiInstances.modelSlug,
          modelProvider: remiInstances.modelProvider,
        })
        .from(remiInstances)
        .where(eq(remiInstances.userId, userId))
        .limit(1);
      return toInstance(row);
    },

    async write(userId, patch) {
      const current = await this.read(userId);
      const modelSlug =
        patch.modelSlug === undefined
          ? current.modelSlug
          : patch.modelSlug?.trim()
            ? patch.modelSlug.trim()
            : null;
      let modelProvider = current.modelProvider;
      if (patch.modelProvider !== undefined) {
        if (
          patch.modelProvider !== null &&
          patch.modelProvider !== "openai" &&
          patch.modelProvider !== "abliteration"
        ) {
          throw new InvalidInstanceModelError(String(patch.modelProvider));
        }
        modelProvider = patch.modelProvider;
      }
      if (modelSlug === null && modelProvider === null) {
        await database
          .delete(remiInstances)
          .where(eq(remiInstances.userId, userId));
        return { modelSlug: null, modelProvider: null };
      }
      await database
        .insert(remiInstances)
        .values({ userId, modelSlug, modelProvider })
        .onConflictDoUpdate({
          target: remiInstances.userId,
          set: { modelSlug, modelProvider, updatedAt: new Date() },
        });
      return { modelSlug, modelProvider };
    },
  };
}
