import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { ProviderLogo } from "@/components/auth/provider-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient, providerName, signInWith } from "@/lib/auth/client";
import { appConfig } from "@/lib/generated/application-config";
import {
  type AuthProviderId,
  authProvidersQueryOptions,
  currentUserQueryOptions,
} from "../lib/auth/queries";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const ENTRANCE_SECONDS = 0.4;
const ENTRANCE_STAGGER_SECONDS = 0.08;
const ENTRANCE_OFFSET = "translateY(12px)";

export const Route = createFileRoute("/sign")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user) {
      throw redirect({ to: "/" });
    }
    // Loaded here so the screen paints with its buttons rather than painting empty and then
    // growing them, which reads as "no providers" for exactly as long as the request takes.
    await context.queryClient.ensureQueryData(authProvidersQueryOptions());
  },
  component: SignScreen,
});

/**
 * An email address and a password.
 *
 * Two tabs and two fields, no OAuth round trip. The field this used to accept a login name in, and
 * the sign-up field beside it, are gone: the identity provider has no username, so there was nothing
 * for either to be saved as. See the refusal in `submit`.
 *
 * On success the session cookie is set by the response and the app navigates home, where the
 * authed gate reads the new session.
 */
function EmailPasswordForm({
  busy,
  onError,
}: {
  busy: boolean;
  onError: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [working, setWorking] = useState(false);

  async function submit(submission: React.FormEvent) {
    submission.preventDefault();
    onError(null);
    setWorking(true);
    try {
      /*
       * An address, or a refusal.
       *
       * There was a third branch here that read a login name instead of an address, which is how
       * somebody signed in with whichever of the two they remembered. The identity provider has no
       * username, so that branch would now be a call to an endpoint that answers 404 — and it would
       * fail on somebody who has typed a correct username, which is the worst possible moment to
       * discover the field was never going to work. Refused here, with a reason, instead.
       */
      const email = identifier.trim();
      if (!email.includes("@")) {
        throw new Error("Enter the email address you signed up with.");
      }
      if (mode === "up") {
        if (password !== confirmPassword) {
          throw new Error("Passwords do not match.");
        }
        const created = await authClient.signUp.email({
          name: email,
          email,
          password,
        });
        if (created.error) throw new Error(created.error.message);
      } else {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) throw new Error(result.error.message);
      }
      // The session cookie is set by the response above. The authed gate reads the user
      // query, which still holds the pre-sign-in null — invalidate first so the landing page
      // does not bounce straight back here.
      await queryClient.invalidateQueries({ queryKey: ["auth"] });
      // A full navigation, not the router's: the fresh document boots authed on the session
      // cookie with no stale cache to argue with.
      window.location.assign("/");
    } catch (caughtError) {
      onError(
        caughtError instanceof Error
          ? caughtError.message
          : "Could not sign in.",
      );
    } finally {
      setWorking(false);
    }
  }

  const tab = (id: "in" | "up", label: string) => (
    <button
      id={`sign-${id}`}
      role="tab"
      aria-selected={mode === id}
      className={`flex-1 rounded-md px-3 py-1.5 text-sm tracking-tight transition-colors ${
        mode === id
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      }`}
      disabled={busy || working}
      onClick={() => setMode(id)}
      type="button"
    >
      {label}
    </button>
  );

  return (
    <div className="mb-4">
      <div
        aria-label="Account access"
        className="mb-3 flex rounded-lg bg-muted p-1"
        role="tablist"
      >
        {tab("in", "Sign in")}
        {tab("up", "Sign up")}
      </div>
      <form
        aria-labelledby={`sign-${mode}`}
        className="flex flex-col gap-2"
        onSubmit={submit}
        role="tabpanel"
      >
        <Input
          className="h-10"
          autoComplete="email"
          disabled={busy || working}
          onChange={(event) => setIdentifier(event.target.value)}
          placeholder="Email"
          required
          type="email"
          value={identifier}
        />
        <Input
          className="h-10"
          autoComplete={mode === "up" ? "new-password" : "current-password"}
          disabled={busy || working}
          minLength={8}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password (8+ characters)"
          required
          type="password"
          value={password}
        />
        {mode === "up" ? (
          <Input
            className="h-10"
            autoComplete="new-password"
            disabled={busy || working}
            minLength={8}
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder="Confirm password"
            required
            type="password"
            value={confirmPassword}
          />
        ) : null}
        <Button
          className="w-full tracking-tight"
          disabled={
            busy ||
            working ||
            identifier.trim().length === 0 ||
            password.length === 0 ||
            (mode === "up" && password !== confirmPassword)
          }
          size="lg"
          type="submit"
        >
          {working
            ? mode === "up"
              ? "Creating account…"
              : "Signing in…"
            : mode === "up"
              ? "Create account"
              : "Sign in"}
        </Button>
      </form>
    </div>
  );
}

