import type { Hono } from "hono";
import type { AgentProfileStore } from "../../src/agents/profile-store";
import { createApp, type DeploymentConfig } from "../../src/app";
import type { AppVariables, AuthService } from "../../src/auth/guards";
import type { IdentityProviderStore } from "../../src/auth/identity-provider-store";
import type { ChannelEventHub } from "../../src/channels/events";
import type { ChannelStore } from "../../src/channels/routes";
import type { ThreadIdentity } from "../../src/channels/thread-identity";
import type { SandboxedStore } from "../../src/components/sandboxed";
import type { ComponentStore } from "../../src/components/store";
import type { ComputerGateway } from "../../src/computer/gateway";
import type { PolicyStore } from "../../src/computer/policy-store";
import { loadConfig } from "../../src/config";
import type { ExecutionModeStore } from "../../src/execution-mode";
import type { OnboardingStore } from "../../src/people/onboarding";
import type { PluginStore } from "../../src/plugins/store";
import type { RoutineRunner } from "../../src/routines/runner";
import type { RoutineStore } from "../../src/routines/store";
import type { UserInstructionsStore } from "../../src/user-instructions";
import { testEnvironment } from "./environment";

/**
 * `createApp` for a route test, addressed BY NAME.
 *
 * WHY THIS EXISTS. `createApp` takes thirty-five positional parameters and every one from the third
 * onwards is optional, which means a test that reaches the store it cares about by counting `undefined`
 * holes passes `tsc` whatever count it uses and fails at runtime with a 503 or a 404 that says nothing
 * about why. Nineteen test files were doing exactly that, and the counts had drifted as the signature
 * grew: a test written against position 24 for `onboardingStore` still asked for 24 after the
 * parameter moved to 22, and the store landed in `intentRouter` instead.
 *
 * The fix is not more careful counting. It is naming: this helper takes the collaborators a test
 * actually provides as an object, and fills every position from the real signature. A parameter added
 * to `createApp` tomorrow shifts nothing here, because the holes are computed rather than counted.
 *
 * The signature below is derived from `createApp`'s own parameters and asserted against it by
 * `app-helper.test.ts`, so a rename in `app.ts` fails a test rather than silently landing a store in
 * the wrong slot.
 */

/** The members of `createApp`'s signature, keyed by parameter name. */
export type TestAppParts = {
  auditReader?: unknown;
  auditStore?: AuditStore;
  agentProfileStore?: AgentProfileStore;
  attachmentDatabase?: unknown;
  channelEvents?: ChannelEventHub;
  channelStore?: ChannelStore;
  componentStore?: ComponentStore;
  computerGateway?: ComputerGateway;
  computerPolicy?: PolicyStore;
  composio?: { broker: unknown };
  copilotHandler?: unknown;
  cronTick?: unknown;
  deploymentToolCaller?: unknown;
  executionModes?: ExecutionModeStore;
  hostAccessBroker?: unknown;
  identityProviders?: IdentityProviderStore;
  intentRouter?: unknown;
  onboardingStore?: OnboardingStore;
  pageFrames?: unknown;
  pluginStore?: PluginStore;
  routineRunner?: RoutineRunner;
  routineStore?: RoutineStore;
  sandboxedStore?: SandboxedStore;
  telegram?: { token?: string; username?: string };
  telegramIncoming?: unknown;
  threadIdentity?: ThreadIdentity;
  triggerIncoming?: unknown;
  userInstructions?: UserInstructionsStore;
  vaultStore?: unknown;
};

/**
 * `createApp`'s parameters, in order, minus the two no route test provides.
 *
 * Kept as a literal list because it has to line up with the signature, and exported so
 * `app-helper.test.ts` can assert that it does — that test is the only thing standing between this
 * list and thirty-five slots of silence.
 *
 * The names here are the test's own, which is why `_credentialService` and `_packageStatusReader`
 * lose their underscore: the signature uses it to say "this exists but the body does not read it", and
 * a test has no reason to inherit that. A test CAN pass either of them, though, so both stay in the
 * list rather than being omitted — a store that turns out to be reachable per-request is a store the
 * helper should already have a slot for.
 *
 * `_blobStore` is the one omission: it is the object store, load-bearing only at boot. Its hole is in
 * {@link PARAMETER_NAMES} below, which is the list the call is actually built from.
 */
