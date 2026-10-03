import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AbstractAgent } from "@ag-ui/client";
import { serve } from "bun";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { COMPUTER_GUIDANCE } from "../../shared/bot-prompt";
import { computerBotIdSignature } from "../../shared/computer-token";
import { effectiveIdleStopMinutes } from "../../shared/desktop-idle";
import { botHoldsTheComputer, REMII_AGENT_ID } from "../../shared/remii";
import { workOwner } from "../../shared/work-owner";
import { startAbandonedRunSweeps } from "./activity/abandoned-sweeper";
import { startRunActivityListener } from "./activity/listen";
import {
  createRunActivityStore,
  type RunActivityEvent,
  type RunActivityStore,
} from "./activity/store";
import { startActivitySweeps } from "./activity-retention";
import {
  mintRunAssertion,
  readRunAssertion,
  sameToken,
} from "./agents/callback-token";
import { connectAppTool } from "./agents/connect-app";
import { askTheirOwnPerson, escalationTool } from "./agents/escalation";
import { createHandoffDesk, HANDOFF_KIND } from "./agents/handoff";
import { createHandoffDelivery } from "./agents/handoff-delivery";
import { createHandoffRunner } from "./agents/handoff-runner";
import { signHandoffDeliveryRun } from "./agents/handoff-signing";
import { delegateTool, handoffTool } from "./agents/handoff-tool";
import { resolveOwnChannel } from "./agents/own-channel";
import { createAgentProfileStore } from "./agents/profile-store";
import type { AgentActor } from "./agents/profile-types";
import { createRuntimeAgentLoader } from "./agents/runtime-agents";
import { toolsForSupervisorGate } from "./agents/supervision";
import { createApp, requireUserFor } from "./app";
import {
  type AuditInitiator,
  createAuditReader,
  createAuditStore,
  DEPLOYMENT_INITIATOR,
  PERSON_INITIATOR,
  recordAuditEvent,
} from "./audit";
import { startRetentionSweeps } from "./audit-retention";
import { createAuth } from "./auth";
import { DEV_ACTOR, initializeDevActorUser } from "./auth/dev-actor";
import type { RemiiRole } from "./auth/guards";
import { createIdentityProviderStore } from "./auth/identity-provider-store";
import { periodEnd } from "./billing/budget";
import { createComputerMeter, startIdleSweeps } from "./billing/computer-meter";
import {
  deductTurnCredits,
  EnforcedAgent,
  MAX_TURN_TOOL_CALLS,
  planCoverage,
  recordUsage,
  verifyTurnEligibility,
} from "./billing/metering";
import { limitsForUser, outOfAllowance } from "./billing/meters";
import { PLANS } from "./billing/plans";
import {
  loadAttachmentForTurn,
  markAttachmentsSent,
} from "./channels/attachments";
import {
  CHANNEL_ACTIVITY_TOPIC,
  type ChannelActivityEvent,
  createChannelEventHub,
  startChannelActivityListener,
} from "./channels/events";
import { createChannelStore } from "./channels/routes";
import { websocket as channelSocket } from "./channels/socket";
import { createStallGuard, MAX_CHANNEL_RUN_MS } from "./channels/stall-guard";
import {
  forgetSettledSummaries,
  offerChannelsAwaitingSummary,
  summariseClaimedChannels,
} from "./channels/summary";
import { createThreadIdentity } from "./channels/thread-identity";
import { createChannelTitler } from "./channels/titler";
import { createSandboxedStore } from "./components/sandboxed";
import { createComponentStore } from "./components/store";
import { seedComputerSkills } from "./computer/computer-skill-seed";
import { createDesktopControlRoutes } from "./computer/desktop-control";
import {
  requestSecret,
  secretWantedFor,
  supplySecret,
} from "./computer/desktop-secrets";
import type {
  DesktopComputerUse,
  DesktopMachine,
  DesktopStreamSession,
} from "./computer/desktop-stream";
import { desktopToolsFor } from "./computer/desktop-tools";
import {
  captureScreenshot,
  computerUseFor,
  type E2BDesktopLike,
  machineFor,
} from "./computer/e2b-desktop";
import { DESKTOP_RESOLUTION } from "./computer/e2b-sdk";
import { createComputerGateway } from "./computer/gateway";
import { createPageFrameStore } from "./computer/page-frames";
import { startPolicyListener } from "./computer/policy-listener";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "./computer/policy-store";
import type { ComputerProvider } from "./computer/provider";
import {
  describeComputerIsolation,
  describeHostedIsolation,
} from "./computer/provider";
import { createComputerProvisioner } from "./computer/provisioner";
import { createSnapshotStore } from "./computer/snapshot-store";
import { computerToolsFor } from "./computer/tools";
import { createUserComputerStore } from "./computer/user-computers";
import { loadConfig } from "./config";
import {
  type IdentifyActor,
  type IdentifyUser,
  mountCopilotRuntime,
  normalizeModelBaseUrls,
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
  type ToolSelection,
} from "./copilot";
import {
  createCredentialStore,
  createCredentialWriteService,
  resolveModelApiKey,
} from "./credentials";
import { createDatabase } from "./db/client";
import {
  agentProfiles,
  computerScopes,
  intelligenceChannelMappings,
  memories,
} from "./db/schema";
import { askFirstGuidance, createExecutionModeStore } from "./execution-mode";
import { createHostAccessBroker } from "./host-access/broker";
import { hostAccessTools } from "./host-access/tools";
import { createOnboardingStore } from "./people/onboarding";
import { useRoutineTools } from "./plugins/builtin-routines";
import { useComposioClient } from "./plugins/composio";
import { createComposioClient } from "./plugins/composio-adapter";
import { redirectUriFor } from "./plugins/oauth";
import { createPluginStore } from "./plugins/store";
import {
  grantedSkills,
  grantedTools,
  REFUSAL_MARKER,
  toolResultText,
} from "./plugins/tools";
import { BOT_ADMIN_TOOL_NAMES, botAdminToolsFor } from "./remi/bot-admin";
import {
  COMPOSIO_TOOL_NAMES,
  searchAndBatchToolsFor,
  waitToolFor,
} from "./remi/composio-tools";
import { runCronTick } from "./remi/cron";
import { GOG_TOOL_NAMES, gogToolsFor, resolveGogBinary } from "./remi/gog";
import { createRemiInstanceStore } from "./remi/instance";
import { extractMemoriesAfterRun } from "./remi/memory-extract";
import { recallHooksFor } from "./remi/memory-router";
import { createRemiStore } from "./remi/store";
import { REMI_TOOL_NAMES, remiToolsFor } from "./remi/tools";
import { createTurnRunner } from "./routines/run-turn";
import { createRoutineRunner } from "./routines/runner";
import { createRoutineStore } from "./routines/store";
import { createIntentRouter } from "./routing/classify";
import { createModelCompleter } from "./routing/model";
import type { BlobStore } from "./storage/blob-store";
import { createLocalBlobStore } from "./storage/local-blob-store";
import { createS3BlobStore } from "./storage/s3-blob-store";
import {
  createPackageStatusReader,
  loadTenantPackage,
  synchronizeTenantPackage,
} from "./tenant-package";
import {
  createLocalIntelligence,
  createThreadLock,
  createThreadStore,
  PostgresAgentRunner,
} from "./threads/local";
import { createUserInstructionsStore } from "./user-instructions";
import { createVaultStore } from "./vault/store";
import { vaultToolsFor } from "./vault/tools";
import { repeatAfterEach } from "./work/loop";
import {
  createWorkQueue,
  startWorkOfferedListener,
  type WorkOfferedListener,
} from "./work/queue";

/**
 * Who is asking, for a CopilotKit request.
 *
 * One resolver, because a run has two questions to answer about the same person: whose threads and
 * memory these are, and which coworkers they may run. Answering them from different places is how
 * one person ends up running another's private coworker, or reading their thread.
 */
async function resolveRequestActor(request: Request): Promise<{
  id: string;
  name: string;
  role: RemiiRole;
}> {
  if (config.singleUser) {
    return { id: DEV_ACTOR.id, name: DEV_ACTOR.email, role: DEV_ACTOR.role };
  }
  const session = await auth?.api.getSession({ headers: request.headers });
  const user = session?.user;
  if (!user) {
    throw new Error("A CopilotKit run requires a signed-in user.");
  }
  // Signed in is the whole bar; every row the run touches is scoped to this
  // id, and there is no role that overrides it.
  return {
    id: user.id,
    name: user.name ?? user.email ?? user.id,
    role: "user",
  };
}

/** The Intelligence projection of {@link resolveRequestActor}: threads are scoped to this person. */
const identifyUser: IdentifyUser = async (request) => {
  const { id, name } = await resolveRequestActor(request);
  return { id, name };
};

/**
 * The authorization projection of the same person: agent visibility is decided from this.
 *
 * An unauthenticated request resolves to a person who owns nothing rather than an error, so the
 * runtime can still describe itself, `/info` reports the licence and the public roster, which is
 * what a deployment check reads to tell "the licence is invalid" apart from "chat is silently
 * broken". It grants nothing: this actor matches no private profile and is not an administrator,
 * and a run still fails in `identifyUser`, which has no anonymous case because a thread must belong
 * to somebody.
 */
const ANONYMOUS_ACTOR = { id: "", role: "user" } as const;

const identifyActor: IdentifyActor = async (request) => {
  try {
    const { id, role } = await resolveRequestActor(request);
    return { id, role };
  } catch {
    return ANONYMOUS_ACTOR;
  }
};

const config = loadConfig();
// Read with the rest of the configuration, where an empty variable is an absent one. See
// `serverPort` in config.ts for what `process.env.PORT ?? …` did with `PORT=` instead.
const port = config.port;
const database = createDatabase(config.databaseUrl);

/**
 * What every run is doing, for the roster and the status line. Needs only the database, so it is
 * built before the stores that read from it rather than after.
 */
const runActivityStore = createRunActivityStore(database);

/**
 * The one place a storage driver is chosen.
 *
 * LOCAL BY DEFAULT AND THE DEFAULT IS THE POINT. A deployment that has never heard of this starts
 * and works, which is also why the local driver's directory is derived rather than required: a new
 * variable every existing deployment must be given before the process will boot is a variable that
 * will be got wrong on somebody's first upgrade.
 *
 * The S3 branch is unreachable in this deployment — there is no bucket behind `S3_BUCKET`, and
 * `storageConfig` refuses a placeholder rather than resolving to somebody else's account — so this
 * is the seam a future migration goes through, not a path this process takes today.
 */
const blobStore: BlobStore =
  config.storage?.driver === "s3"
    ? createS3BlobStore({
        bucket: config.storage.bucket,
        region: config.storage.region,
        ...(config.storage.accessKeyId
          ? { accessKeyId: config.storage.accessKeyId }
          : {}),
        ...(config.storage.secretAccessKey
          ? { secretAccessKey: config.storage.secretAccessKey }
          : {}),
        ...(config.storage.endpoint
          ? { endpoint: config.storage.endpoint }
          : {}),
        forcePathStyle: config.storage.forcePathStyle,
      })
    : createLocalBlobStore(
        config.storage?.driver === "local"
          ? config.storage.rootDirectory
          : join(import.meta.dir, "..", "..", ".data", "files"),
      );
if (config.storage?.driver === "s3") {
  /*
   * SAID ONCE, AT BOOT, BECAUSE IT IS A HALF-MIGRATION AND HALF-MIGRATIONS ARE SILENT.
   *
   * Every file saved before this driver was configured is still on local disk, and this driver
   * cannot see it. Nothing about a request to one of those files will say so — the row is there,
   * the owner is right, and the bytes are on a disk this process is no longer reading. Somebody
   * looking at a Files page that has lost every file they had would have no way to know why, so it
   * is said here, once, where an operator will see it in the boot output.
   */
  console.warn(
    "[remii] FILE_STORAGE_DRIVER is 's3'. Files saved before this was configured are still on " +
      "local disk and are NOT visible to this driver until they are copied across.",
  );
}
await initializeDevActorUser(database, config.singleUser);
/*
 * The deployment's credential store: the API keys Remii itself calls a model with, and the keys a
 * connector holds on a person's behalf. A coworker carries no credential of its own — it runs on
 * this deployment's own engine and is authenticated with the deployment token — so nothing here is
 * read on a run.
 */
const credentialStore = createCredentialStore(database);
const agentVault = {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
};

/*
 * A person's saved information: logins, cards, their own details, and the items a coworker may reach
 * for.
 *
 * NOT THE SAME THING AS `agentVault` ABOVE, and the two names are close enough to be worth saying so
 * plainly. `agentVault` is the deployment's model credentials — the API keys Remii itself calls a
 * vendor with, owned by the deployment or by one person, and read on every run to build a model
 * client. This is the person-facing surface on the Vault settings screen: things they log in with,
 * pay with, and tell their coworker about.
 *
 * They share exactly one thing, which is deliberate: the AES-GCM helpers in `credentials.ts` and the
 * deployment's `KEY_ENCRYPTION_KEY`. A second encryption scheme for a second table of secrets would
 * mean a second key to rotate and a second thing to get wrong, and there is nothing about a card
 * number that makes it need different treatment from a model key.
 */
const vaultStore = createVaultStore(database, config.keyEncryptionKey);
const agentProfileStore = createAgentProfileStore(
  database,
  config.managedAgent?.endpoint,
);
// Read here rather than beside the synchronise below, because the package names the deployment and
// the channel store needs that name before it can mint a thread id.
const tenantPackage = await loadTenantPackage(config.tenantPackageDirectory);
const threadIdentity = createThreadIdentity(
  config.deploymentId ?? tenantPackage.tenantId,
);
const channelStore = createChannelStore(
  database,
  agentProfileStore,
  threadIdentity,
  // So a channel row can say what is happening in it, and not just what was last said.
  runActivityStore,
);
const channelEvents = createChannelEventHub();
/**
 * Which components each Bot may answer with.
 *
 * Nothing is seeded here. The catalogue is a fact about the build; a fork that ships four components
 * of its own should start with four rows, and the only thing that can enumerate them is
 * the app that compiled them. It announces itself on load; this process learns what exists from that,
 * and owns only what may be done with it.
 */
const componentStore = createComponentStore(database);
// Its own connection is held for the life of the process; announced activity from any instance
// arrives here and is fanned out to connected members.
const channelActivityListener = await startChannelActivityListener(
  config.databaseUrl,
  channelEvents,
);
/**
 * Run activity, announced by any instance and fanned out to the same sockets.
 *
 * Forwarded on the channel hub rather than over a socket of its own because the browser already has
 * one connection per person and already draws this on the roster row. A second stream would be a
 * second connection to keep, to authenticate, and to reason about ordering against the first.
 *
 * The payload is a run's state and not a run id: a client that had to ask what changed would ask on
 * every step of every run, and the writer had the state in its hand when it wrote the row.
 */
/*
 * The one thing that ends a run nobody is running.
 *
 * A settlement covers every run that ends while its process is alive. It covers none of the ones
 * that do not — a closed tab, a killed pod, a shut laptop — and an unsettled row keeps a channel's
 * working mark lit for the thirty days retention allows. This is the only thing that clears those, so
 * it is started unconditionally: a deployment that keeps every row still needs every row to be true.
 */
const _abandonedRunSweeper = startAbandonedRunSweeps(database, (event) =>
  runActivityStore.publish(event),
);

