import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

/**
 * Where this person is in first-run onboarding.
 *
 * On the user rather than its own query, so the `_authed` gate learns it from the request it
 * already makes. A null `completedAt` is what sends the app to /onboarding.
 */
export type OnboardingStatus = {
  step: number;
  completedAt: string | null;
};

export type AuthenticatedUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  /**
   * Individual-user SaaS has one role: every signed-in person is a user,
   * sovereign over their own data. Kept on the shape so screens keep
   * compiling; it can never be anything else.
   */
  role: "user";
  creditBalance?: number;
  stripeCustomerId?: string | null;
  isBanned?: boolean;
  /** Null means this deployment does not track onboarding, which reads as nothing to finish. */
  onboarding: OnboardingStatus | null;
};

/** Whether the gate holds: there is an onboarding to do and this person has not finished it. */
export function needsOnboarding(user: AuthenticatedUser): boolean {
  return user.onboarding !== null && user.onboarding.completedAt === null;
}

export const authKeys = {
  all: ["auth"] as const,
  currentUser: () => [...authKeys.all, "current-user"] as const,
  providers: () => [...authKeys.all, "providers"] as const,
};

/**
 * An identity provider this deployment can sign somebody in with.
 *
 * The ids the identity provider admits. Microsoft and Okta are gone: this product serves individuals
 * directly rather than companies behind a directory, and the provider has no route to either.
 */
export type AuthProviderId = "google" | "github" | "vercel";

/** What the sign-in screen may offer, answered by the process that knows. */
export type SignInOptions = {
  providers: AuthProviderId[];
  /**
   * Always false now, and kept because the screen reads it.
   *
   * It reported whether a company identity provider had been registered, for a product that has no
   * company front door. The server still sends the key, and it sends `false`, so anything caching
   * the old shape does not break on a field that has gone missing.
   */
  sso: boolean;
  /** Whether email plus password sign-in is on (draws a form, not a button). */
  emailPassword: boolean;
  authMode: "session" | "single-user";
};

async function signInOptions(): Promise<SignInOptions> {
  // The whole body, so both fields arrive together. Reading a field off the Response `client`
  // returns without a key quietly yields undefined: the screen would say no provider is configured
  // while the server was saying it has one.
  const body = (await (
    await client("/api/capabilities", { fallback: "Could not load sign-in" })
  ).json()) as {
    authProviders?: AuthProviderId[];
    ssoConfigured?: boolean;
    emailPassword?: boolean;
    authMode?: "session" | "single-user";
  };

  return {
    providers: body.authProviders ?? [],
    sso: body.ssoConfigured === true,
    emailPassword: body.emailPassword === true,
    authMode: body.authMode === "session" ? "session" : "single-user",
  };
}

/**
 * Which providers the sign-in screen may offer.
 *
 * From the server rather than from the build. The image is built once with no deployment
 * environment, so a list compiled into the bundle can only ever describe the build machine.
 */
export function authProvidersQueryOptions() {
  return queryOptions({
    queryKey: authKeys.providers(),
    queryFn: signInOptions,
    // Configuration, not data. It cannot change without the process restarting.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

async function currentUser(): Promise<AuthenticatedUser | null> {
  /*
   * `tryClient` rather than `client`: not being signed in is an answer here, not a failure, and it
   * arrives as a 401 that has to be read before anything decides the request went wrong.
   */
  const response = await tryClient("/api/me");
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Could not load the current user (${response.status})`);
  }

  const body = (await response.json()) as { user: AuthenticatedUser };
  return body.user;
}

export function currentUserQueryOptions() {
  return queryOptions({
    queryKey: authKeys.currentUser(),
    queryFn: currentUser,
    staleTime: 60_000,
  });
}