export const POSITIONS = [
  "config",
  "auth",
  "auditReader",
  "credentialService",
  "packageStatusReader",
  "copilotHandler",
  "computerGateway",
  "computerPolicy",
  "agentProfileStore",
  "channelStore",
  "channelEvents",
  "auditStore",
  "componentStore",
  "pluginStore",
  "sandboxedStore",
  "threadIdentity",
  "identityProviders",
  "intentRouter",
  "pageFrames",
  "routineRunner",
  "routineStore",
  "onboardingStore",
  "userInstructions",
  "attachmentDatabase",
  "hostAccessBroker",
  "desktopHostToken",
  "deploymentToolCaller",
  "composio",
  "cronTick",
  "telegramIncoming",
  "telegram",
  "executionModes",
  "triggerIncoming",
  "vaultStore",
] as const;

/**
 * The call, in signature order.
 *
 * {@link POSITIONS} with the underscores restored and `_blobStore` put back where it belongs. This is
 * the list `createApp` is spread from, so a hole here is a hole in the call rather than a store in
 * somebody else's slot.
 */
const PARAMETER_NAMES: string[] = POSITIONS.map((name) => {
  if (name === "credentialService") return "_credentialService";
  if (name === "packageStatusReader") return "_packageStatusReader";
  // `_blobStore` sits immediately BEFORE `vaultStore` in the signature, so the hole goes here rather
  // than at the end — and that is exactly the kind of thing a hand-counted hole gets wrong.
  return name;
}).flatMap((name) => (name === "vaultStore" ? ["_blobStore", name] : [name]));

/**
 * The session a test is signed in as, which is what makes every route on the app answer as somebody.
 *
 * `as` overrides it for the tests whose subject is "somebody else asks".
 */
export function testSession(user: {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
}): AuthService {
  return {
    handler: () => new Response(null, { status: 204 }),
    api: { getSession: async () => ({ user }) },
  } as never;
}

export function createTestApp(
  options: {
    /** The signed-in person. Defaults to `member-1`, the name most of these tests already use. */
    as?: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
    };
    /**
     * Nobody is signed in, which is how the tests that assert a refusal produce one.
     *
     * A flag rather than an `as: null`, because `as` carries a person and this carries their absence —
     * and a caller passing `as: null` by accident would otherwise get a session for nobody.
     */
    signedOut?: boolean;
    /**
     * The session, read on every request rather than captured once.
     *
     * For the tests whose subject IS the session: signing in and signing out again mid-test, or
     * answering as one person and then another. `as` cannot express that, because the auth service is
     * built once and the tests that need it change what it returns between calls.
     */
    session?: () => {
      user: {
        id: string;
        email: string;
        name?: string | null;
        image?: string | null;
      };
    } | null;
    /** Overrides the deployment config; the environment otherwise comes from `testEnvironment()`. */
    config?: DeploymentConfig;
    parts?: TestAppParts;
  } = {},
): Hono<{ Variables: AppVariables }> {
  const person = options.as ?? {
    id: "member-1",
    email: "member@remii.test",
    name: "A Member",
    image: null,
  };

  const parts = options.parts ?? {};
  const byName: Record<string, unknown> = {
    config: options.config ?? loadConfig(testEnvironment()),
    auth: sessionService(options, person),
    ...parts,
  };

  // Every position filled, in signature order, so a parameter added to `createApp` cannot shift one.
  const args = PARAMETER_NAMES.map((name) => byName[name]);
  return (
    createApp as (...values: unknown[]) => Hono<{ Variables: AppVariables }>
  )(...args);
}

/**
 * The auth service a test runs behind, chosen by whichever of the three answers it gave.
 *
 * `session` wins over `signedOut` over `as`, and the order is the point: a caller that reaches for a
 * dynamic session is asking for something the other two cannot express, so honouring the default
 * instead would silently ignore it.
 */
function sessionService(
  options: {
    signedOut?: boolean;
    session?: () => {
      user: {
        id: string;
        email: string;
        name?: string | null;
        image?: string | null;
      };
    } | null;
  },
  person: {
    id: string;
    email: string;
    name?: string | null;
    image?: string | null;
  },
): AuthService {
  if (options.session) {
    return {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => options.session!() },
    } as never;
  }
  if (options.signedOut) {
    return {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => null },
    } as never;
  }
  return testSession(person);
}

/**
 * A route test's request helper, which is what most of these tests actually wanted.
 *
 * Every failing test spelled `app.request("http://remii.test" + path, init)` by hand, and one of
 * them spelled the host differently — which is invisible until a redirect or a cookie comparison
 * cares. One helper, one host.
 */
export function testRequest(
  app: Hono<{ Variables: AppVariables }>,
): (path: string, init?: RequestInit) => Promise<Response> {
  return (path, init) => app.request(`http://remii.test${path}`, init);
}
