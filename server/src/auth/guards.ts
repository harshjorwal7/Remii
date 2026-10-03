import type { MiddlewareHandler } from "hono";

/**
 * Individual-user SaaS has no roles: every signed-in person is exactly one
 * thing, a user, sovereign over their own data. There is no administrator to
 * be, no override to hold, and no screen that needs one. The field stays on
 * the actor so every call site keeps compiling, but the only value it can
 * ever carry is `"user"` — an `"admin"` is unrepresentable, which is what
 * makes every admin bypass in the codebase dead by construction.
 */
export type RemiiRole = "user";

export type AuthenticatedActor = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role: RemiiRole;
  /**
   * Whether the address was verified. Absent means unknown (legacy SSO
   * actors); gates that need proof (sandbox provisioning) treat absent as
   * unverified.
   */
  emailVerified?: boolean;
};

export type AuthService = {
  handler: (request: Request) => Response | Promise<Response>;
  api: {
    getSession: (input: {
      headers: Headers;
      query: { disableCookieCache: boolean };
    }) => Promise<{
      user: {
        id: string;
        email: string;
        name?: string | null;
        image?: string | null;
      };
    } | null>;
  };
};

export type AppVariables = {
  actor: AuthenticatedActor;
};

export function createRequireUser(
  auth: AuthService,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
      query: { disableCookieCache: true },
    });

    if (!session) {
      return context.json({ error: "Authentication required." }, 401);
    }

    // Signed in is the whole bar. Authorization is per-row further down:
    // every query carries the actor's id, so one user can never reach
    // another's data, and there is no role that overrides it.
    context.set("actor", {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image,
      role: "user",
    });
    await next();
  };
}
