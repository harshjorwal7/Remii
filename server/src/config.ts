/**
 * What the runtime can do. Threads, messages, runs and locks live in this
 * deployment's own Postgres (see threads/local): nothing cloud to configure,
 * so there is no boot contract here at all.
 */

import { join } from "node:path";
import { singleUserEnabled } from "./auth/dev-actor";
import type { ActionPolicy } from "./computer/policy";
import { parseActionPolicy } from "./computer/policy-store";

export type RuntimeCapabilities = {
  mode: "local";
  durableHistory: true;
};

export type DockerComputerConfig = {
  provider: "docker";
  baseUrl: string;
  supervisorToken?: string;
  token?: string;
  allowPrivateHosts: boolean;
  policy?: ActionPolicy;
};

export type SharedComputerConfig = {
  provider: "shared";
  baseUrl: string;
  token?: string;
  allowPrivateHosts: boolean;
  policy?: ActionPolicy;
  /**
   * Whether this deployment can serve more than one person.
   *
   * The gate on a shared computer, and the reason it is a fact rather than a setting. Bots are kept
   * apart from each other by a per-Bot profile, a per-Bot workspace and a Bot id the computer
   * verifies; PEOPLE are not, so one computer is safe for one person and unsafe for two. Carried
   * here so `createComputerProvider` can refuse the multi-user case without reaching back into the
   * environment.
   */
  singleUser: boolean;
  /**
   * The operator has said this deployment serves one person, and wants one machine.
   *
   * Not inferred from the user count, which is a snapshot that a sign-up would invalidate, and not
   * inferred from the absence of sign-in, because a real account is how a person keeps their own
   * history. It is stated, and the refusal is the default, because what it asserts is a fact about
   * the world outside the software: that nobody else will ever be added to this deployment.
   *
   * False or unset keeps a shared computer refused, so nothing changes for anyone who has not
   * deliberately asked for this.
   */
  sharedSingleTenant: boolean;
};

/**
 * A computer each, created by the cluster.
 *
 * The namespace is the whole scope: the service account this runs under may manage Sandboxes there
 * and nowhere else, which is a smaller blast radius than the Docker supervisor's, since that one
 * holds a socket that is root-equivalent on its host.
 */
export type SandboxComputerConfig = {
  provider: "sandbox";
  namespace: string;
  idleAfterMs: number;
  /** Where the chart mounted the shape of a computer. */
  templateFile: string;
  token?: string;
  allowPrivateHosts: boolean;
  policy?: ActionPolicy;
};

/**
 * The hosted desktop, on E2B: one desktop per person.
 *
 * One sandbox per PERSON rather than per Bot, and that is the whole tenancy model — a computer
 * outlives every conversation and belongs to the person, while the Bot driving it is whichever one
 * holds the wheel. Billing follows the person, which is what makes a flat monthly price honest.
 *
 * The template is E2B's own `desktop`, which carries Xvfb, XFCE, x11vnc, noVNC, xdotool, scrot,
 * ffmpeg, Chrome and Python — everything the desktop and the tools need, with nothing added to it.
 *
 * Pause, not delete, is the idle policy: a memory pause restores the desktop exactly as it was and
 * comes back in seconds. Full internet egress, which free-tier Daytona did not have.
 */
export type E2BComputerConfig = {
  provider: "e2b";
  apiKey: string;
  /** E2B's API root. Optional — E2B's own default is correct for the hosted product. */
  apiUrl?: string;
  /** The template every desktop is built from. */
  template: string;
  /**
   * The port the agent-computer service listens on inside the sandbox.
   *
   * Unused on this path — there is no agent-computer service in an E2B desktop, because the server
   * drives the machine directly through E2B's own API — but it is kept and validated so an existing
   * `.env` carrying it does not fail a deployment on a variable nothing reads any more.
   */
  computerPort: number;
  /** Idle minutes before a desktop is paused. 0 never pauses it. */
  autoStopMinutes: number;
  /**
   * Whether each person's files live on their own E2B volume.
   *
   * On by default, and this is the persistence question in one boolean: a volume survives the sandbox
   * being paused, killed or replaced, and sandbox disk does not survive the sandbox being deleted.
   */
  volumes: boolean;
  /** Where the volume appears inside the sandbox. Must be what a tool's relative paths resolve to. */
  workspaceMountPath: string;
  token?: string;
  allowPrivateHosts: boolean;
  policy?: ActionPolicy;
};

export type ComputerConfig =
  | DockerComputerConfig
  | SharedComputerConfig
  | SandboxComputerConfig
  | E2BComputerConfig;

/**
 * Who a deployment lets in, and through which front door.
 *
 * These are the ids the identity provider admits. Microsoft and Okta are gone because this product
 * serves individuals directly rather than companies behind a directory, and the provider offers no
 * route to either — `MICROSOFT_OAUTH_*` and `OKTA_OAUTH_*` are no longer read, and configuring them
 * has no effect rather than a partial one.
 */
export type AuthProviderId = "google" | "github" | "vercel";

export type TurnstileConfig = {
  secretKey: string;
  siteKey?: string;
};

export type AuthConfig = {
  /**
   * The Managed Better Auth endpoint that is this deployment's identity provider.
   *
   * Replaces the `baseUrl`/`secret`/`trustedOrigins`/per-provider-client fields this type used to
   * carry. Those were all inputs to a Better Auth instance running inside this process; a hosted
   * provider holds the client secrets and the session secret on its own side, so there is nothing
   * left to configure here beyond where to reach it and what to call ourselves.
   */
  neonAuthUrl: string;
  /**
   * This deployment's own public address, sent as `Origin` on every call to the provider.
   *
   * The provider answers CORS from an allowlist it keeps per branch, and an origin missing from it is
   * refused — so this is not decoration. See `auth/neon.ts`.
   */
  origin: string;
  /**
   * The social providers this deployment offers, as the provider spells them.
   *
   * Read from `neon_auth.project_config` rather than configured, because the provider decides what
   * it will accept and a list written here would be a second thing to keep in step with it. Neon
   * Auth admits `google`, `github` and `vercel`; nothing else reaches it, which is why there is no
   * Microsoft, Okta or company-SSO path left in this product.
   */
  socialProviders: AuthProviderId[];
  /**
   * Whether `NEON_AUTH_PROVIDERS` was set, as distinct from what it was set to.
   *
   * Present because the branch's own provider configuration is read at start-up and written back over
   * `socialProviders`, and that is right for everything except this: a deployment that has said
   * `none` must keep saying it. Without a flag saying the value was chosen rather than defaulted, an
   * explicit `none` is indistinguishable from a default and gets overwritten, so the setting appears to
   * do nothing.
   */
  socialProvidersOverridden: boolean;
  /**
   * Whether the provider requires a verified address before the account is usable.
   *
   * The provider's own answer, read out of `neon_auth.project_config`, and it decides one thing:
   * whether a computer may be driven by somebody whose address is not verified. It is on this type
   * rather than read at the one place it is used because reading a database row from inside a route
   * middleware is a per-request query for an answer that changes when an administrator changes it,
   * not per request.
   */
  emailVerificationRequired?: boolean;
  emailPassword?: boolean;
  turnstile?: TurnstileConfig;
};

