import type { Message } from "@ag-ui/client";
import { and, asc, eq } from "drizzle-orm";
import type { Hono as HonoApp, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { MAX_IMAGE_BYTES } from "../../shared/attachments";
import {
  authoriseAgentCall,
  parseAgentToolCallInput,
  sameToken,
} from "./agents/callback-token";
import type { BotAccessCheck } from "./agents/profile-policy";
import { canManageAgent } from "./agents/profile-policy";
import type { AgentProfileStore } from "./agents/profile-store";
import { createAgentRoutes } from "./agents/routes";
import {
  type AuditInitiator,
  type AuditReader,
  type AuditStore,
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
} from "./audit";
import { createDevRequireUser } from "./auth/dev-actor";
import {
  type AppVariables,
  type AuthService,
  createRequireUser,
} from "./auth/guards";
import type { IdentityProviderStore } from "./auth/identity-provider-store";
import { createBillingRoutes } from "./billing/routes";
import { createDodoWebhookRoutes } from "./billing/webhook-routes";
import {
  createAttachmentRoutes,
  createChannelAttachmentRoutes,
} from "./channels/attachments";
import type { ChannelEventHub } from "./channels/events";
import { type ChannelStore, createChannelRoutes } from "./channels/routes";
import type { ThreadIdentity } from "./channels/thread-identity";
import { createThreadRoutes } from "./channels/thread-routes";
import { createThreadReader } from "./channels/thread-status";
import { createComponentRoutes } from "./components/routes";
import type { SandboxedStore } from "./components/sandboxed";
import { createSandboxedRoutes } from "./components/sandboxed-routes";
import type { ComponentStore } from "./components/store";
import type { ComputerGateway } from "./computer/gateway";
import type { PageFrameStore } from "./computer/page-frames";
import type { PolicyStore } from "./computer/policy-store";
import { createComputerRoutes, createPolicyRoutes } from "./computer/routes";
import { configuredAuthProviders, type DeploymentConfig } from "./config";
import type { CredentialInput, CredentialWriteService } from "./credentials";
import type { Database } from "./db/client";
import { withoutStatement } from "./db/query-failure";
import { users } from "./db/schema";
import { threadMessages, threads } from "./db/schema/threads";
import {
  type ExecutionModeStore,
  InvalidExecutionModeError,
} from "./execution-mode";
import type { HostAccessBroker } from "./host-access/broker";
import { createHostAccessRoutes } from "./host-access/routes";
import type { OnboardingStore } from "./people/onboarding";
import { type SkillDrafts } from "./plugins/skill-drafter";
import type { ComposioBroker } from "./plugins/broker";
import { createPluginRoutes } from "./plugins/routes";
import {
  isDeploymentFault,
  PluginRefusedError,
  type PluginStore,
} from "./plugins/store";
import { REFUSAL_MARKER, vendorAnswer } from "./plugins/tools";
import { createRemiRoutes } from "./remi/routes";
import { createTelegramRoutes } from "./remi/telegram-routes";
import { createRoutineRoutes, type RoutineStore } from "./routines/routes";
import type { RoutineRunner } from "./routines/runner";
import type { IntentRouter } from "./routing/classify";
import { createRoutingRoutes } from "./routing/routes";
import type { BlobStore } from "./storage/blob-store";
import type { PackageStatusReader } from "./tenant-package";
import { expandStoredMessage, truncateHistoryMessage } from "./threads/local";
import {
  INSTRUCTIONS_LIMIT,
  InstructionsTooLongError,
  type UserInstructionsStore,
} from "./user-instructions";
import { createVaultRoutes, type VaultStore } from "./vault/routes";

/**
 * How much of a multipart body is boundary, headers and other fields rather than file.
 *
 * Generous on purpose. Measured against what the composer actually sends — one `file` part and one
 * `uploadGroup` field — the framing is 360 bytes for a short filename and 614 for a 255-character
 * one; a filename full of non-ASCII percent-encodes to a few times that and is still nowhere near
 * this. 64 KiB is therefore an allowance no honest request can exhaust, and it raises the amount of
 * memory a hostile request can pin by 0.8%, which was never the number that mattered.
 */
const MULTIPART_FRAMING_ALLOWANCE = 64 * 1024;

/**
 * The ceiling on the whole POST body of a channel attachment upload.
 *
 * THIS IS NOT `MAX_IMAGE_BYTES`, AND THE DIFFERENCE IS THE POINT. Every other gate on this path —
 * the composer's pre-check, `attachmentsConfigFor`'s `maxSize`, the handler's own 413 — measures
 * THE FILE. This one measures THE ENVELOPE: `bodyLimit` runs before anything has parsed the
 * multipart body, so all it can count is bytes on the wire, file and framing together.
 *
 * Set to `MAX_IMAGE_BYTES` exactly, those two units were silently treated as one, and the ~360
 * bytes of boundary and headers wrapped around a file at the documented ceiling were enough to push
 * the body over it: an 8,388,608-byte image — the exact number the composer publishes as the limit —
 * was refused 413, while 8,388,308 bytes went through. A limit nobody can reach is a limit that is
 * wrong, so the envelope's ceiling is the file's ceiling plus room for the envelope.
 *
 * The slack costs nothing it was protecting against. A body between the two numbers is still read
 * into memory, and then still refused by the handler once `file.size` is a thing anybody can look
 * at — which is where a text upload, whose real limit is `MAX_FILE_BYTES`, is refused too. What the
 * door exists to stop is the 2GB body, and it still does.
 */
export const UPLOAD_BODY_LIMIT_BYTES =
  MAX_IMAGE_BYTES + MULTIPART_FRAMING_ALLOWANCE;

/**
 * One row for something an administrator did to somebody's access.
 *
 * The address is on the row rather than only the user id, because the id means nothing to a person
 * reading the trail a year later and the user row may be gone by then.
 */
export type DeploymentToolCaller = (input: {
  name: string;
  args: Record<string, unknown>;
  botId: string;
  actorId: string;
  initiator?: AuditInitiator;
  threadId?: string;
}) => Promise<{ text: string; isError: boolean } | null>;

/**
 * The one `requireUser` this deployment serves, chosen the same way everywhere.
 *
 * Exported rather than inlined because two files now need it and the choice is a security
 * decision, not a detail. A route that quietly built its own copy could end up behind
 * `createDevRequireUser` — which admits every request as an administrator — while the rest of the
 * app was checking a real session, and the two would disagree about who is signed in.
 */
export function requireUserFor(
  singleUser: boolean | undefined,
  auth: AuthService | undefined,
): MiddlewareHandler<{ Variables: AppVariables }> {
  // One administrator, when nothing is configured to sign anybody in. Checked first, and only ever
  // true when there is no provider, so a configured deployment cannot fall back to it.
  if (singleUser) return createDevRequireUser();
  if (auth) return createRequireUser(auth);
  return async (context) =>
    context.json({ error: "No identity provider is configured." }, 503);
}

export function createApp(
  config: DeploymentConfig,
  auth?: AuthService,
  auditReader?: AuditReader,
  _credentialService?: CredentialWriteService,
  _packageStatusReader?: PackageStatusReader,
  /**
   * The CopilotKit endpoint, already built by the caller.
   *
   * Passed in rather than constructed here so this module never imports the runtime. The runtime
   * pulls in `eventsource`, which Bun cannot `require()` from a test, so importing it at module
   * scope broke every server test that touches createApp even though none of them use CopilotKit.
   */
  copilotHandler?: HonoApp,
  /** The single governed computer module: policy, audit trail, transport, and provider lifecycle. */
  computerGateway?: ComputerGateway,
  /** What the gateway enforces, and what an administrator can change while running. */
  computerPolicy?: PolicyStore,
  /** Bots as durable objects: profile, roster, visibility. */
  agentProfileStore?: AgentProfileStore,
  /** The durable channels a Bot runs in. */
  channelStore?: ChannelStore,
  /** Live channel activity. Absent leaves the routes working, just without the socket. */
  channelEvents?: ChannelEventHub,
  /**
   * Where a Bot's own refusal is written.
   *
   * Separate from `auditReader`, which only reads: this writes, and it is the one thing in the trail
   * that is not decided by the gateway, a model declining before it calls anything.
   */
  auditStore?: AuditStore,
  /**
   * Which components each Bot may answer with.
   *
   * Absent leaves the app working and every Bot answering in prose, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must not fall back to granting
   * everything.
   */
  componentStore?: ComponentStore,
  /**
   * The MCP servers and packaged skills this deployment has, and which Bots hold them.
   *
   * Absent leaves every Bot with the tools it was born with, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must offer nothing extra rather than
   * fall back to offering everything.
   */
  pluginStore?: PluginStore,
  /**
   * Components authored in the browser rather than compiled into the build.
   *
   * Absent leaves the compiled gallery working exactly as before, which is the correct degraded
   * behaviour: the React path is the primary one and does not depend on this.
   */
  sandboxedStore?: SandboxedStore,
  /**
   * How this deployment names the threads it mints.
   *
   * Absent leaves the direct Bot chat generating its own id in the browser, which works and simply
   * says nothing about which deployment the conversation belongs to.
   */
  threadIdentity?: ThreadIdentity,
  /**
   * The enterprise identity providers this deployment has registered.
   *
   * Read here rather than through Better Auth's own listing route, which scopes to the person asking:
   * a company's Okta tenant belongs to the deployment, not to whichever administrator pasted the
   * metadata in. See identity-provider-store.ts.
   */
  identityProviders?: IdentityProviderStore,
  /**
   * Chooses which coworker an untagged message is for, before a channel is pinned to one.
   *
   * Passed in already built, like the copilot handler, so this module never imports the model
   * client. Absent leaves the composer's existing behaviour untouched: an untagged message goes to
   * the default coworker, which is exactly the failsafe the router itself falls back to.
   */
  intentRouter?: IntentRouter,
  /**
   * Where the frame a browsing turn ended on is kept.
   *
   * Appended last on purpose: these are positional, so inserting one anywhere else silently
   * shifts every existing call site's arguments by one.
   *
   * Absent leaves the transcript working and past turns without a picture, which is the correct
   * degraded behaviour: a conversation that cannot show what it saw is better than one that shows
   * the wrong thing.
   */
  pageFrames?: PageFrameStore,
  /**
   * Fires one routine run with nobody's browser open, when the worker hands one back.
   *
   * Appended last, like `pageFrames`: these are positional, so inserting one anywhere else silently
   * shifts every existing call site's arguments by one.
   *
   * Absent leaves the internal `/internal/routines/run` route unmounted rather than mounted and
   * refusing every call: a deployment that never built a worker has no door for it, not a locked one.
   */
  routineRunner?: RoutineRunner,
  /**
   * A person's own standing instructions: the list, and a switch to stop one.
   *
   * Appended last, like `routineRunner` beside it: these are positional, so inserting one anywhere
   * else silently shifts every existing call site's arguments by one.
   *
   * Absent leaves the routes unmounted rather than mounted and refusing every call, the same
   * degraded shape every other optional store here takes: a deployment that never built the store
   * has no door for this at all, not a locked one.
   */
  routineStore?: RoutineStore,
  /**
   * Where each person is in first-run onboarding.
   *
   * Appended last, like everything above it: these are positional, so inserting one anywhere else
   * silently shifts every existing call site's arguments by one.
   *
   * Absent leaves /api/me reporting no onboarding to track, which is the correct degraded
   * behaviour: a deployment that cannot read the status must not lock everybody behind a gate
   * nothing can finish.
   */
  onboardingStore?: OnboardingStore,
  /**
   * One person's standing instructions, which every built-in coworker they run is told.
   *
   * Appended last, like everything above it: these are positional, so inserting one anywhere else
   * silently shifts every existing call site's arguments by one.
   *
   * Absent leaves the routes answering 503 rather than "you have written none". The difference
   * matters on exactly this screen: a person who cannot be told what they saved would otherwise be
   * shown an empty box, and the obvious thing to do with an empty box is fill it in again.
   */
  userInstructions?: UserInstructionsStore,
  /**
   * The database behind a channel's staged and sent files: upload, fetch, delete.
   *
   * Appended last, like everything above it: these are positional, so inserting one anywhere else
   * silently shifts every existing call site's arguments by one.
   *
   * Absent leaves the routes unmounted rather than mounted and refusing every call, the same
   * degraded shape every other optional store here takes: a deployment that never built the
   * database has no door for this at all, not a locked one.
   */
  attachmentDatabase?: Database,
  /** Session-only broker for native owner-approved host folder access. */
  hostAccessBroker?: HostAccessBroker,
  /** Fresh desktop-only bearer token for the native host worker poll/result channel. */
  desktopHostToken?: string,
  /** Server-owned tools that are not MCP but use the same signed agent callback route. */
  deploymentToolCaller?: DeploymentToolCaller,
  /**
   * The broker behind apps a person connects through Composio rather than an administrator
   * registering an MCP server.
   *
   * Appended last, like everything above it: these are positional, so inserting one anywhere else
   * silently shifts every existing call site's arguments by one.
   *
   * Passed in already built, like the copilot handler and the intent router, so this module never
   * imports the vendor's package. Absent leaves the plugin surface reporting that no broker is
   * configured, which is the correct degraded behaviour: a deployment with no Composio API key has
   * no app directory to offer, rather than one that lists apps nobody can connect.
   */
  composio?: { broker: ComposioBroker },
  /**
   * One cron tick: claim due scheduled jobs and run each as its owner. Built in index.ts where
   * the turn runner and channel store live. Absent leaves the route unmounted, the same degraded
   * shape as the routines door: a deployment with no worker has no tick to call.
   */
  cronTick?: () => Promise<{ claimed: number; ran: number; failed: number }>,
  /**
   * One Telegram message in, one turn out. Built in index.ts where the turn runner and
   * channel store live. Absent leaves the route unmounted: no bot token, no door.
   */
  telegramIncoming?: (input: {
    chatId: string;
    text: string;
    voiceFileId?: string;
    photoFileIds?: string[];
    documentFileId?: string;
    documentName?: string;
  }) => Promise<{ replied: boolean }>,
  /**
   * Telegram link management for settings screens. Token and username travel together because
   * a code without the bot it belongs to is a `t.me` link to nowhere. Absent leaves the
   * routes unmounted.
   */
  telegram?: { token?: string; username?: string },
  /**
   * One person's execution switch: whether their coworkers act directly or ask first.
   *
   * Appended last, like everything above it: these are positional, so inserting one anywhere
   * else silently shifts every existing call site's arguments by one.
   *
   * Absent leaves the routes answering 503. A screen that cannot read the switch must not
   * draw one in the wrong position.
   */
  executionModes?: ExecutionModeStore,
  /**
   * One Composio trigger event in, zero or one turns out. Built in index.ts where the turn
   * runner, channel store and remi store live. Appended last, positionally. Absent leaves
   * the route unmounted: no broker, no door. The vendor secret is checked at the route when
   * configured (see below), and the handler itself never throws — a poison payload returns
   * a reason, not a retry storm.
   */
  triggerIncoming?: (payload: unknown) => Promise<{
    success: boolean;
    reason?: string;
    automationId?: string;
    taskId?: string;
  }>,
  /*
   * Where a saved file's bytes are. APPENDED LAST, FOR THE POSITIONAL REASON THE NOTE ABOVE MAKES:
   * every caller of this function passes its collaborators by position, and a parameter inserted in
   * the middle shifts every argument after it — silently, because they are all optional and all
   * typed `never` in the tests that count them. Absent leaves the Files page listing files it cannot
   * open, which is the correct degraded behaviour: a deployment with no storage driver has not lost
   * any files, it simply cannot serve the ones whose bytes went somewhere else.
   */
  _blobStore?: BlobStore,
  /**
   * One person's saved information: logins, cards, personal details, and the items a coworker may
   * reach for.
   *
   * Appended last, like every collaborator above it: these parameters are positional, so inserting one
   * anywhere else silently shifts every existing call site's arguments by one.
   *
   * Absent leaves the routes unmounted rather than mounted and refusing every call, the same degraded
   * shape `routineStore` and `userInstructions` take — a deployment that never built the store has no
   * door for this at all, not a locked one.
   */
  vaultStore?: VaultStore,
  /**
   * Drafts skills out of a repository on the deployment's own model.
   *
   * Appended last, like every collaborator above it: these parameters are positional, so inserting
   * one anywhere else silently shifts every existing call site's arguments by one. Absent leaves the
   * New-skill screen's drafter answering 503 rather than offering drafts nobody can grade.
   */
  skillDrafter?: (repo: string, signal?: AbortSignal) => Promise<SkillDrafts>,
) {
  /*
   * The optional collaborators, named once so the routes below can refer to them by name.
   *
   * `createApp` takes a long positional list — appended last, in this file's own convention — and
   * past about the fourth parameter nobody can read which is which without counting from the top.
   * This alias is what `createRemiRoutes({ blobs: blobStore })` refers to, and it costs one line.
   */
  const blobStore = _blobStore;

  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/health", (context) => context.json({ status: "ok" }));
  // Projected, never the raw runtime. config holds deployment secrets and this endpoint
  // is reachable by anyone. Returning the object wholesale would serve them to the browser.
  // Add fields here explicitly.
  app.get("/api/capabilities", async (context) =>
    context.json({
      mode: config.runtime.mode,
      durableHistory: config.runtime.durableHistory,
      /*
       * Whether a Bot may answer with an interface it wrote itself.
       *
       * Projected because the browser holds half of this capability. The runtime middleware turns a
       * generated interface into the events that paint it, and the SDK's provider registers the tool
       * that produces one; a deployment that switched the runtime half off while the browser went on
       * offering the tool would have Bots writing interfaces nothing ever draws. One flag, read by
       * both halves, so off means off.
       */
      generativeUi: config.generativeUi,
      /*
       * Whether any Bot here has a computer behind it.
       *
       * Read by the browser because the browser owns half of this capability too: it offers
       * the model the computer_* tools and draws the watch-screen button. A deployment that
       * switched the server half off while the browser kept offering would have Bots calling
       * tools nothing executes and people opening a screen onto nothing. One flag, read by
       * both halves, so off means off — and the screen button answers "coming soon".
       */
      computer: config.computer !== undefined,
      /*
       * Which identity providers this deployment can sign somebody in with.
       *
       * Ids only, never the credentials: `configuredAuthProviders` returns names, and the clients
       * and secrets behind them stay in `config.auth`, which is not projected here.
       *
       * Answered at runtime rather than baked into the build, because the container image is built
       * once and knows nothing about the deployment that will run it. A sign-in screen compiled on a
       * build machine cannot offer a provider that machine had never heard of.
       */
      authProviders: configuredAuthProviders(config.auth),
      /*
       * Whether email (or username) plus password sign-in is on. Separate from the OAuth ids
       * above because it draws a form, not a button.
       */
      emailPassword: config.auth?.emailPassword === true,
      /*
       * How Bots act by default on this deployment: `direct` (do what was asked, immediately)
       * or `ask-first` (confirm external actions via `ask_person` first). A person overrides
       * this for themselves on the General settings screen; this is the value they inherit.
       */
      executionMode: config.executionMode,
      /*
       * Whether any enterprise identity provider has been registered.
       *
       * A count, not a list. The sign-in screen only needs to know whether to offer the email box
       * that routes by domain; naming the providers would tell anybody who loads the page which
       * companies use this deployment, which is not theirs to have before they sign in.
       */
      ssoConfigured: ((await identityProviders?.list()) ?? []).length > 0,
      authMode: config.auth ? "session" : "single-user",
    }),
  );
  /*
   * Individual-user SaaS has no company SSO to register at runtime: providers
   * come from deployment configuration, and there is no administrator who
   * could authorize a new one. Better Auth's SSO plugin still serves its
   * mutation routes, and its own guard asks only that somebody is signed in —
   * which would let any user register an identity provider for a domain and
   * mint themselves colleagues. So those three paths are closed entirely.
   * Sign-in through an already-configured provider keeps working; nothing
   * here touches it.
   */
  const CLOSED_SSO_ROUTES = new Set([
    "/api/auth/sso/register",
    "/api/auth/sso/update-provider",
    "/api/auth/sso/delete-provider",
  ]);

  app.on(["GET", "POST"], "/api/auth/*", async (context) => {
    if (!auth) {
      return context.json(
        { error: "No identity provider is configured." },
        503,
      );
    }

    if (CLOSED_SSO_ROUTES.has(new URL(context.req.url).pathname)) {
      return context.json(
        { error: "Registering an identity provider is not available." },
        410,
      );
    }

    return auth.handler(context.req.raw);
  });

  const requireUser = requireUserFor(config.singleUser, auth);

  app.get("/api/me", requireUser, async (context) => {
    let creditBalance = 50;
    let stripeCustomerId: string | null = null;
    let isBanned = false;
    if (attachmentDatabase) {
      const [u] = await attachmentDatabase
        .select({
          creditBalance: users.creditBalance,
          stripeCustomerId: users.stripeCustomerId,
          isBanned: users.isBanned,
        })
        .from(users)
        .where(eq(users.id, context.var.actor.id))
        .limit(1);
      if (u) {
        creditBalance = u.creditBalance ?? 50;
        stripeCustomerId = u.stripeCustomerId ?? null;
        isBanned = u.isBanned ?? false;
      }
    }

    return context.json({
      user: {
        ...context.var.actor,
        creditBalance,
        stripeCustomerId,
        isBanned,
        /*
         * Read here rather than in the guard, so only this route pays the extra query. Null means
         * this deployment does not track onboarding, which the app reads as nothing to finish;
         * a not-yet-completed status is what sends it to /onboarding.
         */
        onboarding: onboardingStore
          ? await onboardingStore.status(context.var.actor.id)
          : null,
      },
    });
  });
  app.post("/api/me/onboarding", requireUser, async (context) => {
    if (!onboardingStore) {
      return context.json({ error: "Onboarding is not available." }, 503);
    }

    const body = (await context.req.json().catch(() => undefined)) as
      | { step?: unknown; completed?: unknown }
      | undefined;

    if (body?.completed === true) {
      await onboardingStore.complete(context.var.actor.id);
    } else if (
      typeof body?.step === "number" &&
      Number.isInteger(body.step) &&
      body.step >= 0 &&
      // The column's range — the only bound the server knows, since the wizard's length is the
      // app's fact rather than the deployment's.
      body.step <= 2_147_483_647
    ) {
      await onboardingStore.setStep(context.var.actor.id, body.step);
    } else {
      return context.json(
        { error: "Send the step to move to, or completed: true." },
        400,
      );
    }

    return context.json({
      onboarding: await onboardingStore.status(context.var.actor.id),
    });
  });
  /*
   * A person's own standing instructions, read and written by the person they belong to.
   *
   * `requireUser` for every signed-in person (no administrator tier exists), and scoped to `context.var.actor.id` rather than to
   * anything in the path or the body. There is deliberately no route here for reading somebody
   * else's or writing on their behalf: these instructions go into a prompt that then speaks as that
   * person's coworker, so a way to set them for another account would be a way to put words in
   * somebody's mouth in every channel they work in. An administrator has no business here either,
   * for the same reason.
   */
  app.get("/api/settings/instructions", requireUser, async (context) => {
    if (!userInstructions) {
      return context.json(
        { error: "Standing instructions are not available." },
        503,
      );
    }

    return context.json({
      // "" is what having written none looks like to a text box, and the store's null is what it
      // looks like to a database. The translation happens once, here.
      instructions: (await userInstructions.read(context.var.actor.id)) ?? "",
    });
  });
  app.put("/api/settings/instructions", requireUser, async (context) => {
    if (!userInstructions) {
      return context.json(
        { error: "Standing instructions are not available." },
        503,
      );
    }

    const body = (await context.req.json().catch(() => undefined)) as
      | { instructions?: unknown }
      | undefined;

    if (typeof body?.instructions !== "string") {
      return context.json({ error: "Send the instructions to save." }, 400);
    }

    /*
     * The cap is the store's rule, so the store is what enforces it and this catches the refusal
     * rather than checking the length again. A second copy of `> 4000` here is a second place for
     * the number to be changed in only one of them.
     */
    let saved: string;
    try {
      saved = await userInstructions.write(
        context.var.actor.id,
        body.instructions,
      );
    } catch (error) {
      if (error instanceof InstructionsTooLongError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }

    /*
     * The trail records that they changed and how long they now are, NEVER what they say.
     *
     * The audit table is append-only and read by administrators, and this is a person's own note
     * about how they want to be spoken to. Recording the text would put it somewhere they cannot
     * edit it and somebody else can read it, which is not what a preferences screen promises. The
     * length is enough to answer the question a trail is for: when did this change, and to what
     * extent.
     */
    if (auditStore) {
      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "user_instructions",
        targetId: context.var.actor.id,
        actorUserId: context.var.actor.id,
        payload: {
          change: saved === "" ? "instructions_cleared" : "instructions_saved",
          characters: saved.length,
          limit: INSTRUCTIONS_LIMIT,
        },
      });
    }

    return context.json({ instructions: saved });
  });

  /*
   * One person's execution switch, read and written by the person it belongs to.
   *
   * `requireUser` for every signed-in person (no administrator tier exists), scoped to `context.var.actor.id`, for the same
   * reason as standing instructions above: this changes how every coworker acts for that
   * person, so setting it for somebody else would be acting on their behalf in every channel
   * they work in. The value itself is safe to audit (it is a switch position, not prose), so
   * unlike instructions the trail records what it was set to.
   */
  app.get("/api/settings/execution-mode", requireUser, async (context) => {
    if (!executionModes) {
      return context.json({ error: "Execution mode is not available." }, 503);
    }

    return context.json({
      // Null is what inheriting the deployment default looks like to a settings screen, and
      // the screen draws the inherited value beside it from /api/capabilities.
      mode: await executionModes.read(context.var.actor.id),
      defaultMode: config.executionMode,
    });
  });
  app.put("/api/settings/execution-mode", requireUser, async (context) => {
    if (!executionModes) {
      return context.json({ error: "Execution mode is not available." }, 503);
    }

    const body = (await context.req.json().catch(() => undefined)) as
      | { mode?: unknown }
      | undefined;

    if (
      body?.mode !== undefined &&
      body?.mode !== null &&
      typeof body?.mode !== "string"
    ) {
      return context.json(
        { error: 'Send "direct", "ask-first" or empty.' },
        400,
      );
    }

    let saved: "direct" | "ask-first" | null;
    try {
      saved = await executionModes.write(
        context.var.actor.id,
        (body?.mode ?? null) as "direct" | "ask-first" | null,
      );
    } catch (error) {
      if (error instanceof InvalidExecutionModeError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }

    if (auditStore) {
      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "execution_mode",
        targetId: context.var.actor.id,
        actorUserId: context.var.actor.id,
        payload: {
          change:
            saved === null
              ? "execution_mode_inherited"
              : "execution_mode_saved",
          ...(saved === null ? {} : { mode: saved }),
        },
      });
    }

    return context.json({ mode: saved, defaultMode: config.executionMode });
  });

  /*
   * Where the worker hands a routine run back. Not under /api and not behind requireUser: the
   * worker is not a person with a session, it is another process on this deployment's own network,
   * and the shared secret below is its whole credential.
   *
   * Mounted only when a runner was built, so a deployment that never stood up a worker has no door
   * for this at all, rather than one that is mounted and permanently refuses.
   */
  if (routineRunner) {
    app.post("/internal/routines/run", async (context) => {
      const offered = context.req.header("authorization");
      const expected = config.workerSharedSecret
        ? `Bearer ${config.workerSharedSecret}`
        : null;
      /*
       * The no-secret-configured case is refused here, before any comparison, and with the exact
       * same response as a wrong secret. A deployment with no worker must not answer a guess any
       * differently than a deployment with a worker and a wrong key would.
       */
      if (!expected || !offered || !sameToken(offered, expected)) {
        /*
         * Recorded, because this is a boundary being held and every other one here leaves a row. A
         * worker with a stale or missing secret used to fail here in total silence: every routine
         * stopped firing and nothing anywhere said why, the same false negative `mcp.callback_refused`
         * exists to catch on the sibling unauthenticated boundary above.
         *
         * The reason is short and lives only in the row, never on the wire: the response below stays
         * byte-identical across all three causes on purpose (see the comment above), so this is the
         * one place the distinction is allowed to exist. The offered credential itself is never
         * recorded, not even a fragment of it.
         */
        if (auditStore) {
          try {
            await recordAuditEvent(auditStore, {
              eventType: "routines.dispatch_refused",
              targetType: "worker",
              initiator: DEPLOYMENT_INITIATOR,
              payload: {
                reason: !expected
                  ? "unconfigured"
                  : !offered
                    ? "missing-header"
                    : "mismatch",
                note: "A worker's bearer secret did not check out, so no routine run was dispatched.",
              },
            });
          } catch (error) {
            // Never fatal: the 401 above is already decided and sent. A trail that is briefly
            // unavailable is not a reason to turn a refusal into a 500.
            console.error(
              JSON.stringify({
                type: "routine-dispatch-audit-write-failed",
                error: String(error),
              }),
            );
          }
        }
        return context.json({ error: "This endpoint is the worker's." }, 401);
      }
      const body = await context.req.json().catch(() => null);
      const routineRunId = (body as { routineRunId?: unknown } | null)
        ?.routineRunId;
      // An empty id is a string and used to answer 202 Accepted while the worker swallows the
      // failure. Only a non-empty id is accepted for dispatch.
      if (typeof routineRunId !== "string" || !routineRunId.trim()) {
        return context.json({ error: "A routineRunId is required." }, 400);
      }
      /*
       * Fire and answer: the consumer needs "accepted", not the outcome. The run row in
       * `routine_runs` carries the outcome, and the consumer finishes the work item on this 202.
       * Queue retries exist for DISPATCH failures only — a failed turn is final for this firing, and
       * the fatigue rule owns it. `run()` never throws by contract; this swallow only guards against
       * that contract being wrong without turning a bug there into an unhandled rejection here.
       */
      void routineRunner.run(routineRunId).catch(() => {});
      return context.json({ accepted: true }, 202);
    });
  }
  /*
   * The cron tick, called by the worker about once a minute with the worker's secret.
   *
   * Same credential shape as the routines door above (audited refusal, byte-identical 401s),
   * because it is the same trust: this process runs turns, and only the worker may ask it to.
   * Synchronous, unlike routines dispatch: claiming and running happen here, so the worker only
   * needs a clock. A tick that throws still answers what it managed, so one wedged job does not
   * read as a dead ticker.
   */
  if (cronTick) {
    app.post("/internal/cron/tick", async (context) => {
      const offered = context.req.header("authorization");
      const expected = config.workerSharedSecret
        ? `Bearer ${config.workerSharedSecret}`
        : null;
      if (!expected || !offered || !sameToken(offered, expected)) {
        if (auditStore) {
          try {
            await recordAuditEvent(auditStore, {
              eventType: "routines.dispatch_refused",
              targetType: "worker",
              initiator: DEPLOYMENT_INITIATOR,
              payload: {
                reason: !expected
                  ? "unconfigured"
                  : !offered
                    ? "missing-header"
                    : "mismatch",
                note: "A worker's bearer secret did not check out, so no cron tick ran.",
              },
            });
          } catch (error) {
            console.error(
              JSON.stringify({
                type: "cron-dispatch-audit-write-failed",
                error: String(error),
              }),
            );
          }
        }
        return context.json({ error: "This endpoint is the worker's." }, 401);
      }
      try {
        return context.json(await cronTick());
      } catch (error) {
        return context.json(
          {
            claimed: 0,
            ran: 0,
            failed: 0,
            error: error instanceof Error ? error.message : String(error),
          },
          500,
        );
      }
    });
  }
  /*
   * Telegram delivery, called by the worker that long-polls getUpdates. Same worker-secret
   * credential as the other internal doors. Validates shape minimally (a chat id and text);
   * everything else — linking, ownership, the turn — happens inside.
   */
  if (telegramIncoming) {
    app.post("/internal/telegram/incoming", async (context) => {
      const offered = context.req.header("authorization");
      const expected = config.workerSharedSecret
        ? `Bearer ${config.workerSharedSecret}`
        : null;
      if (!expected || !offered || !sameToken(offered, expected)) {
        return context.json({ error: "This endpoint is the worker's." }, 401);
      }
      const body = (await context.req.json().catch(() => null)) as {
        chatId?: unknown;
        text?: unknown;
        voiceFileId?: unknown;
        photoFileIds?: unknown;
        documentFileId?: unknown;
        documentName?: unknown;
      } | null;
      if (
        typeof body?.chatId !== "string" ||
        !body.chatId.trim() ||
        typeof body?.text !== "string"
      ) {
        return context.json({ error: "A chatId and text are required." }, 400);
      }
      const strings = (value: unknown): string[] =>
        Array.isArray(value)
          ? value.filter(
              (entry): entry is string =>
                typeof entry === "string" && entry.length > 0,
            )
          : [];
      try {
        return context.json(
          await telegramIncoming({
            chatId: body.chatId,
            text: body.text,
            ...(typeof body.voiceFileId === "string" && body.voiceFileId
              ? { voiceFileId: body.voiceFileId }
              : {}),
            ...(strings(body.photoFileIds).length > 0
              ? { photoFileIds: strings(body.photoFileIds) }
              : {}),
            ...(typeof body.documentFileId === "string" && body.documentFileId
              ? { documentFileId: body.documentFileId }
              : {}),
            ...(typeof body.documentName === "string" && body.documentName
              ? { documentName: body.documentName }
              : {}),
          }),
        );
      } catch (error) {
        return context.json(
          {
            replied: false,
            error: error instanceof Error ? error.message : String(error),
          },
          500,
        );
      }
    });
  }
  /*
   * Composio trigger events in. Mounted only when the broker is configured: with no Composio
   * key no trigger can name this deployment, so there is no door rather than an open one.
   *
   * The vendor secret is checked here when `COMPOSIO_TRIGGER_SECRET` is set, and a mismatch
   * answers 401 without the payload ever being read. Unset means the deployment resolves the
   * user strictly or drops the event — spoofing then files todos only for resolvable users,
   * which is why production sets the secret. The handler never throws (a poison payload
   * returns a reason), so this answers 200 with the outcome either way.
   */
  if (
    triggerIncoming &&
    (process.env.COMPOSIO_TRIGGER_SECRET?.trim() ||
      process.env.NODE_ENV !== "production")
  ) {
    if (!process.env.COMPOSIO_TRIGGER_SECRET?.trim()) {
      console.error(
        JSON.stringify({
          type: "composio-trigger-secret-missing",
          note: "COMPOSIO_TRIGGER_SECRET is not set. Trigger events are attributed strictly (no email guessing) and mismatches are dropped, but set the secret in production so forged webhooks are refused at the door with 401.",
        }),
      );
    }
    app.post("/api/webhooks/composio", async (context) => {
      const expected = process.env.COMPOSIO_TRIGGER_SECRET?.trim();
      if (expected) {
        const offered =
          context.req.header("x-composio-secret") ??
          context.req.header("x-trigger-secret") ??
          "";
        if (offered !== expected) {
          return context.json(
            { error: "This endpoint belongs to Composio." },
            401,
          );
        }
      }
      const payload = await context.req.json().catch(() => null);
      return context.json(await triggerIncoming(payload));
    });
  }
  // The CopilotKit runtime, behind the same session guard as every other API route. Mounted last so
  // its own routing under /api/copilotkit cannot shadow an Remii route declared above.
  if (copilotHandler) {
    /*
     * SaaS mode: no credits, no ban gate, no turn toll. The person asking is trusted and the
     * Bot always works: every POST to the runtime starts a turn. (Usage rows may still be
     * recorded downstream for cost visibility, but nothing here refuses a turn over them.)
     */
    // Mounted at the ROOT with the handler carrying its own basePath. Mounting it at
    // "/api/copilotkit" as well double-prefixes it: Hono strips the prefix before the handler sees
    // the path, so every route lands at /api/copilotkit/api/copilotkit/* and /info 404s. The browser
    // reports that as "Runtime info request failed with status 404" and every run fails before it
    // starts, with nothing at all in the server log.
    //
    // The one runtime path shadowed on purpose: thread messages. The handler
    // serves that path from its runner's process memory, which forgets every
    // restart; this deployment persists transcripts in Postgres, so its own
    // route — registered first, so it wins — answers from the table. Same
    // `{ messages }` envelope the browser already reads.
    app.get(
      "/api/copilotkit/threads/:threadId/messages",
      requireUser,
      async (context) => {
        if (!attachmentDatabase) {
          return context.json({ messages: [] });
        }
        const rows = await attachmentDatabase
          .select({
            messageId: threadMessages.messageId,
            role: threadMessages.role,
            content: threadMessages.content,
          })
          .from(threadMessages)
          .innerJoin(threads, eq(threadMessages.threadId, threads.id))
          .where(
            and(
              eq(threadMessages.threadId, context.req.param("threadId")),
              eq(threads.userId, context.var.actor.id),
            ),
          )
          .orderBy(asc(threadMessages.createdAt))
          .catch(() => []);
        return context.json({
          // Expanded through the store's own reader: rows are Remi parts
          // (`{remi, parts}`), and the browser only parses AG-UI. Serving
          // them raw dropped every parts-shaped turn as unreadable.
          //
          // Trimmed after that: one tool result can hold a whole mailbox, and
          // an unbounded history payload outruns the browser's history
          // deadline on every open — which reads as chats that never load.
          // The stored rows are untouched; only the served copy is cut, with
          // the cut marked in the text itself.
          messages: rows
            .map((row) => {
              try {
                return truncateHistoryMessage(expandStoredMessage(row));
              } catch {
                const content = row.content as Record<string, unknown>;
                return truncateHistoryMessage({
                  ...(typeof content === "object" && content !== null
                    ? content
                    : {}),
                  id: row.messageId,
                  role: row.role as Message["role"],
                } as Message);
              }
            })
            .filter((msg): msg is Message => msg !== null),
        });
      },
    );
    /*
     * Everything the runtime serves that is not the transcript read is behind a sign-in.
     *
     * The runtime is a library mounted whole, and only ONE of its paths was shadowed above: the
     * transcript read, which this deployment answers from Postgres. Every other path fell through to
     * the library, whose own thread endpoints answer from the runner's process memory — and that
     * memory is not partitioned by person. Concretely, on an unauthenticated request:
     *
     *   - `GET  /api/copilotkit/threads`            lists every live thread id in the process;
     *   - `GET  /api/copilotkit/threads/:id/events` replays a thread's whole AG-UI event stream,
     *                                                    which is the conversation: what the person
     *                                                    typed, what the Bot said, and the model's
     *                                                    own reasoning;
     *   - `POST /api/copilotkit/threads/clear`      wipes every person's in-memory thread state.
     *
     * So an id from the first request opened the second, and nothing was asked of the caller. The
     * list is the sharp end: it hands out the ids the read needs.
     *
     * `requireUser` is registered immediately before the mount so it runs first for these paths
     * (Hono applies middleware in registration order). `/info` stays open because the sign-in page
     * reads it before anybody has a session, and it names agents rather than anyone's data.
     */
    app.use("/api/copilotkit/*", async (context, next) => {
      if (context.req.path === "/api/copilotkit/info") return next();
      return requireUser(context, next);
    });
    app.route("/", copilotHandler);
  }

  /**
   * May this person act as this Bot?
   *
   * The store's own read path already applies `canAccessAgent`, so asking it for the Bot is the same
   * question the roster and the runtime ask, rather than a second copy of the rule.
   *
   * A deployment with no profile store has no agents table and therefore no private Bot to protect:
   * its Bots come from the tenant package and are public to everybody who can sign in. Answering yes
   * there keeps that deployment working without weakening one that has owners.
   */
  const canUseBot: BotAccessCheck = agentProfileStore
    ? async (actor, botId) =>
        (await agentProfileStore.get(actor, botId)) !== null
    : async () => true;

  /*
   * Ownership, as distinct from reachability.
   *
   * `canUseBot` above answers "may this person see it", which for a Bot several people share is
   * yes. Some grants need the stronger question: a connection that spends the ASKER'S account is
   * only their business while the Bot is theirs, because wiring it into a Bot other people can also
   * reach changes how that Bot behaves for them. Same store, different question, so it is asked
   * separately rather than inferred from a reachable row.
   */
  const canManageBot: BotAccessCheck = agentProfileStore
    ? async (actor, botId) => {
        const agent = await agentProfileStore.get(actor, botId);
        return agent !== null && canManageAgent(actor, agent);
      }
    : async () => false;

  // The Bot computer. Acting on a page needs the gateway and the policy it enforces, so both arrive
  // together or the routes are not mounted. An ungoverned computer is not a reduced feature. It is
  // the one shape of this feature that must not exist.
  if (computerGateway && computerPolicy) {
    app.route(
      "/api/computers",
      createComputerRoutes(
        computerGateway,
        computerPolicy,
        requireUser,
        canUseBot,
        pageFrames,
        auditReader,
        attachmentDatabase,
        // Verification is only demanded when codes can actually be delivered. Without a mail
        // provider nobody could ever complete it, and the gate would refuse every computer
        // use forever — the same line sign-in draws in auth/index.ts.
        config.auth?.email !== undefined,
      ),
    );
  }

  /*
   * The policy surface is the one half of the computer routes that needs no computer. The gateway
   * is absent on any deployment whose provider is unset, and a boundary only ever reads and writes
   * the person's own rules — so mounting it with no gateway leaves nothing ungoverned: nothing
   * exists here that a policy would govern. Without this, an operator who set no computer provider
   * got a Boundaries screen that could not load its own policy.
   */
  if (computerPolicy && !computerGateway) {
    app.route(
      "/api/computers",
      createPolicyRoutes(
        computerPolicy,
        requireUser,
        auditReader,
        attachmentDatabase,
      ),
    );
  }

  if (hostAccessBroker) {
    app.route(
      "/api/host-access",
      createHostAccessRoutes({
        broker: hostAccessBroker,
        desktopToken: desktopHostToken,
        requireUser,
        canUseBot,
        auditStore,
        botName: agentProfileStore
          ? async (botId, actor) =>
              (await agentProfileStore.get(actor, botId))?.name ?? null
          : undefined,
      }),
    );
  }

  if (agentProfileStore) {
    app.route(
      "/api/agents",
      createAgentRoutes(
        agentProfileStore,
        requireUser,
        // A Bot's own refusal goes in the same trail as everything else it does.
        auditStore,
        /*
         * What the Bot's own screen needs to show, and change, which Bots it may hand work to.
         *
         * Read per request rather than captured, for the reason the desk reads it per hop: a grant
         * made a minute ago counts and one revoked a minute ago stops counting. Absent with no
         * plugin store, which is a deployment where no Bot may address any other.
         */
        pluginStore
          ? {
              enabled:
                config.handoff.maxDepth > 0 && config.handoff.maxPerRun > 0,
              reachableFrom: (agentId) =>
                pluginStore.botsReachableFrom(agentId),
              // The same answer the write path checks, read up front so the screen can say it once.
              runsHere: (agentId) => pluginStore.agentRunsHere(agentId),
            }
          : undefined,
      ),
    );
    // Choosing a coworker for an untagged message needs the same permission-filtered roster the
    // agents routes read, so it is mounted here where that store is in scope. Only when a router was
    // configured; without one the composer keeps sending untagged messages to the default.
    if (intentRouter) {
      app.route(
        "/api/route",
        createRoutingRoutes(
          agentProfileStore,
          intentRouter,
          requireUser,
          auditStore,
          /*
           * Which vendors each coworker holds tools for, so the router weighs what a coworker can
           * reach and not only what somebody wrote it was for. Only when there is a plugin store to
           * ask: a deployment with no connectors routes exactly as it did.
           */
          pluginStore
            ? async (agentId) => {
                const granted = await pluginStore.listForAgent(agentId);
                return [
                  ...new Set(
                    granted.tools.map(
                      (tool) =>
                        tool.toolName.replace(/^mcp__/, "").split("__")[0] ??
                        tool.toolName,
                    ),
                  ),
                ];
              }
            : undefined,
        ),
      );
    }
  }

  if (channelStore) {
    app.route(
      "/api/channels",
      createChannelRoutes(channelStore, requireUser, channelEvents, auditStore),
    );
  }

  /*
   * The Bot's memory, files, tasks and schedules, for the settings screens. The agent reaches
   * the same rows through its tools; these routes are the person's own view of that shared
   * state. Mounted wherever there is a database to read them from.
   */
  if (attachmentDatabase) {
    app.route(
      "/api/remi",
      createRemiRoutes({
        database: attachmentDatabase,
        requireUser,
        ...(blobStore ? { blobs: blobStore } : {}),
      }),
    );
  }

  /*
   * Telegram link management for the settings screen. Always mounted where there is a
   * database: without a bot token the routes answer 503, and the screen says Telegram is
   * not configured rather than drawing a code box that goes nowhere.
   */
  if (attachmentDatabase) {
    const tg = telegram ?? {};
    app.route(
      "/api/telegram",
      createTelegramRoutes({
        database: attachmentDatabase,
        requireUser,
        ...(tg.token ? { token: tg.token } : {}),
        ...(tg.username ? { username: tg.username } : {}),
      }),
    );
  }

  if (attachmentDatabase) {
    /*
     * `bodyLimit` sits in front of the upload route itself, not beside the mount below: the handler
     * in channels/attachments.ts calls `file.arrayBuffer()` before it has looked at a single byte of
     * size, so an unbounded body is read into memory in full before anything gets the chance to
     * refuse it. A person (or an attacker) posting a 2GB body would have it buffered in RAM before
     * the 413 the handler already knows how to return. `MAX_IMAGE_BYTES` is the largest thing this
     * route could ever legitimately accept — a text upload is refused smaller, inside the handler,
     * once the sniffed type is known — so refusing anything larger at the door costs nothing a real
     * upload was ever going to use.
     *
     * The ceiling is `UPLOAD_BODY_LIMIT_BYTES` and not `MAX_IMAGE_BYTES` itself because THIS GATE
     * MEASURES A DIFFERENT THING FROM EVERY OTHER ONE. See that constant.
     */
    const channelAttachments = new Hono<{ Variables: AppVariables }>();
    channelAttachments.use(
      "*",
      bodyLimit({
        maxSize: UPLOAD_BODY_LIMIT_BYTES,
        /*
         * THE REFUSAL AT THE DOOR HAS TO LOOK LIKE THE HANDLER'S OWN.
         *
         * hono's default `onError` answers with the plain string "Payload Too Large". The composer
         * (app/src/components/channels/composer/attachments.ts) reads `{ error }` off every failed
         * upload and falls back to a generic `Could not upload "<name>"` when the body will not
         * parse as JSON — so the default body cost the person the one sentence that would have told
         * them what went wrong, on the single refusal where the reason is both knowable and
         * actionable. This is the same `{ error }` shape and the same number the handler's own 413
         * names, so the two paths are indistinguishable from the outside.
         *
         * THE FILENAME AND THE KIND ARE BOTH DELIBERATELY ABSENT, and for the same reason: nothing
         * has parsed the multipart body at this point, which is the entire reason this middleware
         * runs ahead of the handler. The handler's sentences can say `'notes.txt' is larger than the
         * 1MB limit for files` because by then it has sniffed the bytes. This one cannot, and must
         * not guess — a 9MB text file refused here as being over "the 8MB limit for images" would
         * send somebody off to shrink it to 7MB, whereupon the handler would refuse it a second time
         * with a different number. So the sentence names the only thing that is true of every body
         * this gate rejects: none of them can be under the largest ceiling the route has.
         */
        onError: (context) =>
          context.json(
            {
              // The same rounding as `megabytes` in channels/attachments.ts, so the door and the
              // handler name one limit in one voice.
              error: `That upload is larger than the ${(MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(0)}MB limit.`,
            },
            413,
          ),
      }),
    );
    channelAttachments.route(
      "/",
      createChannelAttachmentRoutes(attachmentDatabase, requireUser),
    );
    app.route("/api/channels", channelAttachments);

    app.route(
      "/api/attachments",
      createAttachmentRoutes(attachmentDatabase, requireUser),
    );
    app.route(
      "/api/billing",
      createBillingRoutes(attachmentDatabase, requireUser),
    );
    app.route("/api/webhooks", createDodoWebhookRoutes(attachmentDatabase));
  }

  if (routineStore) {
    app.route("/api/routines", createRoutineRoutes(routineStore, requireUser));
  }

  /*
   * The vault, under `/api/vault`.
   *
   * Mounted only when a store exists, and mounted whole rather than feature by feature: a deployment
   * with no vault store has no door, and one with a partial vault would be a half-built lock.
   *
   * Every route inside takes its owner from the session and takes nothing else, so there is no path
   * through this router on which a caller names whose vault it is reaching into. See `vault/routes.ts`.
   */
  if (vaultStore) {
    app.route(
      "/api/vault",
      createVaultRoutes(vaultStore, requireUser, auditStore),
    );
  }

  if (componentStore) {
    app.route(
      "/api/components",
      createComponentRoutes(componentStore, requireUser, auditStore, canUseBot),
    );
  }

  if (pluginStore) {
    app.route(
      "/api/plugins",
      createPluginRoutes(
        pluginStore,
        requireUser,
        canUseBot,
        canManageBot,
        {
          encryptionKey: config.keyEncryptionKey,
          /*
           * Whether the person a consent was started for still has access, asked when the callback
           * lands rather than when the flow began.
           *
           * The callback carries no session — identity comes from the state — so this is where the
           * question gets asked at all. `find` answers both halves of it: no row means a user id that
           * names nobody, and `revoked` means an administrator removed them while they were away at
           * the vendor. Either way there is no live person for a fresh refresh token to belong to.
           *
           * No people store means this deployment cannot answer the question, so it refuses rather
           * than assuming yes. It also cannot remove anybody, which is exactly why guessing here
           * would be a hole nothing else closes.
           */
          personHasAccess: async (userId) => {
            // Individual-user SaaS has no people list and nobody to revoke:
            // the question is only whether this user id names a live account.
            // No database to ask means the deployment cannot answer, so it
            // refuses rather than assuming yes.
            if (!attachmentDatabase) return false;
            const rows = await attachmentDatabase
              .select({ id: users.id })
              .from(users)
              .where(eq(users.id, userId))
              .limit(1)
              .catch(() => []);
            return rows.length > 0;
          },
          // The deployment-wide fallback a Bot may present, as a yes or no. The secret itself stays
          // in config and is checked in `/api/agent-tools/call`; the surface only needs to know
          // whether a Bot without its own credential has any way to call back.
          botsMayCallBack: Boolean(config.agentToolToken),
          publicUrl: config.publicUrl,
          appUrl: config.appUrl,
        },
        composio,
        skillDrafter,
      ),
    );
  }

  /*
   * Where a framework Bot runs a tool.
   *
   * A Bot that runs its own loop, in its own process, is the honest shape: the run does not need a
   * browser and does not stop when one closes. What it must not have is a route to a vendor that
   * goes around this deployment, so it calls here and this calls the plugin store, which asks the
   * same two questions it asks of everything else and writes the same audit row.
   *
   * Authenticated by a shared secret rather than a session, because the caller is a service and has
   * no person behind it. Absent secret means the route does not exist: a deployment that has not
   * configured this refuses rather than accepting anybody who can reach the port.
   */
  if (pluginStore || deploymentToolCaller) {
    const legacyToken = config.agentToolToken ?? "";
    app.post("/api/agent-tools/call", async (context) => {
      /*
       * Who is calling, and on whose behalf. Two questions, two credentials.
       *
       * The header says which agent: its own token, issued to it, stored here only as a hash. The
       * body's `run` says which Bot and which person, signed by this deployment for this run.
       *
       * Both are required, and they are checked against each other. This used to be one
       * deployment-wide token with the Bot and the actor read straight out of the body, which meant
       * anything holding that token could spend any Bot's grants and write any name into the audit
       * trail. A forgeable trail is worse than no trail, because it is believed.
       */
      const body = (await context.req.json().catch(() => null)) as {
        name?: string;
        args?: Record<string, unknown>;
        run?: unknown;
      } | null;

      const verdict = await authoriseAgentCall({
        presented: context.req.header("x-remii-agent-token") ?? "",
        run: body?.run,
        encryptionKey: config.keyEncryptionKey,
        legacyToken,
        lookup: async (hash) =>
          (await agentProfileStore?.agentForCallbackToken(hash)) ?? null,
      });
      if (!verdict.ok) {
        /*
         * Recorded, because this is a boundary being held and every other one here leaves a row.
         *
         * The three outcomes inside `callTool` are all written after the caller has proved which Bot
         * it is. A caller that fails to prove it never reaches them, so this refusal used to leave
         * nothing at all — and it is the refusal behind the product's most confusing failure: a Bot
         * whose token no longer matches the deployment's has every call rejected here, returns
         * nothing to its own model, and the model tells the person there were no results. A false
         * negative delivered as an answer, with the trail agreeing nothing had happened.
         *
         * No Bot id and no actor. Both live in the credential that just failed to verify, so writing
         * them down would put an unproven claim in the record. The tool name comes from the body and
         * is capped for the same reason: it is untrusted input, kept because "which tool was being
         * reached for" is the useful half of the question.
         */
        if (auditStore) {
          await recordAuditEvent(auditStore, {
            eventType: "mcp.callback_refused",
            targetType: "mcp_tool",
            initiator: DEPLOYMENT_INITIATOR,
            targetId:
              typeof body?.name === "string"
                ? body.name.slice(0, 120)
                : "unknown",
            payload: {
              refusal: verdict.reason,
              status: verdict.status,
              note: "A caller could not prove which Bot it was, so no grant was consulted.",
            },
          });
        }
        return context.json({ error: verdict.reason }, verdict.status);
      }

      const parsedCall = parseAgentToolCallInput(body);
      if (!parsedCall.ok) {
        return context.json({ error: parsedCall.error }, 400);
      }

      try {
        const deploymentResult = await deploymentToolCaller?.({
          name: parsedCall.value.ref,
          args: parsedCall.value.args,
          botId: verdict.botId,
          actorId: verdict.actorId,
          initiator: verdict.initiator,
          ...(verdict.threadId ? { threadId: verdict.threadId } : {}),
        });
        if (deploymentResult) return context.json(deploymentResult);

        if (!pluginStore) {
          return context.json({
            text: `${REFUSAL_MARKER} That tool is not registered in this deployment.`,
            isError: true,
          });
        }

        const result = await pluginStore.callTool({
          ref: parsedCall.value.ref,
          args: parsedCall.value.args,
          botId: verdict.botId,
          // From the assertion, never the body: this is the name the audit row will carry.
          actorId: verdict.actorId,
          ...(verdict.initiator ? { initiator: verdict.initiator } : {}),
        });
        // Worded by the helper the in-process door uses, so a framework Bot's model reads a vendor's
        // error as the vendor's and not as a result. Neither Bot words it on its way through.
        return context.json({
          text: vendorAnswer(result),
          isError: result.isError,
        });
      } catch (error) {
        /*
         * A refusal is an answer, not a failure: the Bot says what was blocked and carries on. The
         * marker leads it so a transcript can draw a refusal without reading the wording.
         *
         * AND THE SAME QUESTION THE IN-PROCESS DOOR ASKS, which this one asked of nothing at all.
         *
         * CRITERION. Nothing on the `isDeploymentFault` shelf has its message relayed from here,
         * and nothing leaving here carries a statement or a value bound to one.
         *
         * WHAT THIS SURFACE IS. The answer goes into the calling Bot's model as the tool result, so
         * it is the widest audience an error message in this deployment reaches: a model repeats
         * what it is handed — to the person asking, into whatever it writes next, and to the next
         * tool it calls. `plugins/tools.ts` wraps the identical `callTool` for a Bot running in
         * this process and has refused that shelf for exactly this reason since the
         * `ServerRowAmbiguousError` finding; the two doors to one store disagreeing meant a query
         * failure came back as `Failed query: … params: linear, usr_…` through one of them and as a
         * fixed sentence through the other. Which door a Bot arrives at is a deployment topology
         * decision and was never a disclosure decision.
         *
         * AND THROUGH {@link withoutStatement} AS WELL, because the two answer different questions
         * and `isDeploymentFault` says so itself: it "settles who may be told, not what". The shelf
         * decides whether this audience may hear a sentence at all; the door decides what any
         * sentence is allowed to contain. Today the two overlap on a query failure and this arm can
         * only be reached by something neither recognises — which is exactly the state the last two
         * findings in this area were found in, one predicate apart from a leak.
         *
         * AND ONLY A REFUSAL CARRIES THE MARKER, which is the in-process door's third question. The
         * transcript draws an answer that starts with it as a boundary holding, and the model reads
         * "Refused." as "not allowed". `callTool` throws `PluginRefusedError` for that, and rethrows
         * a vendor that broke after recording `mcp.call_failed`; marking every throw drew a vendor
         * outage, or a fault of this deployment's own, as a policy refusing.
         */
        if (error instanceof PluginRefusedError) {
          return context.json({
            text: `${REFUSAL_MARKER} ${withoutStatement(error)}`,
            isError: true,
          });
        }
        return context.json({
          text:
            error instanceof Error && !isDeploymentFault(error)
              ? `That tool could not be called: ${withoutStatement(error)}`
              : "That tool could not be called.",
          isError: true,
        });
      }
    });
  }

  if (sandboxedStore) {
    app.route(
      "/api/sandboxed",
      createSandboxedRoutes(sandboxedStore, requireUser),
    );
  }

  if (threadIdentity) {
    app.route(
      "/api/threads",
      createThreadRoutes(
        threadIdentity,
        requireUser,
        // Threads live in this deployment's Postgres (see threads/local), so
        // the reader is a row lookup, not a platform call. Absent database
        // there is nothing to ask and only minting is registered.
        attachmentDatabase
          ? createThreadReader({
              getThread: async ({
                threadId,
                userId,
              }: {
                threadId: string;
                userId: string;
              }) => {
                const rows = await attachmentDatabase
                  .select({ id: threads.id })
                  .from(threads)
                  .where(
                    and(eq(threads.id, threadId), eq(threads.userId, userId)),
                  )
                  .limit(1);
                if (rows.length === 0) {
                  const missing = new Error("Thread not found.");
                  (missing as { status?: number }).status = 404;
                  throw missing;
                }
                return rows[0];
              },
            })
          : undefined,
        attachmentDatabase
          ? async (threadId: string, userId: string) => {
              await attachmentDatabase
                .insert(threads)
                .values({ id: threadId, userId })
                .onConflictDoNothing();
            }
          : undefined,
      ),
    );
  }

  /*
   * The built app, served by the API that serves it.
   *
   * WHY THE SAME PROCESS. There is no CORS anywhere in this server, deliberately, so the app has to
   * reach `/api` on its own origin. Two containers behind one ingress does that too, and costs a
   * path rule on every deployment plus a way for the two to disagree about which host they are on.
   * One process cannot disagree with itself.
   *
   * MOUNTED LAST, so every `/api` route above already claimed its path. The catch-all below would
   * otherwise answer an unmatched `/api` call with the app's HTML, which is the failure that reads
   * as "the API returned HTML" and takes an hour to place.
   *
   * Absent in development: Vite serves the app and proxies `/api` here, so `APP_DIST_DIR` is unset
   * and none of this mounts.
   */
  if (config.appDistDir) {
    const root = config.appDistDir;
    app.use("/*", serveStatic({ root }));
    /*
     * A single-page app owns its routing, so a path with no file behind it is not missing: it is a
     * route the browser resolves once index.html has loaded. Without this, every deep link and every
     * refresh away from `/` is a 404, which is the classic way this deployment shape breaks.
     *
     * Written out rather than a second `serveStatic`, whose `path` option is resolved relative to the
     * working directory and silently matches nothing when handed the absolute root used above.
     *
     * `/api` is excluded so an unmatched API route still answers as one. Returning the app's HTML to
     * a fetch that expected JSON is the failure that gets read as "the API returned HTML".
     */
    app.get("*", async (context) => {
      if (context.req.path.startsWith("/api")) return context.notFound();
      const index = Bun.file(`${root}/index.html`);
      if (!(await index.exists())) return context.notFound();
      return new Response(index, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
  }

  return app;
}

function _credentialInput(
  value: unknown,
  actorUserId: string,
): CredentialInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  /*
   * An allowlist, and deliberately narrower than `CredentialKind`.
   *
   * `CredentialKind` is derived from the schema enum, so it now includes `mcp_oauth_client` and
   * `mcp_user_token`. Neither belongs here. A user token is somebody's own grant and exists only as
   * the outcome of a consent they gave; a client is registered when a connector is added. Both are
   * written by the code that owns those flows, and an administrator hand-posting either would be
   * creating a credential attributed to a person who never agreed to it.
   *
   * So this list is not out of date with the enum — do not widen it to match.
   */
  if (
    (body.kind !== "model" &&
      body.kind !== "connector" &&
      body.kind !== "mcp") ||
    typeof body.provider !== "string" ||
    !body.provider.trim() ||
    typeof body.keyId !== "string" ||
    !body.keyId.trim() ||
    typeof body.plaintext !== "string" ||
    !body.plaintext ||
    !body.metadata ||
    typeof body.metadata !== "object" ||
    Array.isArray(body.metadata) ||
    Object.getPrototypeOf(body.metadata) !== Object.prototype
  ) {
    return null;
  }

  return {
    kind: body.kind,
    provider: body.provider.trim(),
    keyId: body.keyId.trim(),
    metadata: body.metadata as Record<string, unknown>,
    plaintext: body.plaintext,
    actorUserId,
  };
}
