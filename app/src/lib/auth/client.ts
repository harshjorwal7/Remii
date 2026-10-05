import { createAuthClient } from "better-auth/react";
import type { AuthProviderId } from "./queries";

/**
 * The browser's auth client, pointed at this deployment's own `/api/auth`.
 *
 * No `baseURL`, which is what makes every call same-origin and relative. It was already this way when
 * the calls reached a Better Auth instance inside the API server; they now reach Neon Auth through
 * that server, which forwards each path unchanged. Either way the browser does not know where the
 * identity provider lives, which is what lets it be a hosted service on another host without a
 * cross-origin credential on every call and without the API server losing the session.
 *
 * No plugins, and that is the provider's list rather than a choice. The previous `ssoClient()`,
 * `usernameClient()` and `emailOTPClient()` registered methods for company SSO, username sign-in and
 * email codes; Neon Auth admits none of those, so their endpoints do not exist to call and the
 * screen no longer offers them.
 */
export const authClient = createAuthClient();

/** What each provider is called on the button, since none of them are called by their id. */
const PROVIDER_NAMES: Record<AuthProviderId, string> = {
  google: "Google",
  github: "GitHub",
  vercel: "Vercel",
};

export function providerName(provider: AuthProviderId): string {
  return PROVIDER_NAMES[provider];
}

/** What a sign-in attempt came back with, which is either nothing or a reason. */
type SocialResult = { error?: { message?: string } | null };

/**
 * Start sign-in with one provider.
 *
 * One call for every provider, because the provider registers each under its own id and the browser
 * does not need to know how it is served.
 *
 * `start` is injectable because Better Auth's client is a proxy, so a test cannot replace the method
 * on it. Named so it cannot shadow anything it defaults to.
 */
export async function signInWith(
  provider: AuthProviderId,
  start: (input: {
    provider: string;
    callbackURL: string;
  }) => Promise<SocialResult> = (input) =>
    authClient.signIn.social(input as never) as Promise<SocialResult>,
) {
  const result = await start({
    provider,
    callbackURL: window.location.origin,
  });

  if (result.error) {
    // Naming the provider matters more with several buttons than it did with one: "Could not start
    // sign-in" leaves somebody looking at all of them with no idea which one refused.
    throw new Error(
      result.error.message ||
        `Could not start ${providerName(provider)} sign-in.`,
    );
  }
}