/**
 * The providers this deployment can actually sign somebody in with.
 *
 * The provider's list, in its order. It used to be assembled here from whichever OAuth clients a
 * deployment had configured, which meant the sign-in screen's buttons were decided by this process;
 * now the provider decides, and this only reports what it was told.
 */
export function configuredAuthProviders(
  auth: AuthConfig | undefined,
): AuthProviderId[] {
  return auth ? [...auth.socialProviders] : [];
}

/** Whether anybody must sign in: an OAuth provider or email-plus-password is configured. */
export function hasIdentityProvider(auth: AuthConfig | undefined): boolean {
  return (
    configuredAuthProviders(auth).length > 0 || auth?.emailPassword === true
  );
}

export type ManagedAgentConfig = {
  /** The bundled Bot, absent when this deployment's provider cannot run it. */
  endpoint?: URL;
  /** Secret sent only to endpoints this deployment runs. Never stored in an agent row. */
  token: string;
  /**
   * The harness picked during setup, when there is one.
   *
   * Also an endpoint this deployment runs: its container was started by this deployment, on a port
   * it chose, holding this token. It gets the same header for the same reason.
   */
  alsoRun?: URL;
};

/**
 * How far one Bot handing work to another may go.
 *
 * NUMBERS A DEPLOYMENT CHOOSES, not constants. A small team and a company running this across
 * departments want different answers, and neither should have to edit code to get one.
 *
 * Both defaults are deliberately mean. A hop costs a whole agent turn at the other end, fan-out
 * shapes cost several times a single run because each Bot spends its own full budget, and on a
 * cluster a hop to a Bot whose computer is asleep also pays a pod resume. One level of delegation is
 * what most systems allow by default, and a deployment that wants more can say so.
 */
export type HandoffCaps = {
  /** How many Bots deep a chain may go. `0` switches the whole capability off. */
  maxDepth: number;
  /** How many other Bots one run may address. */
  maxPerRun: number;
};

/**
 * Whether a Bot acts directly or asks first, as a deployment default.
 *
 * A closed set on purpose: anything else in the variable is a start-up error rather than a
 * silent default, because a deployment that typed `auto` and got `direct` would believe it had
 * configured something it had not.
 */
export type ExecutionMode = "direct" | "ask-first";

export function parseExecutionMode(
  raw: string | undefined,
): ExecutionMode | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "direct" || value === "ask-first") return value;
  throw new Error(`BOT_EXECUTION_MODE must be "direct" or "ask-first"`);
}

/** The deployment default, read from the environment. Direct, the Remi way. */
function executionMode(environment: Environment): ExecutionMode {
  return (
    parseExecutionMode(optional(environment, "BOT_EXECUTION_MODE")) ?? "direct"
  );
}