const _runActivityListener = await startRunActivityListener(
  config.databaseUrl,
  (event: RunActivityEvent) => {
    /*
     * Announced on the channel bus rather than over a socket of its own, because the browser already
     * has one connection per person and already draws this on the roster row. A second stream would
     * be a second connection to hold, authenticate and order against the first.
     *
     * The run's state travels, not a run id to fetch: a client that had to ask what changed would
     * ask on every step of every run, and the writer had the state in its hand when it wrote the
     * row.
     *
     * A `NOTIFY` rather than the hub's in-process `deliver`, because this listener exists to hear
     * runs started on ANY instance — including, usually, this one. Going through the bus is what
     * makes the single-replica case and the two-replica case behave identically.
     */
    if (!event.channelId) return;
    void database
      .execute(
        sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify({
          channelId: event.channelId,
          // This person alone. A run belongs to whoever started it, and single-user is a property
          // of this app rather than a role anybody grants.
          memberIds: [event.actorUserId],
          lastMessage: null,
          lastMessageAt: null,
          lastMessageAgentId: null,
          /*
           * A finished run CLEARS the mark rather than reporting itself.
           *
           * `done` is a real state and it is in the severity table, but a roster still showing
           * "Working" after a run ended is the exact failure this feature exists to prevent. Null is
           * the honest wire form for "nothing is running here now", and the client renders no mark
           * for it.
           */
          activity:
            event.state === "done"
              ? null
              : {
                  state: event.state,
                  label: event.label,
                  detail: event.detail,
                },
        } satisfies ChannelActivityEvent)})`,
      )
      .catch(() => {
        // A roster that misses one mark corrects itself on the next event, or on the next refetch.
        // This runs beside a server answering people and must not delay or fail any of them.
      });
  },
  undefined,
  // A reconnection means events crossed a gap and cannot be recovered, so clients are asked to
  // refetch rather than left with a roster that may be quietly wrong.
  () => channelEvents.resyncAll(),
);
const loadAgentsForActor = createRuntimeAgentLoader(
  database,
  config.managedAgent,
);
await synchronizeTenantPackage(database, tenantPackage);
const identityProviderStore = createIdentityProviderStore(database);
/*
 * Built before `auth` for the same reason the people store is: sign-in writes to the trail, and the
 * store that receives those rows has to exist before anything can sign in.
 */
const signInAuditStore = createAuditStore(database);
const auth = config.auth
  ? createAuth(config, database, signInAuditStore)
  : undefined;
const ownerOf = async (botId: string): Promise<string | null> => {
  try {
    const rows = await database
      .select({ owner: agentProfiles.ownerUserId })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, botId))
      .limit(1);
    return rows[0]?.owner ?? null;
  } catch {
    return null;
  }
};
/*
 * ONE computer provider, never two.
 *
 * The hosted desktop (E2B) and the per-Bot sandbox providers
 * cannot both be live. They are different products wearing the same name: one
 * is a persistent full desktop per PERSON, the other a Chromium per Bot. With
 * both wired, a single deployment has two code paths that can each create a
 * billed machine, and a caller reaching the wrong one leaves a sandbox that no
 * database row claims — which is exactly the orphan that was found running
 * under a stale name while this server was up.
 *
 * So the choice is made once, here, and the other path is not constructed at
 * all. An unreachable provider is a deployment mistake; a silently reachable
 * one is a bill.
 */
const desktopIsProvisioned = config.computer?.provider === "e2b";
/*
 * The legacy per-Bot provider, and it is never constructed.
 *
 * `createComputerProvider` throws on purpose — the Docker supervisor, the shared local browser, the
 * Kubernetes sandbox and the per-Bot sandboxes are all gone, and the desktop
 * below is the only computer this deployment has. Calling it inside a conditional made that throw
 * reachable: a deployment carrying an unknown `COMPUTER_PROVIDER` in its environment killed
 * itself at boot, and `server/scripts/cull-idle-computers.ts` did the same the moment it ran.
 *
 * Typed as the union rather than left to inference, because `const x = undefined` narrows to
 * `undefined` and every `computerProvider?.…` below it becomes `never` — which is the compiler
 * telling the truth about code that should not be here at all.
 *
 * Refused out loud instead of silently ignored: an operator who set `COMPUTER_PROVIDER=shared` and
 * got a server that booted would conclude the setting worked.
 */
const computerProvider: ComputerProvider | undefined = undefined;

/*
 * The computer-use skills, seeded once the provider decision above is known.
 *
 * NOT PART OF THE TENANT PACKAGE, and the reason is worth stating because a package looks like the
 * obvious place. A package is an operator's content: their Bots, their connectors, their workflows.
 * These four are Remii's own instructions for the hosted desktop that Remii itself operates. A
 * deployment with a computer and no package that happens to mention it would otherwise get a
 * Bot that can see the screen, click on it, and has been told nothing about looking before it clicks
 * — which is exactly the behaviour this seeding exists to prevent.
 *
 * Placed here rather than beside `synchronizeTenantPackage` so it can be conditioned on the provider
 * being an E2B desktop: a deployment with no computer should not be told how to use one. After the
 * package, so a slug collision resolves the way everything else here resolves it — first to take the
 * name keeps it.
 *
 * Failure is logged rather than fatal. A skill is instructions; a boot that refuses to serve a
 * working deployment over a missing instruction is a far worse outcome than a Bot that works
 * slightly less well, and the next boot tries again.
 */
if (desktopIsProvisioned) {
  await seedComputerSkills(database, REMII_AGENT_ID).catch((error: unknown) => {
    console.warn(
      JSON.stringify({
        type: "computer-skills-seed-failed",
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}

if (config.computer && !desktopIsProvisioned) {
  console.warn(
    JSON.stringify({
      type: "computer-provider-unsupported",
      provider: config.computer.provider,
      error:
        "This deployment has no per-Bot computer provider. Set E2B_API_KEY to use the hosted desktop, or unset it to run without a computer.",
    }),
  );
}

// What Bots may do on their computers. Configuration supplies the deployment's default; an
// administrator can change it while running, and a restart returns to the configured one.
const policyStore = createPolicyStore(
  config.computer?.policy ?? DEFAULT_ACTION_POLICY,
  database,
);
// A boundary an administrator set is read back before the first action is decided, so a restart no
// longer silently returns to the configured default.
const policySource = await policyStore.load();
/*
 * And kept current afterwards.
 *
 * A boundary an administrator changes arrives at one server. Without this, every other server keeps
 * enforcing what it read at boot, so a new deny rule stops roughly one action in N while the screen
 * and the audit row both report success. See policy-listener.ts.
 */
const policyListener = await startPolicyListener(
  config.databaseUrl,
  policyStore,
);

/*
 * Record which boundary this process started with.
 *
 * The trail records the boundary a process starts with, so later audit reads can distinguish the
 * configured default from any administrator-updated policy that was persisted before restart.
 *
 * Not awaited and never fatal. A deployment must not fail to start because its audit trail is
 * unavailable, and the row is a note for a reader rather than something the server depends on.
 */
const bootAuditStore = createAuditStore(database);
/**
 * Move a run to a state and announce it.
 *
 * One function for every transition, because the alternative is five call sites that each remember
 * to publish and one of which forgets. Never awaited by its callers: these run beside a run that is
 * answering somebody, and a record is not worth a stalled answer.
 */
const setRunActivity = (
  runId: string,
  state: Parameters<RunActivityStore["transition"]>[1],
  options?: {
    label?: string | null;
    detail?: string | null;
    error?: string | null;
  },
) => {
  void (async () => {
    const row = await runActivityStore.transition(runId, state, options);
    if (!row) return;
    await runActivityStore.publish({
      runId: row.runId,
      actorUserId: row.actorUserId,
      botId: row.botId,
      channelId: row.channelId,
      state: row.state,
      label: row.label,
      detail: row.detail,
      startedAt: row.startedAt.toISOString(),
      parentRunId: row.parentRunId,
    });
  })().catch(() => {});
};
/**
 * Which conversation a thread is shown in, or null when it is a scratch thread.
 *
 * Read per run rather than held, because the mapping is a row that a hop's own thread creates as it
 * goes, and a value cached at boot would be a value from before any of them existed. A scratch
 * thread maps to nothing, which is the point of a scratch thread — and a run there is still recorded,
 * with a null channel, because "no conversation to open" is not "nothing happened".
 */
const channelIdForThread = async (threadId: string): Promise<string | null> => {
  const [mapped] = await database
    .select({ channelId: intelligenceChannelMappings.channelId })
    .from(intelligenceChannelMappings)
    .where(eq(intelligenceChannelMappings.threadId, threadId))
    .limit(1)
    .catch(() => []);
  return mapped?.channelId ?? null;
};
// One store: the gateway writes through it, a route reads it, and the sweep below takes the old ones out.
const pageFrameStore = createPageFrameStore(database);
// Housekeeping on a schedule: audit rows when asked for, screenshots always, one timer. See audit-retention.ts.
const retentionSweeps = startRetentionSweeps(
  config.databaseUrl,
  config.auditRetentionDays,
  pageFrameStore,
);
/*
 * Finished runs, on the same schedule and behind the same advisory lock as the audit sweep, so the
 * two take turns rather than contending. Bounded by default where the audit trail is not, because
 * this table answers one question about the present. See activity-retention.ts.
 */
const activitySweeps = startActivitySweeps(
  config.databaseUrl,
  config.activityRetentionDays,
);
/*
 * The per-USER computer, for the hosted desktop.
 *
 * Built unconditionally from the database rather than from a provider object, because the row is
 * the authority on whether a user has a machine — not which provider object happens to be
 * configured, and not anything a chat or thread carries. The key lives here and is never handed to
 * the browser; the screen route below is the only way out of it.
 */
const userComputerStore = createUserComputerStore(database);

/**
 * What a person's computer time is costing them, and when to stop paying for it.
 *
 * One meter for the whole deployment, and the sweep it drives is the only thing that reclaims a machine
 * for real. `E2B_AUTOSTOP_MINUTES` is set one minute longer as a backstop for the case where this
 * process is the thing that died; it is not what stops the clock, because a Bot driving `computerUse`
 * over the API looks like activity to the platform and the sandbox would sit there billing.
 *
 * Declared here rather than beside the sweep further down, because the provisioner is built before the
 * sweep and needs the meter to close the sessions it opens — see `onSessionEnd` below. Moving it up is
 * safe: it depends on `database`, which is opened near the top of the file.
 */
const computerMeter = createComputerMeter(database);
const desktopProvisioner =
  config.computer?.provider === "e2b"
    ? createComputerProvisioner(userComputerStore, {
        apiKey: config.computer.apiKey,
        ...(config.computer.apiUrl ? { apiUrl: config.computer.apiUrl } : {}),
        template: config.computer.template,
        environment:
          process.env.NODE_ENV === "production" ? "production" : "development",
        /*
         * How long a desktop sits unused before it is PAUSED.
         *
         * Pause, not delete and not a cold stop: E2B's memory pause restores the desktop exactly as it
         * was — same windows, same browser session, same running programs — and it comes back in
         * seconds, where Daytona's stop was a one-to-two-minute VM boot. That difference is why ten
         * minutes is safe here. A person who left a desktop alone for ten minutes and came back used to
         * wait out a cold boot; now they wait for a memory snapshot to reload.
         *
         * Never shorter than the sweep's own decision, and for the reason it never was on Daytona:
         * an idle stop that fires before the sweep would pause a machine the sweep still considers
         * live. This one is the backstop for the case where this process is the thing that died.
         */
        autoStopMinutes: Math.max(
          config.computer.autoStopMinutes,
          desktopIdleStopMinutes() + 1,
        ),
        /*
         * E2B's kill-clock. This is a HARD ceiling — an hour on a Hobby account, 24 on Pro — and a
         * sandbox that reaches it is deleted outright, taking the desktop's windows and running
         * processes with it. So it is set to the account cap and pushed forward by the provisioner's
         * heartbeat for as long as somebody is using the computer. Without that heartbeat a person
         * watching a long task would lose their machine at the one-hour mark and find out from a dead
         * screen.
         */
        sandboxTimeoutMs:
          Number(process.env.E2B_SANDBOX_TIMEOUT_MS) || undefined,
        resolution: {
          width:
            Number(process.env.VNC_RESOLUTION_WIDTH) ||
            DESKTOP_RESOLUTION.width,
          height:
            Number(process.env.VNC_RESOLUTION_HEIGHT) ||
            DESKTOP_RESOLUTION.height,
        },
        /*
         * The user's disk, on a volume of their own.
         *
         * A volume each rather than one shared volume at a per-user subpath, which is how Daytona did
         * it. E2B mounts a volume whole and has no equivalent of Daytona's subpath-scoped FUSE mount,
         * so a shared volume would put every person's desktop on the same directory with no isolation
         * to be had afterwards. The volume name is derived from the user id, so a row lost by mistake
         * still finds its disk.
         */
        volumes: config.computer.volumes !== false,
        workspaceMountPath: config.computer.workspaceMountPath,
        /*
         * Bounded concurrency, because a person with many Bots could otherwise hold many machines.
         *
         * This is less pressing on E2B than it was on Daytona — there is no organisation-wide memory
         * pool to exhaust, and the failure was a hard "Total memory limit exceeded" that named no user
         * and landed on whoever asked next. It stays because the cost is per sandbox and per hour, and
         * a cap turns an unbounded bill into a refusal naming the person who is over the line.
         */
        maxRunningDesktopsPerUser: desktopConcurrencyLimit(),
        /*
         * The clock, closed by everything that stops a machine.
         *
         * The desktop tools already open a session on their first acting call, and the quota ceiling
         * already closes one. What nothing closed was a session whose machine was stopped for any
         * OTHER reason — the idle sweep reclaiming it, a person switching it off, a quota error taking
         * it away. Those all pause the sandbox, and the provider's bill stops with it, so the meter kept
         * charging nobody for a machine that was gone.
         *
         * The leak was silent and permanent rather than noisy. `computerMeter.open` declines to open a
         * second session while one is open, so the first machine stopped without closing its row
         * meant that person was never billed again for the life of the deployment while the platform's own
         * metering carried on — the two drifting apart with nothing to show for it.
         *
         * Both ends go through the same meter and `open`/`close` are idempotent on the open row, so
         * the ceiling closing a session the provisioner also closes costs nothing and charges once.
         */
        onSessionStart: (scope) => {
          void Promise.resolve(
            computerMeter.open({ userId: scope.userId, sandboxId: null }),
          ).catch(() => undefined);
        },
        onSessionEnd: (scope, reason) => {
          void Promise.resolve(
            computerMeter.close({ userId: scope.userId, reason }),
          ).catch(() => undefined);
        },
      })
    : null;

/*
 * NO PER-BOT DESKTOP, and that is the decision rather than an omission.
 *
 * There were two provisioners here: one desktop per person, and one per Bot. The second was built on
 * every boot and never called — `botComputerProvisioner` had no reader anywhere in the tree — and it is
 * the reason a person with five coworkers had five Bots each believing it owned a desktop.
 *
 * A computer costs $0.0828 an hour from the moment it starts, so a computer per Bot makes the price of
 * the product depend on how many coworkers somebody created. One computer per person is what makes a
 * flat $39 honest, and it is the shape the rest of this deployment already had: `user_computers` is
 * keyed on the person, the stream and the wheel address one screen, and the tools are offered to Remii
 * alone. Everything else uses connected apps, and asks Remii with `message_bot` when a job needs a
 * screen — which relays the answer back into the asking Bot's own conversation, so it costs the person
 * nothing.
 *
 * The per-Bot tables stay in the database for now rather than being dropped, because a migration that
 * deletes rows somebody might still be reading is not one to make in the same change as the decision to
 * stop writing them.
 */

/**
 * Which desktop model this deployment drives, for the boot isolation report.
 *
 * There is one now. This reports it rather than reading configuration, because the report's job is to
 * say what a machine is separated by and a value inferred from settings is a boundary the code might
 * not enforce — which is exactly what the previous version of this file did, naming the deployment
 * per-Bot on the strength of a provisioner that was built on every boot and never called.
 */
/**

/**
 * The idle sweep's timer, or null where there is no desktop to reclaim. Stopped on the way out.
 *
 * The provisioner is bound to a name first so the callback below does not need a non-null assertion:
 * the sweep only exists when there is a provisioner, and that is a fact the ternary establishes but a
 * closure cannot see.
 */
const idleProvisioner = desktopProvisioner;
const stopIdleSweeps = idleProvisioner
  ? startIdleSweeps({
      database,
      idleMinutes: desktopIdleStopMinutes(),
      onIdle: async (candidate) => {
        // `stopIdle` closes the session and pauses the sandbox in that order, because the platform bills
        // until the stop resolves and a session closed first would under-charge by however long the
        // stop took. Bound to a local because this is a callback and the narrowing above has lapsed.
        await idleProvisioner.stopIdle(
          { key: candidate.userId, userId: candidate.userId },
          "idle",
        );
      },
      onLog: (line) =>
        console.warn(JSON.stringify({ type: "desktop-idle", line })),
    })
  : null;

/**
 * ONE computer per person, stated rather than inferred.
 *
 * This used to ask whether the per-Bot provisioner had been built and report per-Bot if so, which meant
 * the boot audit told one story and the tools enforced another: that provisioner was constructed on every
 * boot and called from nowhere. A report is worth nothing unless it describes what the code actually
 * does, so this is now the one thing that is true.
 *
 * Not that the Bots share a screen. They do not drive one — Remii has the computer, and the rest work
 * through connected apps and hand screen work to Remii with `message_bot`, which relays the answer back
 * into the asking Bot's own conversation.
 */
const computerIsolationScope = (): "per-bot" | "per-person" => "per-person";

/**
 * This person's desktop, started if need be, as the tools want it.
 *
 * ONE resolver for the tools, the still frame and the live socket, and that is the point. They were
 * three copies, which is three places to forget something: the frame route never carried the machine,
 * so a Bot reading a file went through a screenshot path instead, and the socket resolved a sandbox
 * handle the tools did not have.
 *
 * Resolved per call rather than captured, because the desktop is stopped underneath — the four-minute
 * idle sweep switches it off — and a captured handle is a machine that no longer exists. The
 * provisioner caches its own verification for a few seconds, so per-call is cheap rather than a
 * round trip to the platform every time.
 */
const resolveDesktopFor = async (
  userId: string,
): Promise<{
  computerUse: DesktopComputerUse;
  machine: DesktopMachine;
  displayWidth?: number;
  displayHeight?: number;
} | null> => {
  if (!desktopProvisioner) return null;
  const row = await desktopProvisioner.ensureDesktop({ key: userId, userId });
  if (!row.sandboxId) return null;
  // `Sandbox.connect` also RESUMES a paused sandbox, which is what this wants and why it is safe to
  // call on every resolve: `ensureDesktop` above has already brought the desktop up and pushed the
  // kill-clock forward, so this is a handle for a machine that is running.
  const sandbox = (await desktopProvisioner.sandboxFor({
    key: userId,
    userId,
  })) as unknown as E2BDesktopLike;
  return {
    computerUse: computerUseFor(sandbox),
    /*
     * The measured geometry, carried on the resolved handle.
     *
     * Present so a screenshot can be scaled at capture time instead of being taken at native
     * resolution and downscaled by whoever receives it. The model-facing screenshot tool needs the
     * screen's width and cannot afford to ask the platform for it on every call: that is a round trip,
     * and it would sit between the model and the picture it is waiting for.
     */
    displayWidth: row.displayWidth ?? undefined,
    displayHeight: row.displayHeight ?? undefined,
    // Built per resolve rather than memoised: the adapter holds no state, it is a handful of closures
    // over the sandbox handle, and a cached one would outlive the sandbox it points at.
    machine: machineFor(sandbox),
  };
};

/**
 * Open one person's live screen, for the viewer and the browser's noVNC client.
 *
 * Resumed here rather than in the route because opening the screen IS a request to use the computer,
 * and a person who has just pressed "Take control" should not be looking at a spinner while a paused
 * desktop is resumed.
 *
 * The geometry comes from the ROW rather than from a second call to the desktop, because
 * `ensureDesktop` has just read it back from the running machine and recorded it. Asking again would
 * be a round trip to answer a question the database can answer.
 */
const openDesktopStream = async (
  userId: string,
): Promise<DesktopStreamSession> => {
  if (!desktopProvisioner) {
    throw new Error("This deployment has no desktop.");
  }
  /*
   * ONE call, not `ensureDesktop` followed by `streamUrlFor`.
   *
   * Those were two independent resolves of the same desktop, so every press of "take control" paid for
   * the platform round trips twice — and each one could independently be the slow one. The provisioner
   * now does the resolve, the clock, the geometry and the stream in a single pass and hands back all
   * of it, which is the difference between a screen that appears and a screen that appears after a
   * pause long enough to look broken.
   */
  const { url, authKey, width, height } = await desktopProvisioner.streamUrlFor(
    {
      key: userId,
      userId,
    },
  );
  return { url, authKey, width, height };
};

/**
 * Start the desktop now, while the model's first turn is still being thought about.
 *
 * The four-minute idle stop is what makes a flat monthly price honest, and it has one sharp edge: a
 * machine that has gone to sleep takes 60 to 120 seconds to come back. Nobody reads that as a machine
 * waking up — they read it as the product being slow, and on the first message of a conversation that is
 * the impression the whole product gets to make.
 *
 * So the clock is started in parallel with the thinking rather than on the first tool call that needs a
 * mouse. By the time Remii has read the message and decided what to do, the desktop has usually been up
 * for a minute already, and the wait disappears into work that was happening regardless.
 *
 * Deliberately fire-and-forget, and deliberately before the allowance check: this is an optimisation,
 * so a person who cannot afford the desktop must still be told so by the tool call rather than have
 * this silently fail. Its failures are swallowed because a prewarm that does not happen costs one cold
 * start, and a prewarm that throws inside a message handler costs the message.
 *
 * Single-flight per person, so three widgets on a page opening at once do not start three desktops.
 */
const warmingUp = new Set<string>();
function prewarmDesktop(userId: string): void {
  if (!desktopProvisioner || warmingUp.has(userId)) return;
  warmingUp.add(userId);
  void desktopProvisioner
    .ensureDesktop({ key: userId, userId })
    .catch(() => undefined)
    .finally(() => {
      // Released only once the machine is up, so a second message arriving during the 90-second start
      // does not fire a second start. A third arriving after that finds the desktop already warm and
      // returns from the provisioner's own cache.
      setTimeout(() => warmingUp.delete(userId), 5_000);
    });
}

const computerGateway = computerProvider
  ? createComputerGateway({
      provider: computerProvider,
      auditStore: bootAuditStore,
      policy: (actorId) => policyStore.get(actorId),
      // In Postgres, so the ref a click carries resolves against the snapshot that produced it even
      // when the snapshot was taken by another server. A Map here would be blank on every replica
      // but the one that snapshotted, and the boundary would decide with no element to look at.
      snapshots: createSnapshotStore(database),
      // So wiping a profile takes the pictures of its signed-in pages with it, which is what the
      // sentence on that button already promised.
      pageFrames: pageFrameStore,
      allowPrivateHosts: config.computer?.allowPrivateHosts,
      token: config.computer?.token,
      /*
       * Strict per-user SaaS sandbox: the computer is the (user, Bot)
       * pair's own, so one user's browser, files, shell and logins are never
       * reached through another's. Ownerless deployment templates are scoped
       * by the acting user instead (each user gets their own copy's worth of
       * computer), and a caller with no user behind it addressing one is
       * refused rather than run on a shared computer.
       */
      scopeOfBot: ownerOf,
      /*
       * Durable record of which (user, Bot) pair each scope key names, so a
       * replica that only lists the fleet reports real ids. Best-effort: a
       * missed write degrades one listing row, never an action.
       */
      scopeDirectory: {
        record: async (key, botId, owner) => {
          await database
            .insert(computerScopes)
            .values({ key, botId, owner, updatedAt: new Date() })
            .onConflictDoUpdate({
              target: computerScopes.key,
              set: { botId, owner, updatedAt: new Date() },
            })
            .catch(() => undefined);
        },
        lookup: async (key) => {
          const [row] = await database
            .select({
              botId: computerScopes.botId,
              owner: computerScopes.owner,
            })
            .from(computerScopes)
            .where(eq(computerScopes.key, key))
            .limit(1)
            .catch(() => []);
          return row ?? null;
        },
      },
    })
  : undefined;

/**
 * What a Bot can reach beyond its own computer.
 *
 * Built here rather than beside the component store because it needs the policy, and it needs the
 * same policy the computer gateway enforces rather than one of its own. A deployment that has said
 * "this Bot may not change anything in Jira" has said one thing, and it should not matter whether
 * the change would arrive through a browser or through a tool call.
 */
const sandboxedStore = createSandboxedStore(database, bootAuditStore);

/**
 * Composio, built ONCE: the client the transport calls through and the broker behind the app
 * directory are the same client, and the store below and the routes further down share it.
 *
 * ONE CLIENT, TWO SEAMS, INSTALLED TWO DIFFERENT WAYS, because the two are reached two different
 * ways. The transport is reached as a MODULE — `transportFor` maps a kind to one, exactly as the
 * builtin routines transport above is reached — so there is no constructor to hand a client to and
 * the registry is built at IMPORT TIME, long before there is configuration to read. That is why the
 * actions seam is installed globally, from here, the one place that has the key. The broker has no
 * such problem: it is an ordinary argument, passed to the store and to `createApp`.
 *
 * A DEPLOYMENT WITH NO KEY INSTALLS NEITHER, which is the state the transport is written for rather
 * than an edge of it. The seam stays null and every Composio listing and call refuses saying the
 * connector is not configured here; the store gets no broker and the app directory says the same.
 * Installing a client built from an absent key would turn all of that into a vendor error at first
 * use, which sends an operator looking for a broken Composio instead of at their own configuration.
 */
const composio = config.composioApiKey
  ? createComposioClient(config.composioApiKey)
  : null;
if (composio) useComposioClient(composio.actions);

const pluginStore = createPluginStore({
  database,
  auditStore: bootAuditStore,
  credentials: credentialStore,
  encryptionKey: config.keyEncryptionKey,
  policy: (actorId) => policyStore.get(actorId),
  /*
   * Where a vendor sends people back, for a vendor whose client this deployment registers itself.
   *
   * The same value the connect and callback routes build, from the same config field, because it has
   * to match what was registered character for character. Undefined without a public URL, which is
   * the honest state: there is nowhere for a consent flow to come back to, so there is nothing worth
   * registering.
   */
  redirectUri: config.publicUrl ? redirectUriFor(config.publicUrl) : undefined,
  /*
   * The same client the transport seam above was installed with, never a second one. Enabling an
   * app writes the row here and creates the auth config at the vendor, and a store holding a
   * different client from the one the call goes out through is two deployments' worth of state
   * behind one screen. Undefined without a key, which leaves enabling an app refused rather than
   * attempted.
   */
  broker: composio?.broker,
});

/*
 * Remi's brain store: memory, artifacts, todos and schedules, shared by every run's tools,
 * the cron ticker and the Telegram poller below. Embeddings use an OpenAI key when set and
 * a local hash otherwise (see server/src/remi/store.ts).
 */
const remiStore = createRemiStore({
  database,
  ...(process.env.EMBEDDINGS_API_KEY
    ? {
        embeddingsApiKey: process.env.EMBEDDINGS_API_KEY,
        ...(process.env.EMBEDDINGS_BASE_URL
          ? { embeddingsBaseUrl: process.env.EMBEDDINGS_BASE_URL }
          : {}),
      }
    : {}),
});

if (agentProfileStore.setOnAgentCreated) {
  agentProfileStore.setOnAgentCreated((agentId) =>
    pluginStore.syncDefaultGrants({ agentId }),
  );
}

/*
 * At boot, refresh Gmail tools if Composio is enabled, and synchronise default grants
 * (connected apps, composio accounts, and agent handoffs) across all agents.
 */
void (async () => {
  if (composio) {
    await pluginStore.refreshTools("composio-gmail").catch((error) => {
      console.warn(
        JSON.stringify({
          type: "composio-gmail-refresh-failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }
  await pluginStore.syncDefaultGrants().catch((error) => {
    console.error(
      JSON.stringify({
        type: "plugin-default-grants-sync-failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
})();

/*
 * Warm the slim server list at boot so the first settings page opens fast. Fire-and-forget:
 * boot must not wait on it, and a failure just means the first visitor warms it instead.
 */
void pluginStore
  .listServers({ slim: true })
  .then((rows) =>
    console.info(
      JSON.stringify({ type: "plugin-slim-warmed", servers: rows.length }),
    ),
  )
  .catch((error: unknown) =>
    console.error(
      JSON.stringify({
        type: "plugin-slim-warm-failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  );

/**
 * Routines, and the one moment its tools are told what to act on.
 *
 * The builtin transport is reached as a MODULE — `transportFor` maps a kind to one — so there is no
 * constructor to hand a store to and no request-time seam either: the transport registry is built at
 * import time, long before there is a database. So the store is installed here, once, from the place
 * that already owns building stores. Without this call the four tools are advertised and every one of
 * them refuses, which is the honest behaviour for a deployment that never wired it, and would be a
 * silent outage for this one.
 */
const routineStore = createRoutineStore(database);
useRoutineTools(routineStore);

/**
 * Where a Bot handing work to another gets decided.
 *
 * The queue is the one #216 shipped, shared with the idle-computer culler and with routines: durable
 * work claimed by whichever replica gets to it, leased so a dead replica's work comes back. A hop is
 * that, because the Bot being addressed will very likely run on a different pod from the Bot that
 * addressed it, and a hop held in memory is lost the moment either is rescheduled.
 */
const handoffDesk = createHandoffDesk({
  queue: createWorkQueue(database),
  profiles: agentProfileStore,
  // Read per hop and never held, so revoking a grant applies to the next hop rather than after a
  // restart.
  mayAddress: async (fromBotId, toBotId) =>
    fromBotId === REMII_AGENT_ID ||
    (
      await pluginStore
        .botsReachableFrom(fromBotId)
        // A grant that cannot be read is not a grant. Failing closed here costs a hop; failing open
        // would let a Bot address one nobody gave it because the database blinked.
        .catch(() => [] as string[])
    ).includes(toBotId),
  /*
   * Deferred rather than passed directly, because `actorFor` is defined further down with the rest
   * of the run-building collaborators. It is only ever called during a hop, long after this module
   * has finished loading.
   */
  actorFor: (userId) =>
    // Null rather than a throw: see the seam's own note. A role that cannot be read is not a role,
    // and the hop is refused with a sentence rather than ending the run in silence.
    actorFor(userId).catch(() => null),
  /*
   * The specialist's own THREAD, made if this person has not talked to it before.
   *
   * `direct` rather than `create`, because a hop is retried when delivery fails and a plain create
   * would leave an empty conversation behind for every attempt. Resolved from the person and the
   * Bot, never from anything the model supplied, so a hop can only land where the two of them
   * already meet.
   *
   * `.threadId`, AND THE DOT IS THE WHOLE BUG THIS FUNCTION HAD. It returned `.id` — the CHANNEL id
   * — and the delivery used the value as a thread id, so every delegation into a coworker's own
   * channel ran in a thread invented on the spot and named after the channel. The coworker's real
   * channel thread stayed empty, which is invisible from the backend and looks like nothing
   * happened: the work completed, the artifact was written, the coworker asked the person a
   * question, and none of it was anywhere the person could read. `handoff-tool.ts` promises the
   * model it is "doing the work now in its own channel, which is open in the sidebar", so the
   * promise was being made and broken on every single hop.
   *
   * A channel and a thread are two ids that look alike and mean different things, and this is the
   * third time they have been confused in this area (see also `channelId: ownThreadId` in
   * `handoff.ts`). The guard test added for it is named for the confusion rather than for the
   * symptom, so the next one is caught by name.
   */
  ownThreadFor: (userId, botId) =>
    resolveOwnChannel(userId, botId, channelStore.direct, actorFor),
  // The same reader the request path uses, so a delegation and the turn that made it agree about
  // which conversation they are in.
  channelIdForThread,
  /*
   * A hop was accepted, so the run that asked is now WAITING rather than working — and that is the
   * state a person most needs to see, because it is the one where nothing appears to be happening
   * locally while the work is genuinely in progress somewhere else.
   *
   * Labelled with the coworker it is waiting on, because "delegated" alone does not answer the
   * question the roster raised. The row it moves is the ASKER's, found by the run id the desk signed
   * for this hop; the addressed Bot's own run is recorded separately when it starts.
   */
  onDelegated: (input) => {
    void (async () => {
      const row = await runActivityStore.transition(
        input.fromRunId,
        "delegated",
        {
          label: `With ${input.toName}`,
          /*
           * A delegated run belongs to the CHANNEL THAT ASKED, which the run's own thread could not
           * tell us: a chat turn's thread is whatever the browser sent, and this row was landing with
           * no channel at all — so the roster could not answer "which conversation is this in" and
           * inferred it from the Bot instead. Naming it here is the one moment in a delegation where
           * the asking channel is known by name rather than looked up.
           */
          channelId: input.askingChannelId ?? null,
        },
      );
      if (!row) return;
      await runActivityStore.publish({
        runId: row.runId,
        actorUserId: row.actorUserId,
        botId: row.botId,
        channelId: row.channelId,
        state: row.state,
        label: row.label,
        detail: row.detail,
        startedAt: row.startedAt.toISOString(),
        parentRunId: row.parentRunId,
      });
    })().catch(() => {});
  },
  auditStore: bootAuditStore,
  caps: config.handoff,
});

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.policy_loaded",
  targetType: "policy",
  initiator: DEPLOYMENT_INITIATOR,
  payload: {
    ...policyStore.get(),
    source:
      policySource === "the database"
        ? "you, saved in this deployment"
        : config.computer?.policy
          ? "configuration"
          : "the built-in default",
    note:
      policySource === "the database"
        ? "Set while running and kept. A restart returns to this."
        : "The deployment default. Anything you set from here is kept.",
  },
}).catch(() => undefined);

/*
 * Record whether each Bot has a computer of its own.
 *
 * A shared provider is a fine way to run on a laptop, but the shared isolation state must be visible
 * rather than inferred.
 *
 * The hosted desktop is described from what it actually is rather than through the provider seam. A
 * desktop is not a `ComputerProvider`, so it arrives here as `undefined` and the boot audit
 * recorded "The computer feature is off" on a deployment that had a working, billing desktop
 * configured — the one report nobody should be able to get backwards.
 */
const isolation = desktopIsProvisioned
  ? describeHostedIsolation(computerIsolationScope())
  : describeComputerIsolation(computerProvider);

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.isolation_loaded",
  targetType: "computer",
  initiator: DEPLOYMENT_INITIATOR,
  payload: {
    isolation: isolation.isolation,
    note: isolation.note,
  },
}).catch(() => undefined);

console.info(
  JSON.stringify({
    type: "computer-isolation",
    // The legacy per-Bot provider is never constructed, so there is no provider name to read. What
    // there is to report is which computer this deployment drives.
    provider: desktopIsProvisioned ? "e2b" : "none",
    isolation: isolation.isolation,
    ...(isolation.warning ? { warning: isolation.warning } : {}),
  }),
);
/**
 * One Bot's endpoint must not take down the platform.
 *
 * Restarting a remote agent while a run is in flight resets the socket. The rejection reaches the top
 * of the process, and Bun kills the whole server: every other person's conversation, every other Bot
 * and the admin surface go with it, because somebody redeployed their own agent.
 *
 * That blast radius is created by design the moment people can register their own endpoints,
 * so it belongs to that feature. A remote agent is untrusted infrastructure: it will restart, it will
 * time out, it will close a stream halfway through, and none of that is exceptional.
 *
 * Logged loudly rather than swallowed. A process that hides unhandled rejections is worse than one
 * that dies, so this prints the full reason and keeps serving; what it must never do is stay quiet.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    JSON.stringify({
      type: "unhandled-rejection",
      message: reason instanceof Error ? reason.message : String(reason),
      code:
        reason && typeof reason === "object" && "code" in reason
          ? String((reason as { code: unknown }).code)
          : undefined,
      note: "The server kept running. A remote agent's connection failing must not stop everyone else.",
    }),
  );
});

/**
 * The watch on Bot streams, built once and shared by every run.
 *
 * It has to outlive the request that opens a stream: the sweep that notices a silent one is still
 * running long after the run request has been answered, because in Intelligence mode that request is
 * answered in about a second and the Bot keeps writing for as long as it has something to say.
 *
 * The same audit store as everything else, so a Bot that hangs is recorded beside what Bots do.
 */
const stallGuard = createStallGuard({
  stallMs: config.agentStallTimeoutMs,
  maxDurationMs: MAX_CHANNEL_RUN_MS,
  auditStore: bootAuditStore,
});

normalizeModelBaseUrls();
const runtimeModel = runtimeModelForEnvironment(tenantPackage.model);

const intentRouter = createIntentRouter({
  complete: createModelCompleter({
    model: runtimeModel,
    resolveApiKey: () =>
      resolveModelApiKey({
        encryptionKey: config.keyEncryptionKey,
        reader: credentialStore,
        provider: runtimeModel.provider,
        keyId: tenantPackage.model.credentialSecretRef,
        environment: process.env,
      }),
  }),
});

/**
 * Pass one of tool selection: which skills a message needs, on the deployment's own model.
 *
 * Built once rather than per request, because it holds nothing about a person: the key is resolved
 * on every call, so a credential rotated a moment ago is used by the next run.
 */
const chooseSkills = createModelCompleter({
  model: runtimeModel,
  resolveApiKey: () =>
    resolveModelApiKey({
      encryptionKey: config.keyEncryptionKey,
      reader: credentialStore,
      provider: runtimeModel.provider,
      keyId: tenantPackage.model.credentialSecretRef,
      environment: process.env,
    }),
});

/*
 * WHY THESE ARE NAMED CONSTANTS RATHER THAN ARGUMENTS WRITTEN INLINE.
 *
 * Two callers now build a Bot: a person's chat request, through `mountCopilotRuntime` below, and a
 * routine's headless turn, through `buildAgentFor` further down. They have to build the SAME Bot. A
 * routine that resolved its tools, its run assertion or its endpoint dialling through a second,
 * slightly different set of collaborators would be a Bot that behaves one way when a person asks and
 * another way at three in the morning, with nothing to point at. So each of these is written once and
 * passed to both.
 */

/** The deployment's model key, resolved per call so a credential rotated a moment ago is used next. */
const resolveRuntimeModelApiKey = () =>
  resolveModelApiKey({
    encryptionKey: config.keyEncryptionKey,
    reader: credentialStore,
    provider: runtimeModel.provider,
    keyId: tenantPackage.model.credentialSecretRef,
    environment: process.env,
  });

const hostAccessBroker = createHostAccessBroker();

/**
 * Whether this Bot is a supervisor, which is to say whether it is expected to
 * get work done by handing it to somebody rather than by doing it.
 *
 * ONE reader for all three gates below, because the failure mode of three
 * separate ones is a Bot that is a supervisor in the tool list and a worker at
 * the prompt — a hole nobody can see from inside the thing it is in.
 *
 * A read that fails says "not a supervisor", which leaves the Bot holding
 * exactly what it held before this flag existed. That is deliberate, and it is
 * the opposite of how a handoff grant fails closed: a grant that cannot be read
 * must not be assumed, because assuming one invents reach a Bot never had. Here
 * assuming a supervisor invents a *restriction*, and a transient database
 * blip would strip the tools off every worker in the workspace. Losing a tool
 * is a worse failure than keeping one.
 */
const isSupervisor = async (
  actorId: string,
  botId: string,
): Promise<boolean> => {
  const profile = await agentProfileStore
    .get({ id: actorId, role: "user" }, botId)
    .catch(() => null);
  return profile?.delegationOnly === true;
};

// Tools run here, not in the browser. Each connector still executes through the plugin store, so the
// grant, the policy and the audit row are exactly where they were. Host-folder tools are also
// server-dispatched: the selected Bot and the signed-in owner are bound here, then the desktop worker
// receives only opaque grant ids and relative paths.
const loadToolsForActor =
  (actorId: string, initiator: AuditInitiator = PERSON_INITIATOR) =>
  async (botId: string) =>
    /*
     * Gate one of three: a supervisor is given nothing here.
     *
     * This is where an app lives once it is connected — every Gmail action,
     * and the Composio workbench and shell that reach the rest of the catalogue
     * on demand. Handing those to a supervisor is handing it the work, so a
     * supervisor that keeps them is a supervisor in name only. Host access goes
     * with them: a shell on this machine is a capability, not an identity.
     */
    toolsForSupervisorGate({
      supervisor: await isSupervisor(actorId, botId),
      granted: () =>
        grantedTools({ store: pluginStore, botId, actorId, initiator }),
      alsoGranted: () => {
        /*
         * A Bot asking for a person, hoisted so BOTH tool sets can use it.
         *
         * A Bot blocked on a login, a payment or a QR code is a Bot waiting on a person, and the
         * roster is where a person looks. `waiting_on_you` is already the state for exactly that and
         * is already rendered in the sidebar, so this reuses it rather than inventing a second
         * signal. It lives here, above both branches, because the desktop tools need it as much as
         * the browser ones do and a second copy would be free to drift.
         *
         * The open run is found rather than passed in: tools are resolved per Bot, before there is a
         * run to read an id from, and the run that is asking for help is by definition the one still
         * open for this person. Fire-and-forget, because a roster that is a moment late is worth more
         * than a turn that fails.
         */
        const onHelpRequested = ({ reason }: { reason: string }) => {
          void (async () => {
            const open = await runActivityStore.open(actorId).catch(() => []);
            const run = open.find((row) => row.botId === botId);
            if (!run) return;
            await setRunActivity(run.runId, "waiting_on_you", {
              label: "Needs you at the keyboard",
              detail: reason,
            });
          })();
        };
        return [
          /*
           * The person's saved information.
           *
           * `alsoGranted` for the same reason the computer is: these are a capability of the person
           * rather than a connector somebody connected, so they do not pass through the grant store —
           * but they are still withheld from a supervisor, because a supervisor that can read somebody's
           * passwords is a supervisor that can sign in as them.
           *
           * WHICH IS WHAT THE TOOL SET IS FOR. A Bot can list what is in the vault, by name, and can
           * then ask for one item. It is never handed the vault, so a turn about something unrelated
           * carries no credentials at all — see the header on `vault/tools.ts` for why that split is
           * the whole argument.
           */
          ...vaultToolsFor({
            store: vaultStore,
            actorId,
            botId,
            auditStore: bootAuditStore,
            initiator,
          }),
          ...hostAccessTools({
            broker: hostAccessBroker,
            botId,
            actorId,
            auditStore: bootAuditStore,
            initiator,
          }),
          /*
           * The computer, which is the whole of the last piece of this function.
           *
           * `alsoGranted` rather than `granted`, and this placement is the decision. The computer is
           * the deployment's own infrastructure, not a connector somebody connected, so it does not
           * pass through the grant store — but it is still a per-Bot capability rather than a
           * deployment-wide one, and it is still withheld from a supervisor, because a supervisor that
           * can browse is a supervisor that does the work instead of arranging it.
           *
           * Absent when there is no gateway, which is the one case where the prompt's promise of hands
           * has to be withdrawn as well: see `config.computer ? COMPUTER_GUIDANCE : undefined`.
           */
          /*
           * Desktop tools, and ONLY for the Bot that holds the computer.
           *
           * There is one desktop per person and one Bot allowed to drive it: Remii. Every other
           * Bot works through connected apps and APIs, and asks Remii with `message_bot` when a job
           * needs a screen — which already relays Remii's answer back into the asking conversation, so
           * it costs the person nothing.
           *
           * This was not a narrowing, it was the opposite. These tools used to be handed to every Bot,
           * so a person with five coworkers had five Bots each able to start the person's single
           * desktop and drive the same mouse — and the bill for a flat monthly price depended on how
           * many coworkers a person happened to create. One holder is what makes the price honest.
           *
           * The tools are chosen over the browser tools outright rather than offered alongside them,
           * because a desktop has no URL to navigate and no document to read: `computer_navigate` would
           * fail on a machine that is not a browser, and offering both would leave the AI choosing
           * between a set that works and a set that cannot.
           */
          ...(desktopProvisioner && botHoldsTheComputer(botId)
            ? desktopToolsFor({
                resolve: () => resolveDesktopFor(actorId),
                /*
                 * Bound to the SIGNED-IN PERSON, not to the Bot.
                 *
                 * The computer belongs to a person and exactly one Bot holds it, so a secret request is
                 * a question to that person and there is only ever one of them outstanding at a time.
                 * Keying it by Bot would let two coworkers' Bots each raise a masked box on the same
                 * desktop, with one mouse and one focused field between them.
                 */
                requestSecret: (label: string) => requestSecret(actorId, label),
                actor: {
                  id: actorId,
                  ...(actorId === DEV_ACTOR.id ? {} : { userId: actorId }),
                },
                botId,
                onHelpRequested,
                /*
                 * The wheel, read fresh per action.
                 *
                 * A function, because the person takes it while the Bot is mid-turn. A value captured
                 * when these tools were built would be wrong the instant they clicked, and the Bot
                 * would carry on moving the mouse under their hand.
                 */
                controlHolder: async () => {
                  const row = await userComputerStore.get(actorId);
                  return row?.controlHolder ?? "bot";
                },
                /*
                 * The clock, opened and closed with the machine.
                 *
                 * These two are the entire metering story, and they are here rather than inside the
                 * provisioner because opening a session is a billing act and this is where billing is.
                 * Never awaited into the answer: a metering write must not be able to fail a turn, and a
                 * missed opening is a few cents against a plan's whole month.
                 */
                onSessionStart: () => {
                  void Promise.resolve(
                    computerMeter.open({ userId: actorId, sandboxId: null }),
                  ).catch(() => undefined);
                },
                onSessionEnd: (reason) => {
                  void Promise.resolve(
                    computerMeter.close({ userId: actorId, reason }),
                  ).catch(() => undefined);
                },
                /*
                 * The ceiling, from the plan — and the same number the guidance quotes, so a machine that
                 * behaves differently from the one Remii was told about cannot happen.
                 */
                maxSessionMinutes: PLANS.pro.maxSessionMinutes,
                /*
                 * Whether the computer is affordable right now, in a sentence.
                 *
                 * Fails OPEN on purpose: a failed read of somebody's own allowance must not take their
                 * computer away, so the catch returns "allowed". The cost of being wrong here is a few
                 * cents on a plan; the cost of refusing wrongly is a person who paid for a computer being
                 * told they may not use it.
                 */
                mayUseComputer: async () => {
                  const [plan, used] = await Promise.all([
                    limitsForUser(database, actorId).catch(() => PLANS.pro),
                    computerMeter.hoursThisMonth(actorId).catch(() => 0),
                  ]);
                  if (used < plan.computerHoursPerMonth) {
                    return { allowed: true as const };
                  }
                  return {
                    allowed: false as const,
                    reason: outOfAllowance(
                      "computer",
                      periodEnd(new Date(), "month"),
                    ),
                  };
                },
              })
            : computerGateway
              ? computerToolsFor({
                  gateway: computerGateway,
                  botId,
                  actor: {
                    id: actorId,
                    // The audit trail's foreign key is to `users`, and a local actor is not a row there.
                    ...(actorId === DEV_ACTOR.id ? {} : { userId: actorId }),
                  },
                  /*
                   * A shell is confined by its working directory and nothing else, so the question is who
                   * else is on this machine. One computer per Bot answers it with the container; one
                   * shared computer is only reachable when the deployment has asserted a single tenant,
                   * so every Bot on it belongs to the one person who owns them all. Said here as a
                   * condition rather than left as a caveat, because the alternative is a comment
                   * describing a risk that a later change could make true without anyone reading it.
                   *
                   * The per-Bot term is gone with the provider that supplied it: no provider is ever
                   * constructed, so this branch is unreachable and the only ways left to reach a shell
                   * are a single-tenant deployment or an explicit single-tenant assertion.
                   */
                  allowShell:
                    config.singleUser ||
                    (config.computer?.provider === "shared" &&
                      config.computer.sharedSingleTenant === true),
                  onHelpRequested,
                })
              : []),
        ];
      },
    });

/** One person's standing instructions, for both the /api/settings routes and every run they start. */
const userInstructionsStore = createUserInstructionsStore(database);

/** One person's execution switch, for the General settings screen and every run they start. */
const executionModeStore = createExecutionModeStore(database);

/** One person's Remi instance: which model their turns answer on. */
const remiInstanceStore = createRemiInstanceStore(database);

/**
 * Background memory extraction after a built-in turn, per person.
 *
 * The loop reports what the turn said and spent; this saves durable facts about the person
 * through the remi store bound to them, on the deployment's model chain. Fire-and-forget by
 * contract: extraction failures are silent, because a turn that already answered must not
 * fail over housekeeping.
 */
/**
 * Pre-turn memory recall for whoever is asking, bound beside `loadToolsForActor`.
 *
 * The gate spends the resolved model key; absent, it stays closed and the
 * model still holds `memory_search` for the turn. Recall is scoped to this
 * person's rows (their globals plus the Bot's own chat scope) — never
 * another Bot's, never another person's — the same sandbox rule the tools
 * obey.
 */
const memoryForActor = (actorId: string) => {
  const hooks = recallHooksFor({
    store: remiStore,
    userId: actorId,
    model: {
      provider: runtimeModel.provider,
      model: runtimeModel.defaultModel,
    },
    getApiKey: resolveRuntimeModelApiKey,
    environment: process.env,
  });

  /*
   * Pre-turn, and before the model is asked anything.
   *
   * This is the earliest hook on a turn that has the person's text, and it runs while the first model
   * call is still being prepared. A desktop that is started here spends its 60-to-120-second start
   * overlapping the thinking rather than sitting in front of the first tool call, which is the whole
   * difference between a four-minute sleep that nobody notices and one that reads as a slow product.
   *
   * Only for the Bot that holds the computer: a coworker without one has no screen to warm, and
   * starting a machine it will never touch is $0.0828 an hour of somebody's money for nothing.
   */
  return {
    ...hooks,
    recall: async (
      botId: string,
      runInput: Parameters<typeof hooks.recall>[1],
    ) => {
      if (botHoldsTheComputer(botId)) prewarmDesktop(actorId);
      return hooks.recall(botId, runInput);
    },
  };
};

const memoryExtractForActor =
  (actorId: string) =>
  (info: {
    botId: string;
    threadId: string;
    userText: string;
    assistantText: string;
  }) => {
    /*
     * THE KEY, RESOLVED PER TURN — the one thing this call was missing, and the reason nothing was ever
     * written.
     *
     * `extractMemoriesAfterRun` hands the key to `buildModelChain`, which refuses to build a chain
     * without one (fallbacks cover an outage, never a missing configuration) and returns immediately on
     * an empty chain. This call site passed only the model, so the chain was always empty and the daemon
     * never ran — silently, because it is fire-and-forget and every failure in it is deliberately quiet.
     * The write half of memory was dead from the day it was wired, while the read half and the explicit
     * `memory_save` tool kept working, which is what made it read as "flaky" rather than "never started".
     *
     * Resolved per turn rather than captured at boot, for the same reason `memoryForActor` resolves its
     * own: a credential added a moment ago should apply to the next extraction, and a resolution failure
     * should cost one turn of memory rather than the feature.
     */
    void resolveRuntimeModelApiKey()
      .then((apiKey) =>
        extractMemoriesAfterRun({
          store: remiStore,
          botId: info.botId,
          actorId,
          userText: info.userText,
          assistantText: info.assistantText,
          apiKey,
          model: {
            provider: runtimeModel.provider,
            model: runtimeModel.defaultModel,
          },
        }),
      )
      .catch(() => undefined);
  };

/*
 * What this person has told every built-in coworker they run.
 *
 * Per actor and read per build, for the reason every other per-person fact here is: somebody who
 * edits their instructions and sends a message expects the message to land on the new ones, and a
 * value captured at boot would serve the whole deployment whatever the first person to sign in had
 * written.
 *
 * The ask-first directive rides beside those instructions when this person's effective execution
 * mode says so (their own choice, else the deployment default). Beside them rather than inside
 * any Bot's role, because it is a fact about the person that holds for every built-in Bot alike,
 * and both turn paths — a chat request and a routine firing — already resolve instructions this
 * way. A failed preference read falls back to the deployment default rather than failing the
 * turn: the worst a missed switch can do is make a Bot ask more, or less, often.
 */
const loadInstructionsForActor = (actorId: string) => async () => {
  const [instructions, choice] = await Promise.all([
    userInstructionsStore.read(actorId),
    executionModeStore.read(actorId).catch(() => null),
  ]);
  const mode = choice ?? config.executionMode;
  if (mode !== "ask-first") return instructions;
  const directive = askFirstGuidance();
  return instructions ? `${instructions}\n\n${directive}` : directive;
};

/*
 * The file behind an attachment reference, read when a turn turns out to name one.
 *
 * Read per turn rather than held, for the reason the bytes are in the database at all: a message
 * carries a `/api/attachments/<id>` URL, and a model provider is not going to go and fetch it. The
 * row is fetched here and the bytes go up inline, so the Bot sees the file the person attached
 * instead of a link it cannot follow.
 *
 * Built per actor and passed to both turn paths — the request path through `mountCopilotRuntime` and
 * a routine's turn through `buildAgentFor` — so a routine firing at three in the morning inlines
 * exactly as a person's chat turn does, on exactly the same footing.
 *
 * NARROWED BY ACTOR AND BY CONVERSATION, and not silent. The reference reaches the loader out of
 * browser-supplied message content, so a turn can name an attachment in a channel the asker was
 * never in — or in one they ARE in but which is not the channel this turn is running in.
 * `loadAttachmentForTurn` answers both with the same membership join the fetch route uses plus the
 * run's own thread, and null when there is no row this person may see here.
 * `resolveAttachmentParts` fails the turn on that null rather than letting a Bot read a file back
 * to somebody who cannot open it.
 *
 * The thread is the CLOSURE'S ARGUMENT rather than something baked in beside the actor, because one
 * of these is built per actor per request and then used for however many runs that request makes;
 * a thread captured here would be the first run's, silently, for all of them.
 *
 * A PURE READ. `attachedAt` is written by the send rather than by anything here; see
 * `markAttachmentsSentForActor` below.
 */
const loadAttachmentForActor =
  (actorId: string) => (id: string, threadId: string) =>
    loadAttachmentForTurn(database, { actorId, threadId }, id);

/**
 * That the files on a message went out in it, recorded when a turn turns out to be a send.
 *
 * Bound per actor and handed to the same two turn paths as the reader above, so a routine's send at
 * three in the morning is recorded exactly as a person's chat turn is. `inlineAttachments`
 * (copilot.ts) calls it with the ids on the message being asked about and no others: history is
 * replayed on every turn and by whoever is running it, so nothing behind that message is evidence
 * of a send.
 *
 * NARROWED BY ACTOR, and more strictly than the reader is. Reading is scoped to channel
 * membership, because members are meant to see each other's sent files; recording a send is scoped
 * to the UPLOADER, because `attachedAt` is what the sweeper, the upload cap and the withdrawal
 * route all read as "this file rode in a message somebody sent" — and a member who could write it
 * on a colleague's staged row would freeze that colleague's own withdrawal at 409 and leave the row
 * unsweepable. See `markAttachmentsSent` in channels/attachments.ts.
 *
 * AND NARROWED BY CONVERSATION, taking the thread as an argument for the reason the reader does.
 * A stamp written against a channel that never saw the file freezes the row the same way, and is
 * reached without any colleague being involved: one person, two channels of their own, a file
 * named from the wrong one.
 */
const markAttachmentsSentForActor =
  (actorId: string) => (ids: readonly string[], threadId: string) =>
    markAttachmentsSent(database, { actorId, threadId }, ids);

/*
 * What the deployment tells a remote Bot about the run it is starting.
 *
 * Signed here, where the encryption key lives, so the runtime module never holds a secret. The Bot
 * hands this back when it calls a tool, and it is where the Bot id and the person's name come
 * from: its own token proves which agent is calling, this proves who it is calling for, and
 * neither is read out of the request body any more.
 */
const signRunForActor =
  (actorId: string, initiator: AuditInitiator = PERSON_INITIATOR) =>
  (botId: string, runId: string, threadId?: string) =>
    mintRunAssertion(
      { botId, actorId, runId, threadId, initiator },
      config.keyEncryptionKey,
    );

/*
 * Which vendors this deployment connects to, held by a Bot or not.
 *
 * A Bot holding no grants used to be told nothing about connectors at all, so it treated a
 * connected vendor as an ordinary website and browsed to it: a Bot with no Drive grant opened
 * Google's sign-in page and asked a person to sign in to an account the deployment had already
 * connected. Naming them lets it say which one it has not been granted instead.
 *
 * Read per request rather than held, because a connector added a minute ago has to count.
 * Let failures reach buildAgents, which reports the missing guidance once and keeps the run usable.
 */
const loadVendors = async () => await pluginStore.serverIds();

/*
 * How a run's tools are narrowed to the ones it is about.
 *
 * A model picks the right tool reliably out of about ten, and a deployment of this template
 * clears that as soon as it connects a second vendor. Past it the wrong tool gets called, or
 * none does and the answer comes from memory, and neither says so. So a Bot holding more than a
 * handful is offered the tools of the skills that match the message rather than everything at
 * once. See `plugins/selection.ts`.
 *
 * This narrows the offer and nothing else. What a Bot may call is the grant, checked in
 * `callTool` with the policy and the audit row exactly as before, so every path through here can
 * be wrong without a Bot gaining anything. That is also why every failure below is silent and
 * lands on the whole catalogue: the narrowing is worth an accuracy point, never a capability.
 */
const selectionForActor = (actorId: string): ToolSelection => ({
  loadSkills: (botId) => grantedSkills({ store: pluginStore, botId }),
  // The deployment's own model and key, the same pair the intent router uses, so selection is
  // never a second thing to configure. It throws on a missing key, which reads as "could not
  // choose" and leaves the whole catalogue offered.
  choose: chooseSkills,
  record: async (botId, selection) => {
    await recordAuditEvent(bootAuditStore, {
      eventType: "mcp.tools_discovered",
      targetType: "bot",
      targetId: botId,
      actorUserId: actorId,
      payload: {
        bot: botId,
        reason: selection.reason,
        granted: selection.granted,
        offered: selection.offered.length,
        skills: selection.skills,
      },
    });
  },
});

/**
 * How a run reaches the engine it runs on.
 *
 * Plain `fetch`, and that is now all it needs to be: the only addresses any run dials are ones this
 * deployment configured — the Bot it ships in the box, and the harness chosen at setup, both named in
 * `config.managedAgent` or the tenant package. A person cannot add an address of their own, so there
 * is no untrusted destination left to screen, and the redirect-hop guard that used to wrap this
 * (`createAgentFetch`) had nothing left to guard.
 */
const agentFetch = (
  ...args: Parameters<typeof fetch>
): ReturnType<typeof fetch> => fetch(...args);

/**
 * Who a routine acts as, resolved the way {@link resolveRequestActor} resolves it.
 *
 * THE ROLE IS READ, NOT ASSUMED. Which coworkers exist is decided per person and an administrator
 * sees Bots a user does not, so hardcoding `role: "user"` here would hide an administrator's own Bots
 * from their own routine — the routine would fail with "that Bot is no longer registered" for a Bot
 * sitting in front of them in chat. This asks the same repository the request path asks, so a routine
 * sees exactly the coworkers its owner sees.
 */
/**
 * The person behind a run, for tools that act as them rather than as a Bot.
 *
 * Bot-admin tools (summon, add, delete, grants, settings) create, change and remove things
 * owned by a person, so they need the person's role, not just their id. Resolved lazily per
 * call site rather than per run: most runs never touch a Bot, and a role read on every one of
 * them would be a query spent for nothing.
 */
const loadActorFor = (actorId: string) => async (): Promise<AgentActor> => {
  // Every person is a user, sovereign over their own data. There is no role
  // that reaches past it.
  return { id: actorId, role: "user" };
};

const actorFor = async (ownerUserId: string): Promise<AgentActor> => {
  // One person, and they are an administrator. The id stays the routine owner's rather than being
  // rewritten to DEV_ACTOR's: in this mode they are the same person, and if they ever were not,
  // silently borrowing the dev actor's identity would be worse than finding nothing.
  return { id: ownerUserId, role: "user" };
};

/**
 * One Bot, built for a routine's turn, as its owner.
 *
 * Per turn rather than per boot, for the same reason the request path rebuilds: a Bot registered or
 * edited since the last firing has to count, and a private coworker must be absent for everybody but
 * its owner. No header and no request are involved — the owner is asserted by construction, from the
 * routine row — which is the whole point of doing it here rather than adding an impersonation path to
 * a public route.
 */
const buildAgentFor = async ({
  ownerUserId,
  agentId,
  initiator,
}: {
  ownerUserId: string;
  agentId: string;
  initiator: AuditInitiator;
}) => {
  const actor = await actorFor(ownerUserId);
  const agents = await resolveRuntimeAgents(
    () => loadAgentsForActor(actor),
    runtimeModel,
    resolveRuntimeModelApiKey,
    stallGuard,
    loadToolsForActor(actor.id, initiator),
    signRunForActor(actor.id, initiator),
    config.computer ? COMPUTER_GUIDANCE : undefined,
    loadVendors,
    selectionForActor(actor.id),
    agentFetch,
    undefined,
    // Only the Bot this routine names. Same reason as the hop delivery: the roster is still read in
    // full so a Bot this owner cannot see is still absent, but the other Bots are neither built nor
    // asked what they hold.
    agentId,
    // The owner's own standing instructions. A routine is their work done while they are asleep, so
    // it is written the way they asked for it to be written, exactly as their chat turn would be.
    loadInstructionsForActor(actor.id),
    initiator,
    // The same reader the request path gets, bound to the owner the routine runs as, so a file
    // attached in a channel reads the same way on a routine's turn as it does on the person's own —
    // and is refused the same way when the owner is not in that channel.
    loadAttachmentForActor(actor.id),
    // And the same recorder, so the files on a routine's own message stop counting as staged the
    // moment it sends them, exactly as a person's do.
    markAttachmentsSentForActor(actor.id),
    undefined,
    undefined,
    memoryForActor(actor.id),
    // How a run ended, recorded where a person can see it. The loop is the only
    // thing that knows, and a run somebody stopped and a run that broke are not
    // the same event to whoever was waiting on it.
    (outcome) => {
      setRunActivity(outcome.runId, outcome.outcome, {
        /*
         * BOTH FIELDS ALWAYS, AND NOT ONLY WHEN THEY HAVE SOMETHING TO SAY.
         *
         * `label` was already unconditional; `detail` was not, and the asymmetry was a trap rather
         * than a saving. The store clears a field only when it is passed one — that is what lets a
         * `waiting_on_you` resolve into `thinking` without still claiming to be waiting on somebody —
         * so a conditional `detail` leaves whatever the last state wrote behind. A run that failed
         * and was then reported stopped would keep saying why it failed, which is a claim about a
         * different event.
         *
         * Unreachable today, because the loop reports one outcome per run and `finish` will not
         * overwrite an ended row. It is written this way because the next caller should not have to
         * know that, and because a field that is only cleared on purpose is a field that is
         * eventually not cleared.
         */
        label: null,
        detail: outcome.reason ?? null,
      });
    },
  );
  const agent = agents[agentId];
  if (!agent) {
    /*
     * Named, and raised rather than swallowed. The routine's Bot was deleted, or made private by
     * somebody else, or the owner lost the role that could see it. The runner turns this into a
     * failed run row with this sentence on it, the first failure is said once in the channel, and
     * the fatigue rule switches the routine off after ten — which is exactly the right handling for
     * a routine pointed at something that is not coming back.
     */
    const error = new Error(
      `That Bot is no longer registered, so this routine has nothing to run: ${agentId}.`,
    );
    error.name = "RoutineBotNotRegistered";
    throw error;
  }
  return agent;
};

/*
 * The run backend, built ONCE and shared by the request path, hops and
 * routines: Postgres threads and locks, one local runner.
 *
 * One runner for the process, reused across firings: its in-memory store is
 * per instance, and a runner per turn would fragment the already-running
 * check that keeps two turns off one thread. See `routines/run-turn.ts`.
 * Durability does not depend on sharing — every run persists to Postgres —
 * but liveness (stop, isRunning) does.
 */
const threadStore = createThreadStore(database);
const threadLock = createThreadLock(database);
const localRunner = new PostgresAgentRunner(threadStore);
const routineIntelligence = createLocalIntelligence(threadStore, threadLock);
const routineAgentRunner = localRunner;

const routineRunner = createRoutineRunner({
  routineStore,
  channelStore,
  runTurn: createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    buildAgentFor,
    /*
     * Real spend on the run row. A routine runs as its owner, so the owner's
     * row is charged and the daily circuit breaker counts credits rather
     * than firings. Throws propagate to the runner, which records the run as
     * failed but keeps the reply it already produced out of the channel.
     */
    chargeUsage: async (usage) => {
      const coverage = await planCoverage(database, usage.ownerUserId).catch(
        () => null,
      );
      if (coverage?.covered) {
        const recorded = await recordUsage(database, {
          userId: usage.ownerUserId,
          agentId: usage.agentId,
          model: runtimeModel.defaultModel,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          browserDurationSeconds: usage.browserDurationSeconds,
        });
        return recorded.creditsComputed;
      }
      const settled = await deductTurnCredits(database, {
        userId: usage.ownerUserId,
        agentId: usage.agentId,
        model: runtimeModel.defaultModel,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        browserDurationSeconds: usage.browserDurationSeconds,
        reason: "routine_turn",
      });
      return settled.creditsDeducted;
    },
  }),
});

/*
 * The same turn backend for scheduled jobs. One runner for the process, shared the way the
 * request path shares it (see above): liveness, not durability, is what sharing buys. SaaS
 * mode never charges, so the charge callback records usage rows for cost visibility and
 * deducts nothing.
 */
const cronTurnRunner = createTurnRunner({
  intelligence: routineIntelligence,
  runner: routineAgentRunner,
  buildAgentFor,
  chargeUsage: async (usage) => {
    const recorded = await recordUsage(database, {
      userId: usage.ownerUserId,
      agentId: usage.agentId,
      model: runtimeModel.defaultModel,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      browserDurationSeconds: usage.browserDurationSeconds,
    }).catch(() => null);
    return recorded?.creditsComputed ?? 0;
  },
});

/**
 * The runtime, and the two things beside it a hop needs.
 *
 * `agentFor` builds the addressed Bot exactly the way a person's run builds it, and `history` reads
 * the conversation through the same client. Taken from here rather than assembled again, because a
 * Bot built by parallel wiring drifts the first time one of these arguments changes, and the drift is
 * invisible: it runs, and quietly holds different tools or a different role from the one the person
 * is talking to.
 */
const copilotRuntime = mountCopilotRuntime(
  config,
  runtimeModel,
  loadAgentsForActor,
  resolveRuntimeModelApiKey,
  identifyUser,
  identifyActor,
  stallGuard,
  loadToolsForActor,
  signRunForActor,
  undefined,
  loadVendors,
  selectionForActor,
  agentFetch,
  /*
   * What a Bot may reach past itself for: another Bot, and a person. Made per run and per person.
   *
   * Per person because which Bots may be reached is decided against the roster that person can
   * see: a Bot must never be able to address one they cannot, or this becomes a way around agent
   * visibility. Per run because the caps need to know how deep the chain already is and where an
   * answer belongs, and both of those are the deployment's own statement about the run rather than
   * anything the model can edit.
   */
  (actorId) => async (botId, input) => {
    const from = readRunAssertion(
      (input.forwardedProps as { remiiRun?: unknown } | undefined)?.remiiRun,
      config.keyEncryptionKey,
    );
    const run = {
      botId,
      actorId,
      runId: input.runId,
      threadId: input.threadId,
      depth: from?.depth ?? 0,
      // Read from the assertion for the reason `depth` is: the run is rebuilt from parts here, and
      // a field left out of this object is a field the desk and the escalation never see.
      initiator: from?.initiator ?? PERSON_INITIATOR,
    };
    /*
     * The caps are checked BEFORE the grants query, not inside the tool that would discard it.
     *
     * `handoffTool` short-circuits on all three of these, but only after being handed a
     * `hasSomebodyToAsk` that costs a query. So a deployment which switched the capability off
     * still paid one grants read per run of every Bot, for a tool it was never going to be offered,
     * and a run already at the cap paid it again.
     */
    const couldHandOn =
      config.handoff.maxDepth > 0 &&
      config.handoff.maxPerRun > 0 &&
      run.depth < config.handoff.maxDepth;

    const passing = couldHandOn
      ? handoffTool({
          desk: handoffDesk,
          /*
           * How deep this run already is comes from the assertion the deployment signed when it handed
           * this work on. A run a person started carries none, and none means zero.
           *
           * NOT `from.botId`. The assertion proves what this run is, and the Bot is whichever one the
           * runtime is building right now: on a hop those agree, and taking the id from the signed
           * value rather than from the build would let a stale assertion aim the next hop at the
           * wrong Bot's grants.
           */
          from: run,
          // Read now rather than at boot, so a grant made a minute ago counts and one revoked a
          // minute ago stops counting.
          hasSomebodyToAsk:
            botId === REMII_AGENT_ID ||
            (
              await pluginStore
                .botsReachableFrom(botId)
                .catch(() => [] as string[])
            ).length > 0,
          maxDepth: config.handoff.maxDepth,
          maxPerRun: config.handoff.maxPerRun,
        })
      : null;
    /*
     * The Remi spelling of the same door, offered beside it under the same gate. A chief of
     * staff delegates; meeting that wording costs one more tool in the list and no new
     * machinery, grants, caps or audit surface, because both names send through one desk.
     * Computed from the same grant read, so the two names never disagree about who may be asked.
     */
    const delegating =
      passing !== null
        ? delegateTool({
            desk: handoffDesk,
            from: run,
            hasSomebodyToAsk: true,
            maxDepth: config.handoff.maxDepth,
            maxPerRun: config.handoff.maxPerRun,
          })
        : null;
    /*
     * The way to stop and ask is offered whether or not there is a Bot to hand to.
     *
     * It is the cheaper of the two and the one a Bot should reach for first: asking the person who
     * is already in the conversation spends nothing and cannot be aimed anywhere they cannot see.
     * A deployment that offered only the expensive exit would push every unanswerable question
     * sideways into another run.
     */
    const asking = escalationTool({
      from: run,
      route: askTheirOwnPerson,
      /*
       * A question that reached somebody. The run is now blocked on a person, which is the one
       * state that must not read as "thinking" — the difference between a Bot working and a Bot
       * waiting for you is the difference between patience and a support ticket.
       */
      onAsked: ({ runId }) =>
        setRunActivity(runId, "waiting_on_you", { label: "Needs your answer" }),
      auditStore: bootAuditStore,
    });
    const connecting = connectAppTool({
      from: run,
      broker: composio?.broker,
      pluginStore,
      appUrl: config.appUrl,
    });
    /*
     * Remi's tools, bound to this run's Bot, person and thread. Memory, artifacts, todos,
     * schedules, history and web search run in-process for built-in agents and through the
     * signed callback below for remote ones — the same two doors every deployment tool uses.
     */
    const mind = remiToolsFor({
      store: remiStore,
      botId,
      actorId,
      threadId: run.threadId,
      tools: {
        database,
        model: {
          provider: runtimeModel.provider,
          model: runtimeModel.defaultModel,
        },
        getApiKey: resolveRuntimeModelApiKey,
        environment: process.env,
        embeddingsApiKey: process.env.EMBEDDINGS_API_KEY,
        embeddingsBaseUrl: process.env.EMBEDDINGS_BASE_URL,
        webSearchApiKey: process.env.WEB_SEARCH_API,
        webSearchBaseUrl: process.env.WEB_SEARCH_URL,
        getThreadMessages: async (threadId) =>
          (await threadStore.getMessages(threadId).catch(() => [])) as Array<{
            role?: string;
            content?: unknown;
            createdAt?: unknown;
          }>,
      },
    });
    /*
     * Remii's hands on the workspace itself: summon, add, update, delete and empower Bots, check
     * coworker status and activity, change the person's settings, and manage connections.
     * Remii is the boss of the workspace after the person and holds these powers unconditionally;
     * other Bots wield them when granted the `bot-creator` skill.
     */
    const governing =
      botId === REMII_AGENT_ID ||
      (await grantedSkills({ store: pluginStore, botId })
        .then((skills) => skills.some((skill) => skill.slug === "bot-creator"))
        .catch(() => false))
        ? botAdminToolsFor({
            botId,
            actorId,
            stores: {
              profiles: agentProfileStore,
              plugins: pluginStore,
              components: componentStore,
              channels: channelStore,
              executionModes: executionModeStore,
              instructions: userInstructionsStore,
              instance: remiInstanceStore,
              policyStore,
              getThreadMessages: async (threadId) =>
                (await threadStore
                  .getMessages(threadId)
                  .catch(() => [])) as Array<{
                  role?: string;
                  content?: unknown;
                  createdAt?: unknown;
                }>,
              audit: bootAuditStore,
              loadActor: loadActorFor(actorId),
              by: actorId,
              delegateToOwnChannel: async (input) => {
                const outcome = await handoffDesk.send({
                  from: run,
                  target: input.bot,
                  envelope: {
                    task: input.task,
                    ...(input.constraints
                      ? { constraints: input.constraints }
                      : {}),
                    ...(input.expecting ? { expecting: input.expecting } : {}),
                  },
                  runInOwnChannel: true,
                });
                return outcome.ok
                  ? { ok: true, answer: outcome.toName }
                  : { ok: false, answer: outcome.refusal };
              },
            },
          })
        : [];
    /*
     * The waiter for an OAuth connection the person is finishing in their browser. Offered
     * beside connect_app, which hands them the link this waits on.
     */
    const waiting = waitToolFor({ plugins: pluginStore, actorId });
    /*
     * Google Workspace through the machine's own `gog` CLI: no hosted
     * OAuth, no key sync. Offered only when the binary resolves; without it the tools stay
     * home and the skill says how to install it instead.
     */
    const local = gogToolsFor({ binary: resolveGogBinary() });
    return passing && delegating
      ? [
          passing,
          delegating,
          asking,
          connecting,
          waiting,
          ...governing,
          ...local,
          ...mind,
        ]
      : [asking, connecting, waiting, ...governing, ...local, ...mind];
  },
  /*
   * A run started or ended on a thread. Two things, from one call, because they are the same moment
   * and two calls could disagree about it: the channel's working dot, and the durable record of
   * which Bot was doing what.
   *
   * THE LOCK IS THE RIGHT PLACE FOR BOTH. It is the one place that knows a run began, and the one
   * that knows it ended — including when it ended because a browser went away, which no per-run
   * hook would have seen. Neither write is awaited: both are side effects on a path whose answer is
   * the lock, and a run must not fail because a working dot could not be lit.
   */
  (input) => {
    void channelStore.signalBusy(input.threadId, input.busy).catch(() => {});
    if (input.busy) {
      // Captured, not narrowed in place: a parameter is mutable as far as the type checker knows, so
      // the narrowing below would not survive into the closure.
      const runId = input.runId;
      const userId = input.userId;
      const agentId = input.agentId;
      if (!runId || !userId || !agentId) return;
      void (async () => {
        const row = await runActivityStore.begin({
          runId,
          actorUserId: userId,
          botId: agentId,
          threadId: input.threadId,
          // The conversation a person can open, if this thread is one. A hop's scratch thread is
          // not, and a run with no channel is still a run worth recording.
          channelId: await channelIdForThread(input.threadId),
        });
        await runActivityStore.publish({
          runId: row.runId,
          actorUserId: row.actorUserId,
          botId: row.botId,
          channelId: row.channelId,
          state: row.state,
          label: row.label,
          detail: row.detail,
          startedAt: row.startedAt.toISOString(),
          parentRunId: row.parentRunId,
        });
      })().catch(() => {});
      return;
    }
    // The run id only — the lock's release carries no person and no Bot, and a record of the run is
    // found by its id. `finish` is guarded on the run still being open, so a run that already
    // recorded a failure keeps it.
    const finishedRunId = input.runId;
    if (!finishedRunId) return;
    void (async () => {
      const row = await runActivityStore.finish(finishedRunId);
      if (!row) return;
      await runActivityStore.publish({
        runId: row.runId,
        actorUserId: row.actorUserId,
        botId: row.botId,
        channelId: row.channelId,
        state: row.state,
        label: row.label,
        detail: row.detail,
        startedAt: row.startedAt.toISOString(),
        parentRunId: row.parentRunId,
      });
    })().catch(() => {});
  },
  // What this person has told every coworker of theirs, in every channel. See user-instructions.ts.
  loadInstructionsForActor,
  // The files on a message, put in front of the model rather than left as links it cannot follow —
  // and only the ones the person whose run this is could open themselves.
  loadAttachmentForActor,
  // And that those files went out in a send, written by the person who sent them and only for rows
  // they uploaded. See markAttachmentsSentForActor.
  markAttachmentsSentForActor,
  /*
   * Meter every turn and break runaway loops, for whoever the run belongs to.
   *
   * Actor-keyed like every other collaborator here, because the deduction is
   * written against that person's credit row. A hop delivered to a Bot is
   * metered through `agentFor` for the same reason the request path is: it
   * spends model and computer time too. Settlement failures never fail the
   * turn — a deployment whose ledger is down must not stop answering, it
   * must answer unbilled and say so in its log.
   */
  (actorId: string) => (botId: string, inner: AbstractAgent) =>
    new EnforcedAgent(inner, {
      /*
       * THE SEAM FOR A PERSON'S OWN RUN, and the second of the two.
       *
       * The thread lock covers hops and this covers the request path, and neither covers the other:
       * a hop is delivered from a work queue through `buildAgentFor`, which builds no EnforcedAgent,
       * while a chat run goes through the runtime and never takes the lock. Wiring only one of them
       * records whichever kind of work somebody happened to test, which is how a feature can be
       * complete against its own tests and show nothing at all in a conversation.
       */
      beforeRun: async (input) => {
        /*
         * Eligibility first, and unconditionally: a turn this deployment will not serve must not
         * appear in the roster as working. It never begins, so it must never be recorded as having
         * begun, and a person looking at their list would otherwise watch a dot for a run that is
         * about to be refused.
         */
        if (config.auth) {
          const eligibility = await verifyTurnEligibility(database, actorId);
          if (!eligibility.allowed) {
            throw new Error(eligibility.message ?? eligibility.error);
          }
        }
        if (
          typeof input.runId !== "string" ||
          typeof input.threadId !== "string"
        ) {
          return;
        }
        /*
         * The run's thread has to be this person's own conversation.
         *
         * The run names the thread it happens in and that name arrives from the caller, so a run is
         * a write with a caller-chosen destination. The transcript read is authorized by joining
         * `threads` and asking whether the owner is the person asking, but nothing authorized this:
         * the runner appends the turn to `thread_messages` for whatever id it was handed, so learning
         * somebody else's thread id was enough to have the Bot's next words written into their
         * conversation. A thread nobody owns yet is fine and is claimed below — that is how a new
         * channel gets its first row.
         */
        {
          const owner = await threadStore.threadOwner(input.threadId);
          if (owner && owner !== actorId) {
            throw new Error("That conversation belongs to somebody else.");
          }
          await threadStore.ensureThread({
            threadId: input.threadId,
            userId: actorId,
            agentId: botId,
          });
        }
        try {
          const row = await runActivityStore.begin({
            runId: input.runId,
            actorUserId: actorId,
            botId,
            threadId: input.threadId,
            channelId: await channelIdForThread(input.threadId),
          });
          await runActivityStore.publish({
            runId: row.runId,
            actorUserId: row.actorUserId,
            botId: row.botId,
            channelId: row.channelId,
            state: row.state,
            label: row.label,
            detail: row.detail,
            startedAt: row.startedAt.toISOString(),
            parentRunId: row.parentRunId,
          });
        } catch {
          // A run's record is a side effect on the path that answers somebody. Never its condition:
          // a database that cannot hold the row must not stop the Bot from replying.
        }
      },
      maxToolCalls: MAX_TURN_TOOL_CALLS,
      getContainerSeconds: () =>
        computerGateway?.consumeElapsedContainerSeconds?.(actorId) ?? 0,
      onTurnSettled: async (usage) => {
        /*
         * The run's record closes FIRST, before the billing that follows.
         *
         * The body below returns early on the covered-plan path, so anything appended after it would
         * be reached only for a turn that spent credits. A run's end is not conditional on how the
         * turn was paid for, and a settled run left open is a roster row that never clears.
         */
        if (usage.runId) {
          try {
            const row = await runActivityStore.finish(usage.runId);
            if (row) {
              await runActivityStore.publish({
                runId: row.runId,
                actorUserId: row.actorUserId,
                botId: row.botId,
                channelId: row.channelId,
                state: row.state,
                label: row.label,
                detail: row.detail,
                startedAt: row.startedAt.toISOString(),
                parentRunId: row.parentRunId,
              });
            }
          } catch {
            // As on the way in: a side effect never becomes the condition of the run.
          }
        }
        try {
          // Covered turns (trial, plan) still write usage rows so the window
          // bars move; only the balance is untouched.
          const coverage = await planCoverage(database, actorId).catch(
            () => null,
          );
          if (coverage?.covered) {
            await recordUsage(database, {
              userId: actorId,
              agentId: botId,
              model: runtimeModel.defaultModel,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              browserDurationSeconds: usage.browserDurationSeconds,
            });
            return;
          }
          await deductTurnCredits(database, {
            userId: actorId,
            agentId: botId,
            model: runtimeModel.defaultModel,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            browserDurationSeconds: usage.browserDurationSeconds,
          });
        } catch {
          // A deployment whose ledger is down answers unbilled rather than
          // not answering; the row above is what says it happened.
          console.error({
            error: "turn_settlement_failed",
            context: { operation: "deductTurnCredits", actorId, botId },
            timestamp: new Date().toISOString(),
          });
        }
      },
    }),
  /*
   * The deployment's own run backend, shared by the request path, hops and
   * routines: Postgres threads, locks, one local runner. No cloud, no
   * key, nothing to provision.
   */
  memoryExtractForActor,
  // One person's Remi instance for the request path and hops alike. A failed read inherits
  // the deployment model inside the runtime, so this never throws into a turn.
  (actorId: string) => remiInstanceStore.read(actorId).catch(() => null),
  // Pre-turn memory recall for whoever is asking: which rows a run may read
  // is decided by the session, exactly as the grants are.
  memoryForActor,
  {
    runner: localRunner,
    threads: threadStore,
    lock: threadLock,
  },
);

/**
 * Delivering hops, on every replica.
 *
 * A loop rather than a schedule, because a hop is somebody waiting for an answer rather than
 * housekeeping: the culler's minute-granularity CronJob would be an unexplainable pause in a
 * conversation. Every replica sweeps, and the queue decides which of them gets which hop, so adding a
 * replica adds delivery capacity rather than contention.
 *
 * Only where the capability is switched on. A deployment with a depth cap of zero never has a hop to
 * deliver, and a loop polling for work that cannot exist is a query a second for nothing.
 */
/*
 * Both zeros switch the capability off, so both have to stop the loop.
 *
 * Gated on the depth alone, a deployment that set the fan-out cap to zero still swept every two
 * seconds for hops that can never be offered: roughly forty thousand claim transactions per replica
 * per day, for a feature it had turned off.
 */
/**
 * The queue's own wake-up, when handing work between Bots is switched on at all.
 *
 * Held at module scope so the shutdown below can give its connection back. Undefined on a
 * deployment with the capability off, which is a deployment that never started one.
 */
let workOfferedListener: WorkOfferedListener | undefined;

if (config.handoff.maxDepth > 0 && config.handoff.maxPerRun > 0) {
  const runner = createHandoffRunner({
    queue: createWorkQueue(database),
    owner: workOwner("handoff"),
    auditStore: bootAuditStore,
    /*
     * The signed statement of the run the addressed Bot is about to start, carrying how deep the
     * chain has gone. Minted here, where the key lives, and one deeper than the run that asked.
     */
    sign: (work) => signHandoffDeliveryRun(work, config.keyEncryptionKey),
    delivery: createHandoffDelivery({
      /*
       * The hop's run id, and the run that asked. The edge is what makes a chain a chain: without
       * it a delegation is two unrelated runs and "what did Remii do, and to whom" has no answer.
       *
       * An upsert rather than an update, because the run's own record may not be written yet — the
       * lock that mints the id is the same one that announces the run, and that announcement is a
       * side effect it never waits for.
       */
      onRunStarted: (input) => {
        void (async () => {
          const row = await runActivityStore.recordDelegatedChild({
            runId: input.runId,
            actorUserId: input.actorId,
            botId: input.botId,
            threadId: input.threadId,
            parentRunId: input.parentRunId,
            ...(input.channelId ? { channelId: input.channelId } : {}),
          });
          await runActivityStore.publish({
            runId: row.runId,
            actorUserId: row.actorUserId,
            botId: row.botId,
            channelId: row.channelId,
            state: row.state,
            label: row.label,
            detail: row.detail,
            startedAt: row.startedAt.toISOString(),
            parentRunId: row.parentRunId,
          });
        })().catch(() => {});
      },
      /*
       * Built as the person, WITH THEIR ROLE. The desk resolved it to decide the hop was allowed; a
       * delivery that then rebuilt them as an ordinary user could not find the Bot the desk had just
       * agreed to, and the person was told it never answered.
       */
      agentFor: async ({ actorId, botId, fromBotId }) => {
        const actor = await actorFor(actorId).catch(() => null);
        if (!actor) {
          throw new Error(
            "who this is for could not be confirmed, so the Bot was not run",
          );
        }
        return copilotRuntime.agentFor({
          actor,
          botId,
          initiator: { kind: "handoff", id: fromBotId },
        });
      },
      history: copilotRuntime.history,
      lock: copilotRuntime.threadLock,
      /*
       * A scratch thread of the addressed Bot's own, one per hop.
       *
       * An Intelligence thread has exactly one agent, so a second Bot cannot answer inside the first
       * Bot's conversation however it asks. Its turn runs here instead, unmapped to any channel, and
       * what it said comes back to the conversation that asked through the relay — in the asking
       * Bot's voice, which is the only voice that thread admits. Minted with the deployment's own
       * identity, like every thread this deployment starts.
       */
      mintThreadId: () => threadIdentity.mint(),
      /*
       * The roster, told that a relayed answer landed. The delivery knows only the thread it ran
       * in; this resolves which channel shows that thread — a scratch thread maps to nothing and
       * announces nowhere, which is the point of a scratch thread.
       */
      announce: async (input) => {
        const [mapped] = await database
          .select({ channelId: intelligenceChannelMappings.channelId })
          .from(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.threadId, input.threadId))
          .limit(1);
        if (!mapped) return;
        const actor = await actorFor(input.actorId).catch(() => null);
        if (!actor) return;
        await channelStore.recordActivity(actor, mapped.channelId, {
          text: input.text,
          agentId: input.agentId,
          at: new Date(),
        });
      },
      // The asking conversation shown as working while a hop runs in it. Keyed by thread, resolved
      // to its channel by the store; a scratch thread maps to none and signals nowhere.
      setBusy: (input) => channelStore.signalBusy(input.threadId, input.busy),
      newRunId: () => randomUUID(),
      // The same runner the runtime drives, shared rather than rebuilt: a hop
      // delivered any other way would run with different concurrency and
      // persistence behavior than the conversation it answers in.
      runner: copilotRuntime.runnerConnection() as never,
    }),
  });

  const sweep = async () => {
    try {
      const report = await runner.sweep();
      if (report.delivered.length > 0 || report.skipped.length > 0) {
        console.info(JSON.stringify({ type: "bot-handoff", ...report }));
      }
    } catch (error) {
      // A sweep that failed must not take the loop with it: the next one may find the database back.
      console.warn(
        "[handoff] a sweep could not run:",
        error instanceof Error ? error.message : error,
      );
    }
  };

  /*
   * ONE SWEEP AT A TIME ON THIS REPLICA, from both callers below. A sweep poked while one is
   * running is remembered rather than started, and runs once the current one ends — a wake-up
   * that arrived mid-sweep may be for a hop the running sweep's claim already missed.
   */
  let sweeping = false;
  let sweepAgain = false;
  const kick = async () => {
    if (sweeping) {
      sweepAgain = true;
      return;
    }
    sweeping = true;
    try {
      do {
        sweepAgain = false;
        await sweep();
      } while (sweepAgain);
    } finally {
      sweeping = false;
    }
  };

  /*
   * Woken by the queue itself, from any replica: a person is waiting through every hop, and the
   * poll below would spend up to two seconds per leg doing nothing. The poll stays as the
   * backstop — a notification is a latency optimisation, and one lost in transit costs one
   * interval, never the work. See repeatAfterEach for why an interval must not be used: an
   * interval would start another sweep every two seconds while a five-minute delivery runs, each
   * claiming a different batch, and this replica's concurrent agent runs would grow with the
   * backlog rather than stopping at the limit it was asked for.
   */
  workOfferedListener = await startWorkOfferedListener(
    config.databaseUrl,
    (kind) => {
      if (kind === HANDOFF_KIND) void kick();
    },
  );
  repeatAfterEach(kick, 2_000);
}

/*
 * And dropping the hops that are over, whether or not the capability is switched on.
 *
 * OUTSIDE THE GATE ABOVE, deliberately. A deployment that switches handing work off still has
 * whatever it made while it was on, and rows that stop being reaped are rows that stay at the head
 * of the queue: switched back on a month later, the first thing that happens is a month-old question
 * being delivered to somebody who has long since stopped waiting. Reaping is housekeeping about the
 * past rather than part of the feature.
 *
 * Every replica reaps; the statement is a delete by age, so two doing it is the same as one doing it.
 * Its own loop rather than a phase of the sweep, so an hour of failing to reap never delays an answer.
 */
const reaper = createHandoffRunner({
  queue: createWorkQueue(database),
  owner: workOwner("reaper"),
  sign: () => "",
  auditStore: bootAuditStore,
  // Never called: `reap` deletes rows by age and claims nothing.
  delivery: {
    deliver: async () => {
      throw new Error("the reaper does not deliver hops");
    },
  },
});
repeatAfterEach(
  async () => {
    try {
      const purged = await reaper.reap();
      if (purged > 0) {
        console.info(JSON.stringify({ type: "bot-handoff-reaped", purged }));
      }
    } catch (error) {
      console.warn(
        "[handoff] hops that are over could not be dropped:",
        error instanceof Error ? error.message : error,
      );
    }
  },
  60 * 60 * 1_000,
);

/*
 * Naming conversations, in the API process rather than `worker/`, which the single-image container
 * does not run. Its own loop, so a slow model never delays a hop.
 */
const channelSummaries = {
  database,
  queue: createWorkQueue(database),
  transcript: routineIntelligence,
  title: createChannelTitler({
    model: runtimeModel.defaultModel,
    resolveApiKey: resolveRuntimeModelApiKey,
  }),
  owner: workOwner("summariser"),
};
repeatAfterEach(async () => {
  try {
    await offerChannelsAwaitingSummary(channelSummaries);
    const report = await summariseClaimedChannels(channelSummaries);
    if (report.written.length > 0) {
      console.info(
        JSON.stringify({ type: "channel-summaries", written: report.written }),
      );
    }
    // Same pass: one statement, deletes by age, and two replicas running it changes nothing.
    await forgetSettledSummaries(channelSummaries);
  } catch (error) {
    // Never fatal, and never loud enough to drown the log: a deployment with no model configured
    // reaches this on every pass, and it has not gone wrong, it simply has no titles.
    console.warn(
      "[channels] conversations could not be named:",
      error instanceof Error ? error.message : error,
    );
  }
}, 10_000);

const app = createApp(
  config,
  auth,
  createAuditReader(database),
  createCredentialWriteService(
    config.keyEncryptionKey,
    credentialStore,
    createAuditStore(database),
  ),
  createPackageStatusReader(database),
  // The runtime call: the model, per-actor agent loading, and the two identity
  // functions are how a run is attributed to a person.
  copilotRuntime.handler,
  // The only path to an acting call.
  computerGateway,
  policyStore,
  // Bots as durable objects, and the channels they run in.
  agentProfileStore,
  channelStore,
  channelEvents,
  // The same store the boot row uses, so a Bot's own refusal lands in the trail beside its actions.
  bootAuditStore,
  componentStore,
  // MCP servers and packaged skills. Judged by the same policy the computer actions are, read
  // fresh on every call for the same reason: a rule added a moment ago applies to the next call.
  pluginStore,
  // Components authored in the browser. Their governance is the component store's; this owns only
  // the source, which is the part a rebuild would otherwise have owned.
  sandboxedStore,
  // How a thread that has no channel is named, so the direct Bot chat is in the same namespace.
  threadIdentity,

  // The enterprise identity providers registered here. Read as facts about the deployment rather
  // than through Better Auth's own listing, which answers per person. See identity-provider-store.ts.
  identityProviderStore,
  // Chooses the coworker for an untagged message, on the deployment's own model and key.
  intentRouter,
  // What a browsing turn's screen looked like when it finished, so the transcript can show it later.
  pageFrameStore,
  // What a due routine actually does: a turn, run as its owner, into the thread they will open.
  routineRunner,
  // A person's own standing instructions: the list, and a switch to stop one.
  routineStore,
  // Where each person is in first-run onboarding, read by /api/me and written by the wizard.
  createOnboardingStore(database),
  // The same store every run reads through `loadInstructionsForActor`, so the screen a person edits
  // and the prompt their coworker is built from can never be two different pieces of text.
  userInstructionsStore,
  // The same database every other store here is built from, so a channel's staged and sent files
  // live behind the same connection as the messages that reference them.
  database,
  // Native host-folder sessions are session-only: grants disappear with this server process and the
  // desktop worker must authenticate with a fresh token for this run.
  hostAccessBroker,
  process.env.REMII_DESKTOP_HOST_TOKEN,
  async ({ name, args, botId, actorId, initiator, threadId }) => {
    if (name === "delegate_bot") {
      /*
       * Built fresh per call like connect_app below, under the same handoff gate as the
       * built-in path: caps first, then the grant re-checked now, so a hop revoked a minute
       * ago stops counting on the next callback.
       */
      if (config.handoff.maxDepth <= 0 || config.handoff.maxPerRun <= 0) {
        return {
          text: `${REFUSAL_MARKER} Delegation is switched off on this deployment.`,
          isError: true,
        };
      }
      const tool = delegateTool({
        desk: handoffDesk,
        from: {
          botId,
          actorId,
          runId: "callback",
          ...(threadId ? { threadId } : {}),
        },
        hasSomebodyToAsk:
          botId === REMII_AGENT_ID ||
          (
            await pluginStore
              .botsReachableFrom(botId)
              .catch(() => [] as string[])
          ).length > 0,
        maxDepth: config.handoff.maxDepth,
        maxPerRun: config.handoff.maxPerRun,
      });
      if (!tool) {
        return {
          text: `${REFUSAL_MARKER} Delegation is not available to this Bot right now.`,
          isError: true,
        };
      }
      const text = toolResultText(await tool.execute(args));
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    if ((BOT_ADMIN_TOOL_NAMES as readonly string[]).includes(name)) {
      /*
       * Built fresh per call, under the same bot-creator gate as the built-in path: Remii
       * wields these unconditionally, while other Bots wield them only when granted the skill.
       */
      const skilled =
        botId === REMII_AGENT_ID ||
        (await grantedSkills({ store: pluginStore, botId })
          .then((skills) =>
            skills.some((skill) => skill.slug === "bot-creator"),
          )
          .catch(() => false));
      if (!skilled) {
        return {
          text: `${REFUSAL_MARKER} That tool is not available to this Bot right now.`,
          isError: true,
        };
      }
      const tool = botAdminToolsFor({
        botId,
        actorId,
        stores: {
          profiles: agentProfileStore,
          plugins: pluginStore,
          components: componentStore,
          channels: channelStore,
          executionModes: executionModeStore,
          instructions: userInstructionsStore,
          instance: remiInstanceStore,
          policyStore,
          getThreadMessages: async (tid) =>
            (await threadStore.getMessages(tid).catch(() => [])) as Array<{
              role?: string;
              content?: unknown;
              createdAt?: unknown;
            }>,
          audit: bootAuditStore,
          loadActor: loadActorFor(actorId),
          by: actorId,
          delegateToOwnChannel: async (input) => {
            if (!threadId) {
              return {
                ok: false,
                answer:
                  "This run is not in a conversation, so the work had nowhere of its own to run.",
              };
            }
            const outcome = await handoffDesk.send({
              from: { botId, actorId, runId: "callback", threadId },
              target: input.bot,
              envelope: {
                task: input.task,
                ...(input.constraints
                  ? { constraints: input.constraints }
                  : {}),
                ...(input.expecting ? { expecting: input.expecting } : {}),
              },
              runInOwnChannel: true,
            });
            return outcome.ok
              ? { ok: true, answer: outcome.toName }
              : { ok: false, answer: outcome.refusal };
          },
        },
      }).find((candidate) => candidate.name === name);
      if (!tool) {
        return {
          text: `${REFUSAL_MARKER} That tool is not available right now.`,
          isError: true,
        };
      }
      const text = toolResultText(await tool.execute(args));
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    if ((GOG_TOOL_NAMES as readonly string[]).includes(name)) {
      /*
       * Built fresh per call: the binary is re-resolved, so an install or removal between
       * runs applies on the next callback rather than after a restart.
       */
      const tool = gogToolsFor({ binary: resolveGogBinary() }).find(
        (candidate) => candidate.name === name,
      );
      if (!tool) {
        return {
          text: `${REFUSAL_MARKER} Google CLI is not available on this machine right now.`,
          isError: true,
        };
      }
      const text = toolResultText(await tool.execute(args));
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    if ((COMPOSIO_TOOL_NAMES as readonly string[]).includes(name)) {
      /*
       * Built fresh per call: search and batch scope over the granted set, the waiter reads
       * live connection state. The grant is re-read now, so tools revoked a minute ago stop
       * counting on the next callback.
       */
      if (name === "wait_for_connections") {
        const tool = waitToolFor({ plugins: pluginStore, actorId });
        const text = toolResultText(await tool.execute(args));
        return { text, isError: text.startsWith(REFUSAL_MARKER) };
      }
      const granted = await grantedTools({
        store: pluginStore,
        botId,
        actorId,
        initiator,
      });
      const tool = searchAndBatchToolsFor(granted).find(
        (candidate) => candidate.name === name,
      );
      if (!tool) {
        return {
          text: `${REFUSAL_MARKER} That tool is not available right now.`,
          isError: true,
        };
      }
      const text = toolResultText(await tool.execute(args));
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    if (name === "connect_app") {
      /*
       * Built fresh per call rather than reused: connectAppTool closes over its run, and a
       * callback has no run — only the Bot, the person and (sometimes) the thread the signed
       * assertion carried. runId is nominal here; the tool reads only the actor.
       */
      const tool = connectAppTool({
        from: {
          botId,
          actorId,
          runId: "callback",
          ...(threadId ? { threadId } : {}),
        },
        broker: composio?.broker,
        pluginStore,
        appUrl: config.appUrl,
      });
      const text = toolResultText(await tool.execute(args));
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    if ((REMI_TOOL_NAMES as readonly string[]).includes(name)) {
      const tool = remiToolsFor({
        store: remiStore,
        botId,
        actorId,
        ...(threadId ? { threadId } : {}),
        tools: {
          database,
          embeddingsApiKey: process.env.EMBEDDINGS_API_KEY,
          embeddingsBaseUrl: process.env.EMBEDDINGS_BASE_URL,
          webSearchApiKey: process.env.WEB_SEARCH_API,
          webSearchBaseUrl: process.env.WEB_SEARCH_URL,
          getThreadMessages: async (id) =>
            (await threadStore.getMessages(id).catch(() => [])) as Array<{
              role?: string;
              content?: unknown;
              createdAt?: unknown;
            }>,
        },
      }).find((candidate) => candidate.name === name);
      if (!tool) {
        return {
          text: `${REFUSAL_MARKER} That mind tool is not available right now.`,
          isError: true,
        };
      }
      const text = toolResultText(await tool.execute(args));
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    if (!name.startsWith("host_")) return null;
    const tool = hostAccessTools({
      broker: hostAccessBroker,
      botId,
      actorId,
      auditStore: bootAuditStore,
      ...(initiator ? { initiator } : {}),
    }).find((candidate) => candidate.name === name);
    if (!tool) {
      return {
        text: `${REFUSAL_MARKER} That host tool is not available for this Bot right now.`,
        isError: true,
      };
    }
    const text = toolResultText(await tool.execute(args));
    return { text, isError: text.startsWith(REFUSAL_MARKER) };
  },
  // The app directory, behind the same client the plugin store and the transport already share.
  // Absent without a key, which leaves the routes reporting no broker rather than listing apps
  // nobody could connect.
  composio ? { broker: composio.broker } : undefined,
  // One cron tick per worker minute: claim due scheduled jobs and run each as its owner.
  () =>
    runCronTick({
      database,
      channelStore,
      runTurn: cronTurnRunner,
      defaultBotId: REMII_AGENT_ID,
    }),
  // Telegram delivery, when a bot token is configured. The worker long-polls Telegram and
  // hands each message here; this runs the turn and replies. Absent without a token.
  //
  // Passed as an explicit undefined rather than a conditional spread, because every argument
  // after this one is positional: a spread that emits nothing shifts all of them one slot
  // forward, and the server then serves with the wrong collaborators and no error anywhere.
  // That is exactly what happened to the parameter after this one — it arrived as the telegram
  // handler, and its own routes answered 503 with everything wired correctly.
  process.env.TELEGRAM_BOT_TOKEN
    ? async (input: {
        chatId: string;
        text: string;
        voiceFileId?: string;
        photoFileIds?: string[];
        documentFileId?: string;
        documentName?: string;
      }) =>
        (await import("./remi/telegram-incoming")).handleTelegramIncoming(
          {
            database,
            channelStore,
            runTurn: cronTurnRunner,
            botToken: process.env.TELEGRAM_BOT_TOKEN as string,
            defaultBotId: REMII_AGENT_ID,
          },
          input,
        )
    : undefined,
  // Telegram link management for the settings screen. Username is a placeholder until the bot
  // exists; without either, the routes stay unmounted. Explicit undefined for the reason above.
  process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_USERNAME
    ? {
        ...(process.env.TELEGRAM_BOT_TOKEN
          ? { token: process.env.TELEGRAM_BOT_TOKEN }
          : {}),
        ...(process.env.TELEGRAM_BOT_USERNAME
          ? { username: process.env.TELEGRAM_BOT_USERNAME }
          : {}),
      }
    : undefined,
  // One person's execution switch for the General settings screen. Positional, like
  // everything here: anything added after this shifts every call site past it.
  executionModeStore,
  // One Composio trigger event in, zero or one turns out. Mounted as a route only when the
  // broker is configured; without a key no trigger can name this deployment. Appended last.
  composio
    ? async (payload: unknown) => {
        const { handleTriggerEvent, createAutomationStore } = await import(
          "./remi/triggers"
        );
        return handleTriggerEvent(
          {
            database,
            remiStore,
            channelStore,
            runTurn: cronTurnRunner,
            automations: createAutomationStore(database),
            audit: bootAuditStore,
            model: {
              provider: runtimeModel.provider,
              model: runtimeModel.defaultModel,
            },
            defaultBotId: REMII_AGENT_ID,
            ...(process.env.TELEGRAM_BOT_TOKEN
              ? { telegramBotToken: process.env.TELEGRAM_BOT_TOKEN }
              : {}),
          },
          payload,
        );
      }
    : undefined,
  // Files in object storage, for the surfaces that outlive this process's disk.
  blobStore,
  // And now the vault, after everything else for the same positional reason.
  vaultStore,
);

/*
 * Nightly memory consolidation, called by the worker (and any CronJob shaped
 * like it). Merges duplicate memories and resolves contradictions per user;
 * dry-run until MEMORY_CONSOLIDATE_DRY_RUN=false. Same bearer-secret shape
 * as /internal/routines/run, refused byte-identically with no secret, so a
 * deployment with no worker answers a guess no differently than a wrong key.
 */
app.post("/internal/memory/consolidate", async (context) => {
  const offered = context.req.header("authorization");
  const expected = config.workerSharedSecret
    ? `Bearer ${config.workerSharedSecret}`
    : null;
  if (!expected || !offered || !sameToken(offered, expected)) {
    return context.json({ error: "Not authorised." }, 401);
  }
  const body = (await context.req.json().catch(() => null)) as {
    dryRun?: unknown;
    userId?: unknown;
  } | null;
  const dryRun =
    body?.dryRun === undefined
      ? process.env.MEMORY_CONSOLIDATE_DRY_RUN !== "false"
      : body.dryRun !== false;
  const onlyUser =
    typeof body?.userId === "string" && body.userId ? body.userId : null;
  const { consolidateUserMemory } = await import("./remi/memory-consolidate");
  const userRows = onlyUser
    ? [{ userId: onlyUser }]
    : await database
        .selectDistinct({ userId: memories.userId })
        .from(memories)
        .where(and(isNull(memories.deletedAt), isNull(memories.supersededBy)))
        .catch(() => []);
  const apiKey = await resolveRuntimeModelApiKey().catch(() => null);
  let users = 0;
  let merged = 0;
  let superseded = 0;
  let swept = 0;
  let episodesClosed = 0;
  for (const row of userRows) {
    const report = await consolidateUserMemory({
      store: remiStore,
      userId: row.userId,
      model: {
        provider: runtimeModel.provider,
        model: runtimeModel.defaultModel,
      },
      apiKey,
      environment: process.env,
      dryRun,
    }).catch(() => null);
    if (!report) continue;
    users += 1;
    merged += report.merged;
    superseded += report.superseded;
    // Forgetting runs beside consolidation on the same nightly pass: old,
    // unimportant, never-recalled rows fade (dry-run reports, never sweeps).
    const sweep = await remiStore
      .sweepMemories({ userId: row.userId, dryRun })
      .catch(() => null);
    swept += sweep?.swept ?? 0;
    // Stale task episodes compress to conclusions and expire their trivia.
    const staleTasks = await remiStore
      .staleTaskIds({ userId: row.userId })
      .catch(() => []);
    const { closeTaskEpisode } = await import("./remi/handoff-brief");
    for (const taskId of staleTasks.slice(0, 10)) {
      if (dryRun) {
        episodesClosed += 1;
        continue;
      }
      const closed = await closeTaskEpisode({
        store: remiStore,
        userId: row.userId,
        taskId,
        model: {
          provider: runtimeModel.provider,
          model: runtimeModel.defaultModel,
        },
        apiKey,
        environment: process.env,
      }).catch(() => null);
      if (closed) episodesClosed += 1;
    }
  }
  return context.json({
    users,
    merged,
    superseded,
    swept,
    episodesClosed,
    dryRun,
  });
});

/*
 * The morning brief, called by the worker once a day beside consolidation.
 * Same bearer-secret shape and byte-identical refusal: a deployment with no
 * worker answers a guess no differently than a wrong key. The brief is saved
 * as an artifact the Memory page shows; nothing is pushed anywhere, because
 * briefing is reading, not interrupting.
 */
app.post("/internal/memory/brief", async (context) => {
  const offered = context.req.header("authorization");
  const expected = config.workerSharedSecret
    ? `Bearer ${config.workerSharedSecret}`
    : null;
  if (!expected || !offered || !sameToken(offered, expected)) {
    return context.json({ error: "Not authorised." }, 401);
  }
  const { buildMorningBrief } = await import("./remi/memory-brief");
  const apiKey = await resolveRuntimeModelApiKey().catch(() => null);
  const userRows = await database
    .selectDistinct({ userId: memories.userId })
    .from(memories)
    .where(and(isNull(memories.deletedAt), isNull(memories.supersededBy)))
    .catch(() => []);
  let briefed = 0;
  for (const row of userRows) {
    const done = await buildMorningBrief({
      store: remiStore,
      userId: row.userId,
      model: {
        provider: runtimeModel.provider,
        model: runtimeModel.defaultModel,
      },
      apiKey,
      environment: process.env,
    }).catch(() => null);
    if (done?.briefed) briefed += 1;
  }
  return context.json({ users: userRows.length, briefed });
});

/**
 * The live screen, proxied.
 *
 * Proxied rather than connected directly. `agent-computer` authenticates its callers with a
 * shared token, not with a person's session, and it must never be reachable from a browser. So the
 * socket terminates here, behind the same session guard as every other route, and this process opens
 * a second socket inward carrying the token.
 *
 * Not a Hono route because an upgrade is not a request/response: Bun hands it over before Hono sees a
 * body, so it is handled in `fetch` ahead of the app.
 */
/*
 * The Bot travels in the query, because a websocket upgrade carries no custom header for the
 * computer to read and every call it serves is per Bot. The secret travels the same way and for the
 * same reason, this socket is the one a person can type into, so it is the last thing that should
 * be reachable without it.
 *
 * The Bot in that query is the SCOPED computer key, and the secret is the one
 * derived for that computer (strict per-user sandboxing): the stream shows one
 * user's browser, so it must open exactly that user's computer and present
 * exactly that computer's token — a deployment-wide token here would put every
 * screen behind one shared secret on a published port.
 *
 * The `sig` is not decoration. The computer verifies that the Bot id in this query was signed with
 * the secret it holds, and a WebSocket upgrade carries no headers — so the signature has to ride
 * here like the token does. Without it every upgrade was refused and the screen never opened, which
 * looked like a dead computer rather than a missing parameter.
 */
const toStreamUrl = (baseUrl: string, computerKey: string, token: string) =>
  `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/stream?bot=${encodeURIComponent(computerKey)}&token=${encodeURIComponent(token)}&sig=${encodeURIComponent(
    computerBotIdSignature(token, computerKey),
  )}`;

/**
 * Which Bot's screen. The Bot is named in the path and its computer is located the same way every
 * other call locates it, so the live stream cannot point at a different Bot's browser.
 */
const streamPathBotId = (pathname: string): string | null => {
  const match = pathname.match(/^\/api\/computers\/([^/]+)\/stream$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

/** What each proxied socket carries: where to connect inward, and the socket once opened. */
type StreamData = { upstream: string; inward?: WebSocket };

/**
 * Bun takes exactly one WebSocket handler for the server, and two features need one: the app proxies
 * the computer stream, and it pushes channel activity through Hono's adapter. So this one
 * dispatches on what the upgrade attached, a proxy socket carries `upstream`, a Hono socket does
 * not, rather than either feature quietly taking the slot and breaking the other on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
/*
 * The hosted desktop no longer has a socket of its own, and that is worth writing down rather than
 * just noticing in a diff.
 *
 * It used to: the browser opened `/api/computers/desktop/stream`, this process captured a JPEG per
 * frame from a remote screenshot API and pushed it down, and every mouse move the person made came
 * back up the same socket and through a control-plane round trip before the desktop saw it. The frame
 * rate was therefore the platform's latency, and the pointer arrived seconds after the hand stopped
 * moving, which is what "taking control feels laggy" actually was.
 *
 * Now the browser talks noVNC straight to the desktop over RFB and this process is not in the data
 * path at all. `GET /api/computers/desktop/stream` hands over a URL and a per-session password
 * instead: frames cost only what changed on screen, and input never passes through us.
 *
 * What did NOT go away is `createDesktopInputQueue`, and it is still load-bearing — a Bot drives the
 * same desktop through the tools, and a Bot dragging a window produces the same sixty pointer moves a
 * second a person did. Ordering and coalescing are what stop that queueing behind itself.
 */

/*
 * THE WHEEL ON THE USER'S DESKTOP, mounted here rather than in `createApp`.
 *
 * A desktop is one machine with one mouse and one keyboard, so a person and a Bot driving
 * it at the same time is a real collision rather than a per-Bot inconvenience: a click lands
 * mid-keystroke and neither side can tell what happened.
 *
 * Mounted out here because `createApp`'s parameters are positional and its own comment warns that
 * inserting one silently shifts every later argument. Three routes do not justify that risk, and the
 * stream that has to agree with them is in this file already.
 */
if (desktopProvisioner) {
  app.route(
    "/api/computers/desktop",
    createDesktopControlRoutes(
      userComputerStore,
      requireUserFor(config.singleUser, auth),
      /*
       * `null` for the per-Bot store, so every per-Bot route on that router answers 404.
       *
       * There is one computer per person and Remii holds it, so a per-Bot screen does not exist. The
       * routes are kept rather than deleted so a client that still asks is told "no such computer"
       * instead of getting a shape it would have to handle, and the router checks for the store's
       * absence rather than for a flag — a deployment that later wants per-Bot machines passes a store
       * back in and every route comes back to life.
       */
      null,
      /*
       * The person's own Bots, and only theirs.
       *
       * Scoped by owner in the query rather than filtered afterwards, so there is no window in which
       * a Bot belonging to somebody else is read and then dropped. A fleet page that listed the
       * deployment's Bots to anyone who asked would be a data leak wearing a feature.
       */
      async (userId: string) =>
        database
          .select({ id: agentProfiles.agentId, name: agentProfiles.title })
          .from(agentProfiles)
          .where(eq(agentProfiles.ownerUserId, userId))
          .orderBy(asc(agentProfiles.title)),
      /*
       * The person's one computer, and the hours behind it.
       *
       * Both halves here because the page's two questions are "is it there" and "how much is left", and
       * answering them from different places is how the previous version came to show a fleet of
       * computers that did not exist while the real one went unmentioned.
       *
       * A person with no row yet is `null` rather than an empty object, so the page can say the
       * computer has not been started — which is the ordinary state for somebody who has never asked
       * Remii for it, and is NOT an error.
       */
      async (userId: string) => {
        const [row, plan] = await Promise.all([
          userComputerStore.get(userId),
          limitsForUser(database, userId).catch(() => PLANS.pro),
        ]);
        const hoursUsed = await computerMeter
          .hoursThisMonth(userId)
          .catch(() => 0);
        if (!row) return null;
        return {
          computer: {
            status: row.status,
            displayWidth: row.displayWidth,
            displayHeight: row.displayHeight,
            lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
          },
          hoursUsed: Math.round(hoursUsed * 100) / 100,
          hoursIncluded: plan.computerHoursPerMonth,
          isolation: "per-person" as const,
        };
      },
      /*
       * Open this person's live screen. A callback rather than a store, because opening the screen
       * has to be able to START a machine and mint a VNC password, which is the provisioner's job.
       *
       * It resumes, on purpose. Opening the screen is a request to use the computer, and a person who
       * has just pressed "Take control" should not watch a spinner while a paused desktop comes back.
       */
      /*
       * A still frame, without starting anything.
       *
       * The card polls this the moment a page opens, and a poll that could provision a machine would
       * mean opening a chat costs a desktop. So this reads the row and answers `null` for somebody who
       * has never asked, rather than handing them a computer because they opened a page.
       *
       * AND A POLL MUST NOT WAKE A PAUSED ONE, which is a second thing "without starting anything"
       * has to mean, and which it did not mean. `sandboxFor` connects to the machine, and on E2B
       * CONNECTING TO A PAUSED SANDBOX RESUMES IT. So a panel left open on an idle computer polled
       * every few seconds, and every poll woke the desktop the idle sweep had just paused — which then
       * billed at full rate forever while the database said `STOPPED`. That is the worst possible
       * combination: money spent, no screen, and a row that says the machine is asleep.
       *
       * The row's own status is the answer, and it is the right one: the sweep wrote `STOPPED` and
       * nothing else rewrites it while nobody is using the machine. So a poll for somebody whose
       * computer is not running returns `null`, which the card already renders as "no screen yet" —
       * an honest answer for a machine that is genuinely asleep, and no longer one that costs money.
       */
      async (userId: string) => {
        const row = await userComputerStore.get(userId);
        if (!row?.sandboxId || !desktopProvisioner) return null;
        if (row.status !== "RUNNING" && row.status !== "READY") return null;
        const sandbox = (await desktopProvisioner.sandboxFor({
          key: userId,
          userId,
        })) as unknown as E2BDesktopLike;
        const shot = await captureScreenshot(sandbox);
        if (!shot) return null;
        return {
          base64: shot.data,
          width: row.displayWidth ?? DESKTOP_RESOLUTION.width,
          height: row.displayHeight ?? DESKTOP_RESOLUTION.height,
        };
      },
      (userId: string) => openDesktopStream(userId),
      // Settings' "switch off" and "reset". Both per person, because the computer is: a pause is
      // reversible and costs nothing while paused, and a reset is the only thing here that kills a
      // sandbox. Wired to the provisioner because it is the only thing that knows how.
      async (scope: { key: string; userId: string }) => {
        // "idle" rather than "person": this is the idle sweep's own verb, reached from a button. The
        // reason on the billing session is about WHY the clock closed, and a person pressing "switch
        // off" is the same event as the sweep deciding it is unused — the machine pauses either way.
        await desktopProvisioner?.stopIdle(scope, "idle");
      },
      /*
       * Remove it for good, rather than pausing it.
       */
      async (userId: string) => {
        if (!desktopProvisioner) return false;
        await desktopProvisioner.destroy({ key: userId, userId });
        // The row goes too, so a person who resets gets a genuinely NEW computer rather than one
        // that keeps the geometry and status of the machine they just discarded.
        await userComputerStore.remove(userId);
        return true;
      },
      /*
       * The secret flow, and the reason it takes three collaborators is that it is the only feature
       * here whose whole point is that a value does NOT travel through the model.
       *
       *   - `readSecretWanted` tells the browser a request is OUTSTANDING so it can show the masked
       *     box. It returns the LABEL. It has no access to a value and could not return one.
       *   - `supplySecret` receives what the person typed and hands it to whoever is waiting. The waiter
       *     is a promise, so the value exists exactly once, in flight, and is typed and forgotten.
       *   - the tool itself, in `desktop-tools`, is what turns that promise into keystrokes.
       */
      (userId: string) => secretWantedFor(userId),
      (userId: string, text: string) => supplySecret(userId, text),
    ),
  );
}

type SocketData = StreamData | ChannelSocket["data"];

/** Whether this socket is a proxied computer stream rather than one of Hono's own. */
const isProxiedStream = (data: SocketData): data is StreamData =>
  typeof (data as StreamData).upstream === "string";

// Hono owns the socket's data once it has upgraded it; this hands its own back to it.
const asChannelSocket = (ws: { data: SocketData }) =>
  ws as unknown as ChannelSocket;

serve<SocketData>({
  port,
  /*
   * A first computer boot is slow: creating a cloud sandbox from snapshot,
   * starting it and waiting for its service can take over a minute, and the
   * HTTP request that triggered it idles the whole time. The Bots already
   * serve with 120 for the same reason (a wedged stream); this matches it.
   */
  idleTimeout: 120,
  async fetch(request, server) {
    const url = new URL(request.url);
    const streamBotId = streamPathBotId(url.pathname);
    if (
      streamBotId !== null &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      if (!config.computer) {
        return new Response("No computer is configured.", { status: 503 });
      }
      // The session guard, applied by hand because middleware does not run on an upgrade. An
      // unauthenticated socket here would be the whole point of the proxy defeated.
      const actor = await resolveRequestActor(request).catch(() => null);
      if (!actor) {
        return new Response("Sign in first.", { status: 401 });
      }
      // And which Bot, which the guard above does not answer. This socket carries that Bot's screen,
      // so signing in is not enough: without this, anybody signed in watches anybody's Bot work.
      if (
        !(await agentProfileStore
          .get({ id: actor.id, role: actor.role }, streamBotId)
          .catch(() => null))
      ) {
        return new Response("There is no such Bot.", { status: 404 });
      }
      /*
       * Through the gateway, not the provider.
       *
       * `gateway.locate` runs checkComputerAddress; `provider.locate` does not, and the URL built
       * below carries COMPUTER_TOKEN in its query string. A provider that answered with a foreign
       * host was handed the deployment's computer token, which is the case that check was written
       * for. Every acting path already went through the gateway; this one did not.
       */
      let upstream: string;
      try {
        const streamBase = computerGateway
          ? await computerGateway.locate(streamBotId, actor.id)
          : undefined;
        if (!streamBase) {
          return new Response("No computer address is configured.", {
            status: 503,
          });
        }
        const streamKey = await computerGateway?.keyOf(streamBotId, actor.id);
        upstream = toStreamUrl(
          streamBase,
          streamKey ?? streamBotId,
          computerGateway?.streamToken(streamKey ?? streamBotId) ??
            config.computer?.token ??
            "",
        );
      } catch (error) {
        // Said out loud rather than falling back to another Bot's computer, which is the failure this
        // whole path exists to prevent.
        return new Response(
          error instanceof Error
            ? error.message
            : "That Bot's computer could not be reached.",
          { status: 502 },
        );
      }
      if (server.upgrade(request, { data: { upstream } })) {
        return undefined as unknown as Response;
      }
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    }
    return app.fetch(request, { server });
  },
  websocket: {
    open(ws) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.open(asChannelSocket(ws));
        return;
      }
      const inward = new WebSocket(ws.data.upstream);
      ws.data.inward = inward;
      // Frames outward, input inward. Buffered by neither side: a frame the browser is too slow for
      // should be dropped, not queued, because a stale frame is worse than a missing one.
      inward.onmessage = (event) => {
        try {
          ws.send(String(event.data));
        } catch {
          inward.close();
        }
      };
      inward.onclose = () => ws.close();
      inward.onerror = () => ws.close();
    },
    message(ws, raw) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.message(asChannelSocket(ws), raw);
        return;
      }
      if (ws.data.inward?.readyState === 1) ws.data.inward.send(String(raw));
    },
    close(ws, code, reason) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.close(asChannelSocket(ws), code, reason);
        return;
      }
      ws.data.inward?.close();
    },
  },
});

if (config.singleUser) {
  // Loud, every boot. A server that is not checking who is asking should never be a quiet default.
  console.warn(
    "No identity provider is configured, so every request is treated as " +
      `${DEV_ACTOR.email} (one local user). Configure GOOGLE_OAUTH_*, ` +
      "MICROSOFT_OAUTH_* or OKTA_OAUTH_* before anybody else can reach this.",
  );
}

// Each listener holds a connection of its own for the life of the process. Released on the way out,
// so a watch-mode restart does not leave two behind on every reload.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void Promise.allSettled([
      channelActivityListener.stop(),
      policyListener.stop(),
      // Started only where handing work between Bots is switched on, so it is often not there.
      workOfferedListener?.stop() ?? Promise.resolve(),
      Promise.resolve(retentionSweeps.stop()),
      Promise.resolve(activitySweeps.stop()),
      // The idle sweep holds a timer, so a watch-mode restart would otherwise leave one behind per
      // reload — and each of them stops desktops, which is not something two copies of this process
      // should be doing at once. Only present where there is a desktop to reclaim.
      stopIdleSweeps?.() ?? undefined,
    ]).finally(() => process.exit(0));
  });
}

console.info(`Remii server listening on http://127.0.0.1:${port}`);

/**
 * How many desktops one person may have running, from the environment.
 *
 * Defaults to 1. One computer per person is the whole model, so a higher number is only reachable by
 * configuring it, and a deployment that configures it is asking for several billable machines for
 * has upgraded to Tier 2 (200GiB) sets this higher and gets the isolation they paid for.
 *
 * Read here rather than in the config module because it is a capacity question about the platform
 * account, not a correctness question about this deployment — the same build run against two
 * organizations wants two different numbers.
 */
function desktopConcurrencyLimit(): number {
  const raw = process.env.E2B_MAX_DESKTOPS_PER_USER;
  const parsed = Number(raw);
  if (
    raw === undefined ||
    raw.trim() === "" ||
    !Number.isFinite(parsed) ||
    parsed < 1
  )
    return 1;
  return Math.floor(parsed);
}

/**
 * How many minutes of nothing happening before the desktop is switched off.
 *
 * The plan's number, overridable by `E2B_AUTOSTOP_MINUTES`.
 *
 * This used to read the plan unconditionally, with a comment explaining why `E2B_AUTOSTOP_MINUTES` was
 * deliberately not consulted: the platform's own idle interval does not fire for a Bot driving the
 * machine over the API, so a real sweep on `last_seen_at` is the only thing that actually stops the
 * clock, and the guidance the model is given quotes the number — so behaviour and prompt must not
 * drift.
 *
 * Both halves of that are still true and both are now honoured. The sweep is still the only thing that
 * stops the clock. The drift is gone because the prompt no longer hardcodes the figure: it is
 * generated from the same reader this calls, in `shared/desktop-idle.ts`. So the setting, which
 * was parsed, validated and documented in `.env.example` while nothing read it, is live — an operator
 * who raises it to keep a desktop warm across a working session now gets that, AND the agent is told
 * the truth about when its machine sleeps.
 *
 * Unset means the plan's number, so the default is unchanged.
 */
function desktopIdleStopMinutes(): number {
  return effectiveIdleStopMinutes();
}
