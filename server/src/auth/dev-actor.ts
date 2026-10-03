import type { MiddlewareHandler } from "hono";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import type { AppVariables, AuthenticatedActor } from "./guards";

/**
 * A signed-in person, without signing in.
 *
 * A deployment with no identity provider is one user and no sign-in, so `bun run dev`
 * reaches the product without registering an OAuth client first. Nobody should have to set up Entra
 * to look at a Bot. `.env.example` ships that line switched on, so a clone still runs with no
 * configuration at all.
 *
 * The lock is the flag and nothing else. It used to be `NODE_ENV`, which is exactly backwards:
 * `NODE_ENV` is unset by default, so the one case it had to catch was the one it let through. A
 * container run on a VM with a hand-written env file and no provider served every visitor on the
 * internet as one user, and said nothing, because it looked like it was working. Now the
 * deployment refuses to start unless somebody wrote down that they meant it.
 *
 * Its id is fixed so Intelligence threads and memory stay attached to the same person across
 * restarts. Individual-user SaaS has no roles: this actor is a user like any other.
 */

export const DEV_ACTOR: AuthenticatedActor = {
  id: "dev-local-user",
  email: "dev@remii.local",
  role: "user",
  emailVerified: true,
};

type UserWriter = Pick<Database, "insert">;

export async function initializeDevActorUser(
  database: UserWriter,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return false;

  const name = DEV_ACTOR.name ?? DEV_ACTOR.email;
  await database
    .insert(users)
    .values({
      id: DEV_ACTOR.id,
      email: DEV_ACTOR.email,
      name,
      emailVerified: true,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: DEV_ACTOR.email,
        name,
        emailVerified: true,
        updatedAt: new Date(),
      },
    });

  return true;
}

/**
 * Whether this deployment admits everybody as one signed-in user.
 *
 * Only ever true when no identity provider is configured: a provider always wins, so a deployment
 * cannot half sign people in.
 *
 * SaaS mode: single-user/no-sign-in is allowed in every environment, including production. This
 * deployment serves its own product auth (or none) in front of the API; the platform keeps no
 * B2B SSO gates. The flag must still be said explicitly — running open by forgetting to set
 * something is not a mode.
 *
 * @param hasProvider whether any identity provider is configured
 */
export function singleUserEnabled(
  environment: Record<string, string | undefined>,
  hasProvider: boolean,
): boolean {
  if (hasProvider) return false;

  // Said explicitly, which is the only way to run with no sign-in at all. Not a default, and not
  // inferred from anything: every signal that could stand in for "this is only my laptop" is absent
  // by default on a server too.
  const asked =
    environment.REMII_SINGLE_USER?.trim() === "true" ||
    // The name this had before. Still honoured so an existing .env keeps working.
    environment.REMII_DEV_NO_AUTH?.trim() === "true";
  if (asked) {
    if (environment.NODE_ENV?.trim() === "production") {
      console.warn(
        "REMII_SINGLE_USER is enabled in production: every request is served as one " +
          "signed-in user with no sign-in. Put this deployment behind the product's own access " +
          "control before exposing it.",
      );
    }
    return true;
  }

  throw new Error(
    "No identity provider is configured. Set REMII_SINGLE_USER=true to run as one signed-in user with no sign-in. Refusing to start rather than serving a deployment where every visitor is let in.",
  );
}

/** A guard that admits everybody as {@link DEV_ACTOR}. Only ever mounted when singleUserEnabled(). */
export function createDevRequireUser(): MiddlewareHandler<{
  Variables: AppVariables;
}> {
  return async (context, next) => {
    context.set("actor", DEV_ACTOR);
    await next();
  };
}