export type DeploymentConfig = {
  /** The port the API listens on. Named `PORT` or `SERVER_PORT`; see `serverPort`. */
  port: number;
  databaseUrl: string;
  /**
   * The connection that must NOT be pooled, for the work a pooler breaks.
   *
   * `LISTEN` and session-scoped advisory locks are both properties of one socket. A pooler is free
   * to hand the next query to a different backend session, so a notification lands on a connection
   * nobody is reading and a lock taken for a sweep is released by the pool before the sweep ends.
   * `activity/listen.ts`, `channels/events.ts`, `computer/policy-listener.ts` and `work/queue.ts`
   * therefore run on this one, and so do the two retention sweeps.
   *
   * Unset on a deployment that is not behind a pooler, which is every local one: the single URL is
   * then its own answer. A provider that offers only a pooled endpoint has nothing to put here,
   * which is worth knowing before trusting this to be set.
   */
  databaseUrlUnpooled: string;
  keyEncryptionKey: string;
  /**
   * Authentication for the bundled Bot and/or the installed picked harness.
   *
   * The bundled endpoint is optional: plan credentials can run a picked harness without it.
   * Its presence, not this auth configuration, determines whether a bundled Bot is available.
   */
  managedAgent?: ManagedAgentConfig;
  /**
   * What this deployment calls itself, when more than one shares an Intelligence project.
   *
   * Absent, the tenant package's id stands in, which separates deployments running different
   * packages but not a copy of one running alongside the original. See channels/thread-identity.ts.
   */
  deploymentId: string | undefined;
  /**
   * The key this deployment talks to Composio with, the broker that holds people's accounts for a
   * few hundred apps so a Bot can act in Gmail or Slack without an OAuth client of this
   * deployment's own registered with each of them.
   *
   * Optional, and undefined is the ordinary state rather than a degraded one. A deployment that has
   * not bought Composio is not a deployment missing something: there is nothing to connect, nothing
   * to grant and no Composio tool for a Bot to call, what remains on screen is one row that goes
   * nowhere on the App connections page naming this variable, and nothing else it does
   * is any worse for that.
   *
   * Nothing here validates the key. There is no shape to check it against and no call worth making
   * at boot to find out, so the first real request is what says whether it works — which is also
   * where a key that was revoked last week would have surfaced regardless.
   */
  composioApiKey: string | undefined;
  /**
   * Where this deployment is reached from outside, with no trailing slash.
   *
   * Needed because an OAuth redirect URI has to match what an administrator registered with the
   * vendor character for character, and it is shown on App connections for them to copy. Built from
   * configuration rather than from the incoming request: a redirect URI assembled out of a Host
   * header is one an attacker has a say in.
   *
   * `REMII_PUBLIC_URL` when set, otherwise `BETTER_AUTH_URL`, which is the same public address for
   * every deployment that has real sign-in. Undefined only where neither exists, which is a local
   * deployment running without authentication — and there is nothing to connect there anyway.
   */
  publicUrl: string | undefined;
  /**
   * Where the browser app is served from, with no trailing slash.
   *
   * Separate from {@link DeploymentConfig.publicUrl} because they are genuinely two addresses: the
   * app is a Vite process on its own port locally, and the API is another. An OAuth callback lands on
   * the API and has to send the person back to a page, so a relative redirect would put them on the
   * API's origin, where no page exists.
   *
   * `REMII_APP_URL` when set, otherwise the first `TRUSTED_ORIGINS` entry, which is already defined
   * as where the app is served from. Falls back to the API's own public URL, which is right for a
   * deployment serving both from one origin.
   */
  appUrl: string | undefined;
  tenantPackageDirectory: string;
  runtime: RuntimeCapabilities;
  /**
   * How long a Bot's stream may say nothing before this deployment ends the turn, in milliseconds.
   *
   * Zero means no watchdog, and an unset variable means zero. A turn that is ended is a turn
   * somebody loses, so a deployment that has not said it wants that gets the behaviour it already
   * had. `.env.example` ships a value, so a new clone starts with the watch on and an upgraded
   * deployment does not acquire it without being asked.
   */
  agentStallTimeoutMs: number;
  /**
   * How many days of audit trail this deployment keeps, or undefined to keep everything.
   *
   * Undefined by default. Deleting somebody's audit trail because a default said so is the worse of
   * the two failures, and a deployment that has not thought about retention should keep everything
   * until it has.
   */
  auditRetentionDays: number | undefined;
  /**
   * How long a finished run stays in `run_activity`, in days.
   *
   * BOUNDED BY DEFAULT, unlike the audit trail beside it, and the difference is the subject. The
   * audit trail is what an incident is looked up in, so keeping it forever is a decision somebody
   * makes. `run_activity` answers one question — what is working right now — and a person answers it
   * in the roster they are looking at. Rows past that horizon are what the table is asked for by
   * nobody, and a table nobody reads is still a table somebody pays to store.
   */
  activityRetentionDays: number;
  /*
   * Sign-in for this product's own integrations, as distinct from `auth` above.
   *
   * Was `oauth.google`, the client this process used to hold for sign-in. That credential belongs to
   * the identity provider now, so the field is gone with its only consumer. It is kept as an empty
   * object rather than removed because `DeploymentConfig` is spread into fixtures across the test
   * suite and deleting a required key would touch every one of them for no gain.
   */
  oauth: Record<string, never>;
  auth?: AuthConfig;
  /**
   * Admit everybody as one fixed administrator instead of requiring sign-in.
   *
   * True only when no identity provider is configured. See auth/dev-actor.ts for what stops this
   * reaching somewhere other people can get to.
   */
  singleUser: boolean;
  /** Names Remii on the analytics the runtime already sends. Off with REMII_ACCESSIBILITY_DISABLED. */
  accessibility: boolean;
  /**
   * Whether a Bot may answer with an interface it wrote itself.
   *
   * This is not the component catalogue. A component is something this deployment holds: it was
   * either compiled into the build or authored in the playground, an administrator granted it to a
   * Bot, and all a Bot decides is which of them to draw. Here there is nothing to grant, because
   * there is nothing yet — the Bot writes the markup, the styles and the script for this one answer,
   * and they are gone when the conversation moves on.
   *
   * A deployment switch rather than a per-Bot grant because the SDK offers no seam for one. The
   * interface is painted from activity events that only the runtime middleware emits, and the tool
   * the model calls is registered by the browser for every Bot the moment that middleware is on.
   * Narrowing the middleware to some Bots would leave the rest able to call the tool and draw
   * nothing at all, which is a worse answer than never offering it.
   *
   * On by default. A deployment that cannot allow generated interfaces can explicitly opt out with
   * REMII_GENERATIVE_UI=false or REMII_GENERATIVE_UI=0.
   *
   * What it runs is sandboxed by the SDK, in an iframe with no same-origin access to this app, so a
   * generated interface reaches this deployment's data only through what the host hands it. This
   * deployment hands it nothing. It can load libraries from a CDN, which is the part a deployment
   * that must not reach the public internet from a browser tab needs to weigh.
   */
  generativeUi: boolean;
  /**
   * Where the built app is, when this process serves it.
   *
   * Set in a container image that carries both. Unset in development, where Vite serves the app and
   * proxies the API here, so the server stays an API and nothing shadows a route.
   */
  appDistDir?: string;
  /**
   * The Bot computer. Absent means the feature is off and its routes are not mounted, rather than
   * mounted and failing: a capability that is not configured should be missing, not broken.
   */
  computer?: ComputerConfig;
  /** Where saved files' bytes live. See `storageConfig`. */
  storage?: StorageConfig;
  /** How far one Bot handing work to another may go. */
  handoff: HandoffCaps;
  /**
   * How a Bot acts on the person's behalf, deployment-wide unless they chose otherwise.
   *
   * `direct` means the Remi way: do what was asked, immediately, with the tools held. `ask-first`
   * means external, side-effecting actions wait for the person's word via `ask_person` first.
   * Internal work (reading, organizing, remembering, answering) is never gated either way: the
   * switch is about effects on the world, not about thinking. A person overrides this for
   * themselves on the General settings screen.
   */
  executionMode: ExecutionMode;
  /**
   * The secret a Bot presents when it calls a tool back through this server.
   *
   * A framework Bot runs its own tool loop, in its own process, which is what makes it a real
   * harness rather than a shape the browser drives. It still may not reach a vendor directly: it
   * calls here, and here is where the grant, the policy and the audit row are. This is what tells
   * that call apart from anybody else on the network.
   *
   * Absent means no Bot may call tools back, and a deployment that wanted them gets a refusal rather
   * than an open door.
   */
  agentToolToken?: string;
  /**
   * The secret the worker presents when it hands a routine run back to this server.
   *
   * Absent means the internal routines endpoint refuses everything, which is the correct state of a
   * deployment with no worker — a deployment that has not asked for scheduled turns should not have a
   * door for them standing open.
   */
  workerSharedSecret?: string;
};

type Environment = Record<string, string | undefined>;

/**
 * The caps, read from the environment, refusing anything that is not a whole number at least zero.
 *
 * Refused rather than coerced. A cap is a safety number, and a deployment that typed `two` and got
 * the default would believe it had set one: the failure has to be at start-up where somebody is
 * looking, not at the first loop.
 */