function SignScreen() {
  // Which provider is being opened, rather than whether one is: with more than one button, a single
  // boolean would put "Opening…" on all of them.
  const [opening, setOpening] = useState<AuthProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: options } = useQuery(authProvidersQueryOptions());
  const providers = options?.providers ?? [];

  async function handleSignIn(provider: AuthProviderId) {
    setError(null);
    setOpening(provider);

    try {
      await signInWith(provider);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : `Could not start ${providerName(provider)} sign-in.`,
      );
      setOpening(null);
    }
  }

  const prefersReducedMotion = useReducedMotion();
  const hidden = {
    opacity: 0,
    ...(prefersReducedMotion ? {} : { transform: ENTRANCE_OFFSET }),
  };
  const shown = {
    opacity: 1,
    ...(prefersReducedMotion ? {} : { transform: "translateY(0px)" }),
  };

  return (
    <div className="flex min-h-dvh w-full items-center justify-center overflow-y-auto px-4 py-8">
      <motion.div
        animate="shown"
        className="flex-1 flex w-full max-w-82 flex-col items-center justify-center p-4"
        initial="hidden"
        variants={{
          hidden: {},
          shown: { transition: { staggerChildren: ENTRANCE_STAGGER_SECONDS } },
        }}
      >
        <motion.div
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
          className="flex items-center justify-center"
        >
          <AgentOrb size="56px" />
        </motion.div>
        <motion.h1
          className="text-2xl font-medium tracking-tight text-center mt-8"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          Sign in to {appConfig.brand.productName}
        </motion.h1>
        <motion.div
          className="mt-8 w-full"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          {options?.emailPassword ? (
            <EmailPasswordForm busy={opening !== null} onError={setError} />
          ) : null}
          {providers.length > 0 ? (
            <div className="flex flex-col gap-2">
              {providers.map((provider) => (
                /*
                 * Every provider gets the same button, and it is the light-themed outline one
                 * rather than the app's filled primary. Google's guidelines require their button be
                 * at least as prominent as any other sign-in option and specify its fill and
                 * stroke, so making one provider the loud one would break that for the others. The
                 * same size and weight throughout is also the honest presentation: a deployment
                 * that configured three has three, and none of them is the recommended one.
                 */
                <Button
                  className="w-full justify-start gap-3 px-3 tracking-tight"
                  disabled={opening !== null}
                  key={provider}
                  onClick={() => handleSignIn(provider)}
                  size="lg"
                  variant="outline"
                >
                  <ProviderLogo data-icon="inline-start" provider={provider} />
                  {/* Centred against the button, not against the space left of the mark. */}
                  <span className="flex-1 text-center">
                    {opening === provider
                      ? `Opening ${providerName(provider)}…`
                      : `Continue with ${providerName(provider)}`}
                  </span>
                  {/* Balances the mark so the label sits in the middle of the button. */}
                  <span aria-hidden="true" className="size-[18px]" />
                </Button>
              ))}
            </div>
          ) : options?.sso || options?.emailPassword ? null : (
            <p className="text-center text-sm text-muted-foreground">
              No sign-in provider is configured for this deployment.
            </p>
          )}
          {error ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </motion.div>
      </motion.div>
    </div>
  );
}