function handoffCaps(environment: Environment): HandoffCaps {
  const read = (name: string, fallback: number): number => {
    const raw = optional(environment, name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a whole number of zero or more`);
    }
    return value;
  };
  return {
    /*
     * Two levels, which is a chain of three: an orchestrator, the specialist it delegates to, and
     * whoever that specialist delegates to.
     *
     * ONE WAS NOT A POLICY, IT WAS A CEILING, AND IT LANDED ON A REAL WORKFLOW. At one, the only
     * shape that worked was a single hop — an orchestrator handing to a specialist. The second hop
     * was refused with "this is already 1 Bot deep", so a chief of staff who delegated research to
     * a researcher who was supposed to hand the report to a mail owner could not: the researcher was
     * already at the bottom. The wiring was all correct and the arithmetic stopped it, which reads
     * from the conversation as the supervisor not supervising and the chain being broken rather than
     * capped.
     *
     * Two is the smallest value that lets a report be gathered by one Bot and delivered by another,
     * which is the shape almost every delegation is actually in. It is still a hard bound — this is
     * also what stops A asks B asks C asks A — and every hop is still granted, audited and capped by
     * `maxPerRun`.
     */
    maxDepth: read("BOT_HANDOFF_MAX_DEPTH", 2),
    maxPerRun: read("BOT_HANDOFF_MAX_PER_RUN", 3),
  };
}

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

/**
 * Read one setting, by its current name and by the one it had before the rebrand.
 *
 * `REMII_*` is what the code asks for from here and what a fresh `.env` writes. `OPENBOT_*` is what
 * every deployment already has on disk, and a rename that read only the new name would leave each of
 * them running on built-in defaults without saying so — the exact failure this file exists to refuse,
 * arrived at quietly. The new name wins when both are set, so a deployment can add `REMII_*` next to
 * its existing `OPENBOT_*` and move one variable at a time rather than in one restart.
 *
 * An empty value counts as unset for both names, matching the behaviour above: `REMII_FOO=` is a
 * deployment that has not chosen, not one that has chosen the old name's value.
 */
function optional(environment: Environment, name: string): string | undefined {
  const read = (key: string): string | undefined =>
    environment[key]?.trim() || undefined;
  const value = read(name);
  if (value !== undefined) return value;
  return name.startsWith("REMII_")
    ? read(`OPENBOT_${name.slice("REMII_".length)}`)
    : undefined;
}

/**
 * Whether this deployment says it is in production, which is what the two hard refusals turn on.
 *
 * ONE PLACE, BECAUSE THE TWO GATES DID NOT AGREE. Both refuse a local-only setting on a deployed
 * server — the example encryption key, and private-host browsing — and both compare `NODE_ENV`
 * against `"production"`. The private-hosts gate read it through `optional`, so the comparison
 * trimmed; the key gate compared `environment.NODE_ENV` raw.
 *
 * Both sides of that comparison come out of the same file. `NODE_ENV=production ` with a trailing
 * space — invisible in an env file, and preserved verbatim by Docker's `env_file` and by every
 * hosting dashboard with a text box — therefore tripped one refusal and slipped past the other. The
 * one it slipped past is the one that decides whether the credential vault may be encrypted with a
 * key printed in this repository.
 *
 * A helper rather than a second `optional` call, so the next gate that needs this question cannot
 * pick the wrong way to ask it.
 */
function isProduction(environment: Environment): boolean {
  return optional(environment, "NODE_ENV") === "production";
}

/**
 * The key in `.env.example`, which every clone of this repository starts with.
 *
 * It is a valid key, which is the whole problem: it is the right length and the right encoding, so
 * nothing about it fails a check. A deployment that never changed it encrypts its credential vault
 * with a key printed in a public repository, and looks exactly like one that did.
 */
const PLACEHOLDER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function keyEncryptionKey(environment: Environment): string {
  const value = required(environment, "KEY_ENCRYPTION_KEY");
  const decoded = Buffer.from(value, "base64");

  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error("KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }

  /**
   * Refused in production, warned everywhere else. The placeholder is convenient locally and public
   * in any deployment.
   */
  if (value === PLACEHOLDER_KEY) {
    if (isProduction(environment)) {
      throw new Error(
        "KEY_ENCRYPTION_KEY is still the example key from .env.example, which is public. Generate one with: openssl rand -base64 32",
      );
    }
    console.warn(
      "KEY_ENCRYPTION_KEY is the example key from .env.example, which is public. Fine locally. Generate a real one before deploying: openssl rand -base64 32",
    );
  }

  return value;
}

function url(environment: Environment, name: string): string | undefined {
  const value = optional(environment, name);
  if (!value) {
    return undefined;
  }

  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  return value;
}

function optionalHttpUrl(
  environment: Environment,
  name: string,
): URL | undefined {
  const value = optional(environment, name);
  if (!value) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  return parsed;
}

/**
 * The Bot in the box, if this deployment has one.
 *
 * A URL with no token would send unauthenticated calls to a Bot that refuses them, so that half
 * alone refuses to start. A token with no URL is the leftover `scripts/start.sh` writes into
 * `.env`; it names nothing and is ignored, so a one-container image can boot from that file.
 */
function managedAgentConfig(
  environment: Environment,
): ManagedAgentConfig | undefined {
  const endpoint = optionalHttpUrl(environment, "MANAGED_AGENT_AG_UI_URL");
  // BYO writes a URL too, but does not run our image or hold our deployment token.
  const alsoRun = optional(environment, "PICKED_HARNESS_IMAGE")
    ? optionalHttpUrl(environment, "PICKED_HARNESS_URL")
    : undefined;
  const token = optional(environment, "MANAGED_AGENT_TOKEN");
  if (endpoint && !token) {
    throw new Error(
      "MANAGED_AGENT_TOKEN must be set when MANAGED_AGENT_AG_UI_URL is set",
    );
  }
  if (alsoRun && !token) {
    throw new Error(
      "MANAGED_AGENT_TOKEN must be set when an installed PICKED_HARNESS_URL is set",
    );
  }
  if ((!endpoint && !alsoRun) || !token) {
    return undefined;
  }
  /*
   * The harness somebody picked during setup is also an endpoint this deployment runs.
   *
   * It is a container this deployment started, on a port this deployment chose, holding the token
   * this deployment generated — the same relationship the Bot in the box has. It was not getting
   * the token because that was attached by matching one endpoint exactly, so the picked Bot was
   * registered, addressable, routed to, and answered every call with 401. Only visible by asking it
   * something in the window.
   */
  return {
    ...(endpoint ? { endpoint } : {}),
    token,
    ...(alsoRun ? { alsoRun } : {}),
  };
}

function commaSeparated(environment: Environment, name: string): string[] {
  return (optional(environment, name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Sign-in, if this deployment has an identity provider to sign people in with.
 *
 * `NEON_AUTH_BASE_URL` is the whole configuration now. The provider holds the OAuth clients, the
 * session secret and the trusted-origin allowlist on its own side, per branch, so a deployment that
 * set `GOOGLE_OAUTH_CLIENT_ID` here was writing a credential into a process that no longer reads it.
 *
 * `AUTH_EMAIL_PASSWORD` is still read, because it is a statement about the product rather than a
 * credential: it says whether the sign-in screen draws a password form. The provider's own setting
 * decides whether one would work, and `index.ts` overrides this from what the provider reports so
 * the form and the provider cannot disagree about whether one exists.
 */
function authConfig(environment: Environment): AuthConfig | undefined {
  const neonAuthUrl = optional(environment, "NEON_AUTH_BASE_URL");
  const emailPassword =
    environment.AUTH_EMAIL_PASSWORD?.trim() === "true" || undefined;

  if (!neonAuthUrl) {
    if (emailPassword) {
      throw new Error(
        "AUTH_EMAIL_PASSWORD is set but NEON_AUTH_BASE_URL is not. Sign-in needs the identity provider: run `neon deploy` with `auth: true` in neon.ts, or unset AUTH_EMAIL_PASSWORD to run without sign-in.",
      );
    }
    return undefined;
  }

  if (!/^https:\/\//.test(neonAuthUrl)) {
    throw new Error(
      "NEON_AUTH_BASE_URL must be an https:// address. The provider holds the session cookie as Secure, and a plain-HTTP endpoint cannot store it.",
    );
  }

  /*
   * Individual-user SaaS has no administrators: every account that can authenticate may sign in, and
   * its own data is the only thing it can reach. Retired, and refused rather than ignored now — the
   * old behaviour warned and carried on, which left a setting that looks live and is not.
   */
  if (commaSeparated(environment, "INITIAL_ADMIN_EMAILS").length > 0) {
    throw new Error(
      "INITIAL_ADMIN_EMAILS is set, but this deployment has no administrator role: every user is sovereign over their own data. Remove it from the environment.",
    );
  }

  /*
   * Which buttons to draw is the provider's answer, not ours.
   *
   * Read once in `index.ts` from `neon_auth.project_config` and written here, rather than this
   * function querying a database — `loadConfig` is synchronous and takes an environment, not a
   * pool. `NEON_AUTH_PROVIDERS` overrides it for a branch whose provider has none configured, which
   * is the one case where the default would be a lie.
   */
  /*
   * `NEON_AUTH_PROVIDERS=none` draws no social buttons at all, which is a real setting rather than a
   * trick.
   *
   * A social sign-in through this proxy does not finish: Google redirects to the provider's host, the
   * provider sets its cookie there, and this origin never sees it. A button that sends somebody there
   * and returns them to this same screen reads as a rejected account, which is worse than no button
   * because there is nothing on the page to say otherwise. `docs/deployment.md` writes down what would
   * have to change; until then this is how a deployment ships email and password without offering a
   * broken door.
   */
  const override = commaSeparated(environment, "NEON_AUTH_PROVIDERS");
  const noSocialProviders = override.length === 1 && override[0] === "none";
  const socialProviders = noSocialProviders
    ? []
    : override.length > 0
      ? override
      : ["google"];

  /*
   * The origin this deployment answers the provider with, which cannot be absent here.
   *
   * `publicOrigin` returns undefined for a deployment with no configured address, and that is what
   * lets `broker.ts` refuse to mint a connection link pointing at a machine that is not this one. It
   * cannot happen on this path: `NEON_AUTH_BASE_URL` is set by this point and `publicOrigin` answers
   * for exactly that reason. Refused rather than defaulted, because a wrong answer to "what origin
   * does the provider think I am" surfaces as a CORS failure on somebody's first sign-in rather than
   * as a type error here.
   */
  const origin = publicOrigin(environment);
  if (!origin) {
    throw new Error(
      "NEON_AUTH_BASE_URL is set but REMII_PUBLIC_URL is empty, so there is no origin to reach the identity provider with. Set REMII_PUBLIC_URL to the address this deployment is served from.",
    );
  }

  return {
    neonAuthUrl: neonAuthUrl.replace(/\/+$/, ""),
    origin,
    socialProvidersOverridden: override.length > 0,
    socialProviders: socialProviders.filter(
      (provider): provider is AuthProviderId =>
        provider === "google" || provider === "github" || provider === "vercel",
    ),
    ...(emailPassword ? { emailPassword } : {}),
  };
}

/**
 * This deployment's own address, which is what the provider is told the caller is.
 *
 * `REMII_PUBLIC_URL` when set. Otherwise the address the sign-in screen is served from in local
 * development — but only when there is an identity provider to be an origin for. The localhost default
 * is the app's dev port rather than the API's, because what the provider checks is the origin of the
 * page whose session is being read, and that is the page the browser loaded.
 *
 * UNDEFINED when there is no provider and nothing was configured, and that is deliberate rather than a
 * gap. An address that Composio sends somebody back to has to be one a browser can reach, and a
 * deployment with no configured address has none: answering with a localhost default would mint a
 * connection link pointing at a machine that is not this one, and the person who follows it lands
 * nowhere. `broker.ts` refuses that case, and this is what gives it something to refuse.
 */
function publicOrigin(environment: Environment): string | undefined {
  const configured = optional(environment, "REMII_PUBLIC_URL");
  if (configured) return configured.replace(/\/+$/, "");
  return optional(environment, "NEON_AUTH_BASE_URL")
    ? "http://localhost:3010"
    : undefined;
}

/**
 * The runtime runs locally: durable threads in Postgres, no cloud contract.
 *
 * The INTELLIGENCE_* variables of older deployments are ignored when
 * present, so an env file written for the hosted backend still boots rather
 * than failing on settings nothing reads anymore.
 */
function runtimeCapabilities(_environment: Environment): RuntimeCapabilities {
  return {
    mode: "local",
    durableHistory: true,
  };
}

/**
 * Whether a Bot may reach addresses inside this deployment's own network.
 *
 * Off unless asked for, and the asking is only allowed on a laptop. The switch exists so that a
 * local deployment can browse the services running beside it; what it turns off is not one rule but
 * the whole private-address floor, in navigation and in the endpoint a Bot may be registered
 * against, so with it on a signed-in person can point a Bot at a link-local address.
 *
 * Refused in production for the reason the example encryption key is: the way a deployment ends up
 * with it is not forgetting to set something, it is copying `.env.example`, which shipped it on. The
 * cloud metadata addresses are refused underneath this either way — see `computer/target.ts` — but
 * that floor is the last one, not the only one worth keeping.
 */
function privateHostsAllowed(environment: Environment): boolean {
  if (optional(environment, "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS") !== "true") {
    return false;
  }

  // Through `isProduction`, so the comparison trims. Read raw, `NODE_ENV="production "` out of an
  // env file would slip past a gate that the switch beside it, which does trim, would still trip.
  if (isProduction(environment)) {
    throw new Error(
      "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true is for local development only: it lets a Bot reach this deployment's own network. Remove it from this deployment's environment.",
    );
  }
  console.warn(
    "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true lets a Bot reach this machine's own services. Fine locally, and for local development only. Remove it before deploying.",
  );

  return true;
}

/**
 * A duration a person would write, as milliseconds.
 *
 * `30m` rather than `1800000`, because this one is read and edited by whoever is deciding how long a
 * computer may sit idle, and a wrong number of zeroes there is either a computer that never sleeps
 * or one that vanishes mid-task. Plain digits are still milliseconds, so anything already set keeps
 * its meaning.
 */
export function durationMs(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h)?$/i.exec(value.trim());
  if (!match) {
    throw new Error(
      `"${value}" is not a duration. Write it as 30s, 30m, 2h, or a plain number of milliseconds.`,
    );
  }
  const amount = Number(match[1]);
  switch (match[2]?.toLowerCase()) {
    case "h":
      return amount * 3_600_000;
    case "m":
      return amount * 60_000;
    case "s":
      return amount * 1_000;
    default:
      return amount;
  }
}

function computerConfig(
  environment: Environment,
  /**
   * Whether an identity provider is configured, so `singleUserEnabled` can be asked the same
   * question here as it is asked for the deployment itself. Passed rather than re-read, because the
   * two must not be able to disagree about whether this deployment has sign-in.
   */
  _hasIdentity: boolean,
): ComputerConfig | undefined {
  const e2bAddress = optional(environment, "E2B_API_KEY");
  const supervisorAddress = optional(environment, "COMPUTER_SUPERVISOR_URL");
  /*
   * Validated like every other provider's address, and this branch returns before the hosted ones
   * get a look — so without the check a typo would reach the provider and fail on the first request
   * instead of at startup. The other providers validate further down for the same reason.
   */
  const sharedAddress = url(environment, "AGENT_COMPUTER_URL");
  const sandboxNamespace = optional(environment, "COMPUTER_SANDBOX_NAMESPACE");
  if (
    !e2bAddress &&
    !supervisorAddress &&
    !sharedAddress &&
    !sandboxNamespace
  ) {
    return undefined;
  }

  /*
   * Strict per-user sandboxing: a shared fallback is refused up front.
   *
   * It used to be a resilience feature — a hosted sandbox that could not serve
   * fell back to the local computer and the turn carried on. That fallback is
   * user A inside user B's browser: one /workspace, one shell, one set of
   * logins, on a published port. So naming one stops startup, and the error
   * names the variable rather than surfacing later as somebody else's data.
   */
  if (sharedAddress && e2bAddress) {
    throw new Error(
      "AGENT_COMPUTER_URL is set alongside a hosted computer provider, which strict per-user sandboxing forbids: the shared computer is where a user's files, shell and logins would be mixed with every other user's whenever a sandbox could not serve. Unset AGENT_COMPUTER_URL and let the provider fail the turn instead.",
    );
  }

  /*
   * The secret the computers require. Without it every call to a computer is refused, and that is the
   * intended failure: `agent-computer` drives a browser holding real logins and must not answer
   * unauthenticated callers that can reach its port.
   */
  const computerToken = optional(environment, "COMPUTER_TOKEN");

  const allowPrivateHosts = privateHostsAllowed(environment);
  const policy = actionPolicy(environment);

  /*
   * E2B, and it comes FIRST among the hosted providers.
   *
   * There is only one now. This used to read "E2B first: a deployment that named an E2B key means E2B
   * makes the computers. Daytona below stays as a dormant alternative", which was a precedence rule
   * between two live options. With one option there is no precedence to get wrong, and a deployment
   * whose environment still names `DAYTONA_API_URL` finds it simply unused rather than half-honoured —
   * which is the outcome a stale variable should have, because acting on it would mean talking to a
   * platform this deployment no longer has a key for.
   *
   * The key is the whole trigger. No key means no computer at all, rather than a computer that exists
   * and cannot be reached.
   */
  if (e2bAddress) {
    const portRaw = optional(environment, "E2B_COMPUTER_PORT") ?? "4100";
    const computerPort = Number(portRaw);
    if (
      !Number.isInteger(computerPort) ||
      computerPort < 1 ||
      computerPort > 65535
    ) {
      throw new Error(
        `E2B_COMPUTER_PORT is "${portRaw}", which is not a port. Use 1-65535 or unset it for 4100.`,
      );
    }
    const autoStopRaw = optional(environment, "E2B_AUTOSTOP_MINUTES") ?? "10";
    const autoStopMinutes = Number(autoStopRaw);
    if (!Number.isFinite(autoStopMinutes) || autoStopMinutes < 0) {
      throw new Error(
        `E2B_AUTOSTOP_MINUTES is "${autoStopRaw}", which is not a non-negative number of minutes. Use 0 to keep desktops always on.`,
      );
    }
    return {
      provider: "e2b",
      apiKey: e2bAddress,
      ...(optional(environment, "E2B_API_URL")
        ? { apiUrl: optional(environment, "E2B_API_URL") }
        : {}),
      template: optional(environment, "E2B_TEMPLATE") || "desktop",
      computerPort,
      autoStopMinutes,
      // `false` has to be spelled out rather than defaulted, because `E2B_VOLUMES=false` and an unset
      // E2B_VOLUMES are different decisions and only one of them is a mistake. A typo stays ON: losing
      // somebody's files is the worse direction to be wrong in.
      volumes: optional(environment, "E2B_VOLUMES") !== "false",
      workspaceMountPath:
        optional(environment, "E2B_WORKSPACE_MOUNT") || "/workspace",
      allowPrivateHosts,
      ...(computerToken ? { token: computerToken } : {}),
      ...(policy ? { policy } : {}),
    };
  }

  if (sandboxNamespace) {
    return {
      provider: "sandbox",
      namespace: sandboxNamespace,
      idleAfterMs: durationMs(
        optional(environment, "COMPUTER_SANDBOX_IDLE_AFTER") ?? "30m",
      ),
      templateFile:
        optional(environment, "COMPUTER_SANDBOX_TEMPLATE_FILE") ??
        "/etc/remii/sandbox-template.json",
      allowPrivateHosts,
      ...(computerToken ? { token: computerToken } : {}),
      ...(policy ? { policy } : {}),
    };
  }

  const supervisorUrl = url(environment, "COMPUTER_SUPERVISOR_URL");
  if (supervisorUrl) {
    const supervisorToken = optional(environment, "SUPERVISOR_TOKEN");
    return {
      provider: "docker",
      baseUrl: supervisorUrl,
      allowPrivateHosts,
      ...(supervisorToken ? { supervisorToken } : {}),
      ...(computerToken ? { token: computerToken } : {}),
      ...(policy ? { policy } : {}),
    };
  }

  const baseUrl = url(environment, "AGENT_COMPUTER_URL");
  if (!baseUrl) {
    return undefined;
  }

  /*
   * Strict per-user sandboxing: a shared computer is refused, and named at the
   * variable rather than deep inside the provider factory.
   *
   * One shared computer means one /workspace, one shell and one browser
   * process for every user, which is the mixing this deployment refuses to
   * serve. The supervisor (one container per (user, Bot) pair) is the local
   * answer; a hosted provider is the deployment answer.
   */
  throw new Error(
    "AGENT_COMPUTER_URL names a shared computer, which strict per-user sandboxing forbids: every Bot would share one /workspace, one shell and one browser, so one user's files and logins would be another user's. " +
      "Unset AGENT_COMPUTER_URL and configure E2B_API_KEY (one desktop per person), COMPUTER_SUPERVISOR_URL (one computer per user and Bot), or COMPUTER_SANDBOX_NAMESPACE instead.",
  );
}

/**
 * The action policy, as JSON in one variable.
 *
 * Refuses to start on malformed JSON or a policy of the wrong shape, rather than falling back to the
 * default. An operator who wrote a rule and mistyped it would otherwise get a running deployment that
 * silently permits what they had just tried to forbid, and no indication that anything was wrong.
 * Configuration the product cannot honour belongs at the boot boundary; see the note at the top.
 */
function actionPolicy(environment: Environment): ActionPolicy | undefined {
  const raw = optional(environment, "AGENT_COMPUTER_POLICY");
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_COMPUTER_POLICY must be valid JSON");
  }

  const result = parseActionPolicy(parsed);
  if (!result.ok) {
    throw new Error(`AGENT_COMPUTER_POLICY is invalid: ${result.error}`);
  }
  return result.policy;
}

/**
 * How long silence on a Bot's stream is allowed to last.
 *
 * Refuses to start on anything that is not a whole number of milliseconds, rather than falling back
 * to the default. Same reasoning as the action policy above it: an operator who meant to write a
 * two-minute timeout and typed something else would otherwise get a running deployment with a
 * silently different boundary, and no indication that anything was wrong.
 *
 * Zero is a legitimate value and means off. It is not the same as a malformed one.
 */
function accessibilityEnabled(environment: Environment): boolean {
  const off = optional(environment, "REMII_ACCESSIBILITY_DISABLED");
  return off !== "true" && off !== "1";
}

/**
 * Whether a Bot may draw an interface it wrote itself.
 *
 * Default-on, matching the product capability the browser can already render. Operators who cannot
 * allow generated interfaces can explicitly opt out. `false` is the documented spelling and `0` is
 * accepted alongside it as the conventional off value used by environment-driven switches.
 *
 * Anything else leaves the capability on. A typo should not silently become an opt-out, and the
 * capability must stay consistent between runtime and browser projection.
 *
 * The answer has to reach the browser as well as the runtime, which is why it ends up on
 * /api/capabilities rather than staying server-side. Enabling only the runtime half would leave the
 * browser never offering the tool; enabling only the browser half would have a Bot generate a whole
 * interface that nothing renders. See DeploymentConfig.generativeUi.
 */
function generativeUiEnabled(environment: Environment): boolean {
  const value = optional(environment, "REMII_GENERATIVE_UI");
  return value !== "false" && value !== "0";
}

/**
 * How long the audit trail is kept.
 *
 * Refused rather than coerced, like everything else here. "We accepted your retention policy but not
 * the one you wrote" is a bad answer about a control an auditor will ask to see, and a typo that
 * silently became 0 would delete the trail rather than keep it.
 */
/**
 * The window for `run_activity`, defaulting to 30 days.
 *
 * A default rather than "unset means forever", because the audit trail's default is the right
 * default for an audit trail and the wrong one here. Thirty days is long enough to answer "what did
 * Remii do last Tuesday" and short enough that the table is a window rather than an archive. A
 * deployment that wants a different one sets `ACTIVITY_RETENTION_DAYS`; setting it to 0 switches the
 * sweep off entirely and keeps everything, which is the escape hatch for somebody who would rather
 * decide for themselves.
 */
function activityRetentionDays(environment: Environment): number {
  const raw = optional(environment, "ACTIVITY_RETENTION_DAYS");
  if (raw === undefined) return 30;
  if (raw.trim() === "0") return 0;

  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(
      "ACTIVITY_RETENTION_DAYS must be a whole number of days, 0 or more. Leave it unset for the default of 30, or set 0 to keep every run.",
    );
  }
  return days;
}

function auditRetentionDays(environment: Environment): number | undefined {
  const raw = optional(environment, "AUDIT_RETENTION_DAYS");
  if (!raw) return undefined;

  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(
      "AUDIT_RETENTION_DAYS must be a whole number of days, at least 1. Leave it unset to keep the audit trail forever.",
    );
  }
  return days;
}

function agentStallTimeoutMs(environment: Environment): number {
  const raw = optional(environment, "AGENT_STALL_TIMEOUT_MS");
  if (!raw) {
    return 0;
  }

  const milliseconds = Number(raw);
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new Error(
      "AGENT_STALL_TIMEOUT_MS must be a whole number of milliseconds, or 0 to switch the watchdog off",
    );
  }
  return milliseconds;
}

/** Where the API listens when nothing says otherwise: what `.env.example` and the image ship. */
const DEFAULT_PORT = 3001;

/**
 * The port the API listens on, from either of its two names.
 *
 * `PORT` and `SERVER_PORT` name one number: either moves the server, and two that disagree are
 * refused at boot rather than half-applied. Read through `optional` like every other setting here,
 * and that is the point. An unset variable declared in a compose file, or left as `PORT=` in a
 * `.env`, arrives as an empty string rather than as absent, so `process.env.PORT ??
 * process.env.SERVER_PORT` never fell through to the second name, and `Number.parseInt("")` is
 * `NaN`. Given `NaN`, `Bun.serve` binds an ephemeral port: the server came up somewhere nobody had
 * asked for, `SERVER_PORT` ignored, and the script polling it reported a server that never
 * started — the failure #312 set out to remove, back through the other name.
 *
 * A value that is not a whole port number is refused for the reason the caps above are: `30o1`
 * used to start the server on port 30, and a typo has to fail where somebody is looking.
 */
function serverPort(environment: Environment): number {
  const read = (name: string): number | undefined => {
    const raw = optional(environment, name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`${name} must be a whole number between 1 and 65535`);
    }
    return value;
  };
  const port = read("PORT");
  const serverPort = read("SERVER_PORT");
  if (port !== undefined && serverPort !== undefined && port !== serverPort) {
    throw new Error(
      `PORT (${port}) and SERVER_PORT (${serverPort}) disagree: set one or set both to the same value`,
    );
  }
  return port ?? serverPort ?? DEFAULT_PORT;
}

/**
 * Where saved files' bytes live, and which driver reads them.
 *
 * `local` is the default and needs nothing configured, which is the point: a deployment that has
 * never heard of this should start and work. `s3` is refused unless the bucket and region are both
 * present, rather than falling back to a half-configured client that fails on the first upload — a
 * process that starts and then cannot store a file is worse than one that will not start and says
 * why.
 */
export type StorageConfig =
  | { driver: "local"; rootDirectory: string }
  | {
      driver: "s3";
      bucket: string;
      region: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      endpoint?: string;
      forcePathStyle: boolean;
    };

/**
 * The storage driver, from `FILE_STORAGE_DRIVER` and the variables that go with it.
 *
 * The S3 branch reads PLACEHOLDERS as written and says so by refusing anything that looks like one.
 * This deployment has no bucket, and a default bucket name is the specific failure this guards: a
 * process configured with an example value that resolves to a real account would write somebody
 * else's files into a bucket they do not know they have. So a value that is empty, or that still
 * contains the placeholder text, is treated as absent and the deployment is told to finish setting
 * it up.
 */
function storageConfig(
  environment: Record<string, string | undefined>,
): StorageConfig {
  const driver = (optional(environment, "FILE_STORAGE_DRIVER") ?? "local")
    .trim()
    .toLowerCase();

  if (driver === "local") {
    return {
      driver: "local",
      rootDirectory:
        (optional(environment, "FILE_STORAGE_ROOT") as string | undefined) ??
        join(import.meta.dir, "..", "..", ".data", "files"),
    };
  }

  if (driver !== "s3") {
    throw new Error(
      `FILE_STORAGE_DRIVER is '${driver}', which is not a driver this app has. Use 'local' or 's3'.`,
    );
  }

  const bucket = readRealValue(environment, "S3_BUCKET");
  const region = readRealValue(environment, "S3_REGION");
  if (!bucket || !region) {
    throw new Error(
      "FILE_STORAGE_DRIVER is 's3' but S3_BUCKET and S3_REGION are not both set to real values. " +
        "Set them, or set FILE_STORAGE_DRIVER=local.",
    );
  }

  const accessKeyId = readRealValue(environment, "S3_ACCESS_KEY_ID");
  const secretAccessKey = readRealValue(environment, "S3_SECRET_ACCESS_KEY");
  // Half a credential is no credential: a key with no secret would fail at the first request with an
  // opaque signature error, and the message here is one somebody can act on.
  if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
    throw new Error(
      "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together, or both left unset to use " +
        "the ambient credentials (an instance role, or the SDK's own chain).",
    );
  }

  return {
    driver: "s3",
    bucket,
    region,
    ...(accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : {}),
    ...(optional(environment, "S3_ENDPOINT")
      ? { endpoint: optional(environment, "S3_ENDPOINT") as string }
      : {}),
    forcePathStyle:
      (optional(environment, "S3_FORCE_PATH_STYLE") ?? "").trim() === "1",
  };
}

/**
 * An environment value that is actually set, as opposed to set to the placeholder in `.env.example`.
 *
 * The placeholder check is deliberately crude — it looks for the words `your` and `changeme`, which
 * is not a parser and does not need to be. It only has to catch the values this repository ships,
 * and a variable nobody filled in is caught by the empty check anyway.
 */
function readRealValue(
  environment: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const raw = (optional(environment, name) as string | undefined)?.trim();
  if (!raw) return undefined;
  if (/\b(your|changeme|example|placeholder|todo)\b/i.test(raw))
    return undefined;
  return raw;
}

export function loadConfig(
  environment: Environment = process.env,
): DeploymentConfig {
  const auth = authConfig(environment);
  const managedAgent = managedAgentConfig(environment);
  const workerSharedSecret = optional(environment, "WORKER_SHARED_SECRET");

  return {
    port: serverPort(environment),
    databaseUrl: required(environment, "DATABASE_URL"),
    // Falls back to the pooled URL rather than demanding a second one: a deployment with a single
    // direct connection is correct without it, and a deployment that is behind a pooler and has
    // forgotten this gets one URL instead of a startup failure, which is the failure that is easy
    // to miss and expensive to notice, because LISTEN that does not fire looks like nobody spoke.
    databaseUrlUnpooled:
      optional(environment, "DATABASE_URL_UNPOOLED")?.trim() ||
      required(environment, "DATABASE_URL"),
    keyEncryptionKey: keyEncryptionKey(environment),
    ...(managedAgent ? { managedAgent } : {}),

    deploymentId: optional(environment, "DEPLOYMENT_ID"),
    composioApiKey: optional(environment, "COMPOSIO_API_KEY"),
    publicUrl: publicOrigin(environment),
    appUrl: (
      optional(environment, "REMII_APP_URL") ??
      commaSeparated(environment, "TRUSTED_ORIGINS")[0] ??
      publicOrigin(environment)
    )?.replace(/\/+$/, ""),
    tenantPackageDirectory:
      optional(environment, "TENANT_PACKAGE_DIR") ?? "../examples/fintech",
    runtime: runtimeCapabilities(environment),
    agentStallTimeoutMs: agentStallTimeoutMs(environment),
    auditRetentionDays: auditRetentionDays(environment),
    activityRetentionDays: activityRetentionDays(environment),
    oauth: {},
    auth,
    singleUser: singleUserEnabled(environment, hasIdentityProvider(auth)),
    accessibility: accessibilityEnabled(environment),
    generativeUi: generativeUiEnabled(environment),
    ...(optional(environment, "APP_DIST_DIR")
      ? { appDistDir: optional(environment, "APP_DIST_DIR") as string }
      : {}),
    computer: computerConfig(environment, hasIdentityProvider(auth)),
    storage: storageConfig(environment),
    handoff: handoffCaps(environment),
    executionMode: executionMode(environment),
    ...(optional(environment, "AGENT_TOOL_TOKEN")
      ? { agentToolToken: optional(environment, "AGENT_TOOL_TOKEN") as string }
      : {}),
    ...(workerSharedSecret ? { workerSharedSecret } : {}),
  };
}
