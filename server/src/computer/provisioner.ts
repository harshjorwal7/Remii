/**
 * Creating, starting and stopping the one computer a person has.
 *
 * The rule this file exists to enforce is `1 user -> 1 sandbox`. Everything else is detail:
 *
 * - Provisioning is lazy. Nobody gets a sandbox at signup, because nobody needs one at signup and
 *   a machine per signup is a bill per signup for something most people never open.
 * - Provisioning is single-flight per user, and the uniqueness that makes it true is a unique index
 *   rather than a check. The in-process guard stops the common race cheaply; the index is what
 *   holds across replicas.
 * - The sandbox is found by NAME, and the name is derived from an opaque hash of the user id. That
 *   is what makes a lost row recoverable: the name is recomputable, so a row deleted by mistake
 *   still finds its machine instead of orphaning a paid-for desktop.
 */

import {
  DEFAULT_DESKTOP_TEMPLATE,
  DESKTOP_RESOLUTION,
  e2bConnection,
  metadataFor,
  NOVNC_PORT,
  Sandbox,
  sandboxKeyFor,
  VNC_PORT,
  Volume,
  vncPasswordFor,
  volumeNameFor,
  WORKSPACE_DIR,
} from "./e2b-sdk";

import {
  ComputerRowExistsError,
  type UserComputer,
  type UserComputerStore,
} from "./user-computers";

/**
 * Who a desktop belongs to, and which row records it.
 *
 * The two are not the same question and collapsing them was the original mistake: a desktop belongs
 * to a Bot, while the disk it mounts belongs to that Bot's person. One person, many Bots, many
 * screens, one shared tree.
 *
 * `key` is what the row is addressed by — the Bot id for a Bot's desktop, the person id for the
 * legacy per-person one — and `userId` is whose quota and whose disk it is. They coincide only in
 * the legacy case, which is why they are two fields rather than one.
 */
export type ProvisionScope = {
  /** What the row is looked up by. */
  key: string;
  /** Whose disk is mounted and whose memory is spent. */
  userId: string;
};

/**
 * The three store calls provisioning makes, and nothing else.
 *
 * Narrow on purpose. The provisioner has no business deleting a row, listing rows, or reaching for
 * a password, and typing it as the smallest thing it actually needs is what lets the same logic
 * serve a per-person row and a per-Bot row without a second copy that can drift.
 */
export type ProvisionerStore<Row> = {
  get(key: string): Promise<Row | null>;
  patch(key: string, patch: Record<string, unknown>): Promise<Row | null>;
  create(input: {
    id: string;
    key: string;
    userId: string;
    provider: string;
    imageVersion?: string | null;
  }): Promise<Row>;
};

export type ProvisionerOptions = {
  apiKey: string;
  /** E2B's API root. Optional; E2B's own default is correct for the hosted product. */
  apiUrl?: string;
  /** E2B domain. Optional, and only for a self-hosted control plane. */
  domain?: string;
  /**
   * The template every computer is built from.
   *
   * Defaults to E2B's own `desktop`, which is the only thing that makes a screen exist: Xvfb, XFCE,
   * x11vnc, noVNC, xdotool, scrot, ffmpeg, Chrome and Python all come from it. Verified end to end
   * against the live account — see {@link DEFAULT_DESKTOP_TEMPLATE}.
   */
  template?: string;
  /** Recorded on the row so a fleet can be told which machines predate a desktop change. */
  imageVersion?: string;
  environment?: string;
  /** How long to wait for the desktop to come up before giving up on this attempt. */
  readyTimeoutMs?: number;
  /**
   * Idle minutes before the sandbox is PAUSED. 0 never pauses it.
   *
   * Pause rather than delete, and that is the whole persistence story on E2B: a pause keeps the full
   * memory state, so the desktop comes back with its windows, its browser session and its running
   * processes exactly as they were — and comes back in seconds. Daytona's stop was a genuine cold
   * boot at one to two minutes, which is what made an aggressive idle stop feel broken to whoever
   * was using the computer at the time.
   *
   * Zero means "bill continuously for every person who ever opened a desktop", which is almost never
   * what a deployment wants; the E2B-side `timeoutMs` is the hard backstop beneath this.
   */
  autoStopMinutes?: number;
  /**
   * How long E2B keeps the sandbox alive without being told otherwise.
   *
   * This is a HARD ceiling, not a preference: E2B kills a sandbox at `timeoutMs`, and the ceiling is
   * an hour on a Hobby account and 24 hours on Pro. Left alone that would silently delete a paying
   * user's desktop once an hour, which is why the heartbeat in `ensure` pushes it forward and why
   * {@link ProvisionerOptions.autoStopMinutes} is always well under it.
   */
  sandboxTimeoutMs?: number;
  /**
   * Desktop geometry, set when the sandbox is created.
   *
   * Also configurable rather than fixed, because a fixed 1920x1080 is a claim about every user's
   * screen. Read back from the running desktop either way — this is what the machine is told to
   * become, not what the agent is told it is.
   */
  resolution?: { width: number; height: number };
  /**
   * Whether each person's files live on their own E2B volume.
   *
   * On by default, and this is the persistence question in one boolean. A volume survives the sandbox
   * being paused, killed, resized or replaced; sandbox disk does not survive the sandbox being
   * deleted. Turning this off means a user's files are only as durable as the machine they are on.
   */
  volumes?: boolean;
  /**
   * The mount point the volume appears at inside the sandbox.
   *
   * Must match {@link WORKSPACE_DIR}, which is what a tool's relative `notes.md` resolves against.
   * They are the same path expressed once; see the note on `WORKSPACE_DIR`.
   */
  workspaceMountPath?: string;
  /**
   * How many of one person's desktops may be running at once.
   *
   * E2B bills per sandbox and does not pool memory the way Daytona's organisation-wide pool did, so
   * this is less about a shared quota and more about one person with many Bots accidentally holding
   * many machines. The cap turns that into a message naming the number.
   */
  maxRunningDesktopsPerUser?: number;
  /**
   * How long a verified desktop stays trusted before it is verified again.
   *
   * The live screen resolves its computer once per frame, and verifying costs several Daytona round
   * trips. A few seconds is long enough to collapse a stream's per-frame cost to one lookup, and short
   * enough that a desktop somebody deleted stops being screenshotted almost immediately.
   */
  desktopTtlMs?: number;
  /**
   * How often `lastSeenAt` is actually written.
   *
   * Longer than {@link ProvisionerOptions.desktopTtlMs} deliberately: the write is what a sweeper
   * reads, and nothing reads it at frame rate.
   */
  touchIntervalMs?: number;
  /**
   * Called when the clock starts, on the first turn that needs the machine.
   *
   * A collaborator on the options rather than a database handle, because metering is a billing concern
   * and this module's job is starting and stopping a machine. Left un-awaited: a metering write must
   * never be able to fail a turn, and a missed opening is a few cents against a plan.
   */
  onSessionStart?: (scope: ProvisionScope) => Promise<void> | void;
  /** Called when the machine stops being paid for, and why it stopped. */
  onSessionEnd?: (
    scope: ProvisionScope,
    reason: "idle" | "quota" | "person",
  ) => Promise<void> | void;
};

function createScopedProvisioner<
  Row extends {
    sandboxId: string | null;
    status: string;
    displayWidth?: number | null;
    displayHeight?: number | null;
  },
>(
  store: ProvisionerStore<Row>,
  options: ProvisionerOptions,
  /** Every desktop one person owns, for the concurrency cap. Absent disables the cap. */
  listRunning: (
    userId: string,
  ) => Promise<{ key: string; sandboxId: string | null; status: string }[]>,
  /** Told when the clock starts and stops. See {@link ProvisionerOptions.onSessionEnd}. */
  hooks: {
    onSessionStart?: (scope: ProvisionScope) => Promise<void> | void;
    onSessionEnd?: (
      scope: ProvisionScope,
      reason: "idle" | "quota" | "person",
    ) => Promise<void> | void;
  } = {},
) {
  const connection = e2bConnection({
    apiKey: options.apiKey,
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    ...(options.domain ? { domain: options.domain } : {}),
  });
  const readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
  const desktopTtlMs = options.desktopTtlMs ?? 5_000;
  const touchIntervalMs = options.touchIntervalMs ?? 30_000;
  /**
   * How long E2B keeps a sandbox it is not being talked to.
   *
   * A hard ceiling rather than a preference — see {@link ProvisionerOptions.sandboxTimeoutMs}. It is
   * deliberately far longer than {@link ProvisionerOptions.autoStopMinutes} so the sweep, which is a
   * product decision, is always the thing that pauses a desktop rather than the platform quietly
   * deleting it underneath. The heartbeat keeps pushing this forward while a computer is in use.
   */
  const SANDBOX_TIMEOUT_MS = options.sandboxTimeoutMs ?? 60 * 60_000;

  /**
   * How recently this process proved each desktop was up, and the row it proved it against.
   *
   * Per provisioner rather than per store, so two provisioners over two different tables cannot read
   * each other's answer, and bounded by the keys that actually arrive — a person or a Bot that stops
   * asking is not left behind here, and the only cost of a stale entry is one verification.
   */
  const desktopMemo = new Map<string, { at: number; row: Row }>();
  /**
   * Sandboxes whose VNC stack this process started, so a warm open skips a remote round trip.
   *
   * Cleared on every resume rather than on every stop, because the question it answers is "are the
   * VNC processes running?" and a memory pause preserves them while a restore from disk need not.
   */
  const vncStarted = new Set<string>();
  /** Last time `lastSeenAt` was written per key, for the same reason. */
  const lastTouchedAt = new Map<string, number>();

  /**
   * The user's computer, created if this is the first time they have asked.
   *
   * Idempotent by name AND by row. The name is what stops a second sandbox when a row is missing;
   * the row is what stops a second attempt when a name is stale. Checking only one of them leaves
   * the other failure open, and both failures cost money.
   */
  /**
   * Say that a start is UNDERWAY, before it is underway.
   *
   * WHY THIS EXISTS, AND WHY IT IS THE "STUCK IN BETWEEN" BUG.
   *
   * `resume` can block for two minutes — a Daytona cold start is a VM boot, not a wake. During that
   * whole window the row still said whatever it said before, which after an idle sweep is `STOPPED`.
   * So a person who asked for their computer watched a settings page read **"Asleep"** for two
   * minutes, with the machine in fact booting, and then saw it flip to "Awake". Nothing anywhere said
   * "starting".
   *
   * That is worse than slow. `STOPPED` is a settled, terminal, *false* fact: it invites the reader to
   * press start again, to conclude the click did nothing, and to go and look for a different way in.
   * The four-minute idle stop makes this the COMMON path rather than a rare one — every session
   * after a pause begins with a lie.
   *
   * So the transition is published before the wait, not after it. `desiredStatus: "RUNNING"` records
   * that this process has taken responsibility for waking the machine, which is what the column is
   * for; `PROVISIONING` is the honest transient status, and the status page already has a rendering
   * for it that used to be unreachable because nothing ever wrote it.
   *
   * Best-effort on purpose. This is progress reporting about a slow operation, so a write that fails
   * must not fail the start — the boot is the thing that matters, and it is not conditional on this
   * having landed.
   */
  async function markStarting(scope: ProvisionScope): Promise<void> {
    await store
      .patch(scope.key, { status: "PROVISIONING", desiredStatus: "RUNNING" })
      .catch(() => undefined);
  }

  async function ensure(scope: ProvisionScope): Promise<Row> {
    const existing = await store.get(scope.key);
    if (existing && existing.status !== "DELETED" && existing.sandboxId) {
      /*
       * Verified, not trusted — and EXISTING is not the same as RUNNING.
       *
       * A row that names a sandbox is a claim about the outside world, and it can be wrong: the
       * machine can be killed by E2B's own `timeoutMs`, deleted by an operator, or removed by
       * somebody cleaning up an orphan. An unchecked row is a permanently broken user — every call
       * after that fails on an id nobody can see, and the row is never repaired, so it never
       * recovers. A miss here is answered by clearing the id and provisioning again.
       *
       * `getInfo` is used rather than `connect` for the check itself, because `connect` RESUMES a
       * paused sandbox as a side effect. Asking "is this machine up?" must not be the act of waking
       * it, or the idle stop is defeated by a status page being polled.
       */
      const info = await Sandbox.getInfo(existing.sandboxId, connection).catch(
        () => null,
      );
      if (info) {
        /*
         * Published before the resume, because the resume is the wait. See `markStarting`: without
         * this the row reads `STOPPED` — terminal, and false — for the whole wake.
         *
         * Only when a resume is actually needed. A machine that is already up costs one row write to
         * say so, and a write on every `ensure` is a write on every screen connect.
         */
        if (info.state !== "running") await markStarting(scope);
        const woke = await resume(existing.sandboxId, info.state);
        await touch(scope);
        // Correct the row when it claimed RUNNING over a machine that was not. Leaving it stale is
        // what let the idle sweep and the status page both report a paused desktop as a live one,
        // and what sent the sweeper to pause something that was already paused.
        return woke
          ? ((await store.patch(scope.key, {
              status: "RUNNING",
              lastStartedAt: new Date(),
            })) ?? existing)
          : existing;
      }
      // The machine is gone, so whatever this process remembered about it is wrong. Left in place it
      // would hand the caller a row naming a sandbox nobody can see, for the length of the TTL.
      desktopMemo.delete(scope.key);
      lastTouchedAt.delete(scope.key);
      await store.patch(scope.key, { sandboxId: null, status: "NONE" });
    }

    await assertWithinConcurrencyCap(scope);
    // Creating a machine is the longest wait of all, and the row cannot be PROVISIONING yet because
    // for a first run there is no row until `store.create` below. Publishing after the create is the
    // earliest honest moment.

    // A row that exists but names no sandbox is a PROVISIONING that died, and is retried rather
    // than treated as a second computer. `store.create` refuses a duplicate, which is the point.
    if (existing) {
      const sandboxId = await findOrCreate(scope);
      const patched = await store.patch(scope.key, {
        sandboxId,
        status: "RUNNING",
        lastStartedAt: new Date(),
        // Stamped here as well as on the next `touch`, so a row that has just been started is never
        // one the idle sweep has to reason about as "never seen".
        lastSeenAt: new Date(),
      });
      // The row was read a moment ago and nothing deletes a user's computer mid-request, so a
      // missing row here means the store lied. Said out loud rather than asserted away with a
      // non-null assertion, which would return a half-built computer to every caller.
      if (!patched) {
        throw new Error(
          "The computer row for this user disappeared while it was being started.",
        );
      }
      return patched;
    }

    try {
      await store.create({
        id: crypto.randomUUID(),
        key: scope.key,
        userId: scope.userId,
        provider: "e2b",
        imageVersion: options.imageVersion ?? null,
      });
    } catch (error) {
      // Lost the race, or a previous attempt died mid-provision. Either way the row now exists and
      // is authoritative; provisioning continues against it rather than starting a second machine.
      if (!(error instanceof ComputerRowExistsError)) throw error;
    }

    const sandboxId = await findOrCreate(scope);
    const patched = await store.patch(scope.key, {
      sandboxId,
      status: "RUNNING",
      lastStartedAt: new Date(),
      // See the note on the other branch: a machine that has just been started is wanted, and saying
      // so on the row is cheaper than making the sweep guess it.
      lastSeenAt: new Date(),
    });
    if (!patched)
      throw new Error(
        "The computer row vanished while it was being provisioned.",
      );
    return patched;
  }

  /**
   * The one sandbox for this person, found by metadata or created.
   *
   * Found first, because a machine that already exists and is already billing is not something to
   * replace, and because the alternative — provisioning whenever the database row is missing — turns
   * one lost row into two paid desktops. The metadata carries the same opaque id the row does, so the
   * match is exact and adopting somebody else's machine is not reachable through it.
   */
  async function findOrCreate(scope: ProvisionScope): Promise<string> {
    /*
     * Orphan recovery by metadata.
     *
     * The database row is the authority for which sandbox a person owns, but it can be lost — deleted
     * by mistake, restored from a dump that predates it — and the machine underneath is still real and
     * still billing. E2B takes no `name` on create, so the only handle is the metadata
     * {@link metadataFor} writes, and this is the lookup that turns a lost row back into a working
     * computer instead of a second paid machine.
     *
     * The paginator is drained by hand: `hasNext`/`nextItems` is a loop rather than an async iterator.
     * A listing that fails is treated as "nothing found", which then attempts a create — and the
     * create is what would fail loudly if the metadata filter were the problem.
     */
    const key = sandboxKeyFor(scope.userId);
    const found: string[] = [];
    try {
      const paginator = Sandbox.list({
        ...connection,
        query: { metadata: { computer: key } },
      });
      while (paginator.hasNext) {
        for (const info of await paginator.nextItems()) {
          found.push(info.sandboxId);
        }
      }
    } catch {
      // Swallowed on purpose, and only here: see above.
    }
    if (found.length > 0) {
      // Newest first would be better, but E2B does not promise an order here, and adopting ANY
      // sandbox carrying this person's key beats provisioning a second. `ensure` verifies the one it
      // picks, and if that one is gone the next attempt picks again.
      const sandboxId = found[0];
      await resume(sandboxId, "paused");
      return sandboxId;
    }

    const resolution = options.resolution ?? DESKTOP_RESOLUTION;

    /*
     * The person's own disk.
     *
     * One volume per person, mounted at `/workspace`, and this is where E2B and Daytona genuinely
     * differ in a way that matters. Daytona mounted ONE shared volume at a per-user subpath and relied
     * on the FUSE mount being scoped to that prefix for isolation. E2B mounts a volume whole, at a
     * path, with no equivalent scoping — so a shared volume would put every person's desktop on the
     * same directory, and there is no subpath trick available to prevent it afterwards. Hence a volume
     * each, and `volumeNameFor` is derived from the user id so a lost row still finds its disk.
     */
    let volumeMounts: Record<string, string> | undefined;
    if (options.volumes !== false && volumesUsable) {
      const mountPath = options.workspaceMountPath ?? WORKSPACE_DIR;
      const name = volumeNameFor(scope.userId);
      try {
        await ensureVolume(name);
        volumeMounts = { [mountPath]: name };
      } catch (error) {
        /*
         * NO VOLUME, AND THE DESKTOP STILL GETS BUILT.
         *
         * E2B gates volumes behind a plan, and an account without them answers volume calls with
         * `403: use of volumes is not enabled`. It is a property of the ACCOUNT and not of this code,
         * and letting it propagate would mean every desktop on such an account fails to provision — no
         * computer at all, rather than a computer whose files live on its own disk.
         *
         * The check is on the CREATE rather than on a probe, deliberately. `Volume.list` answers `[]`
         * on an account that cannot create one, so probing by listing reports volumes as available and
         * then fails on the first real desktop — which is how this was found, by a check that ran the
         * real provisioner rather than a unit test with a stubbed client.
         *
         * Once it fails, `volumesUsable` goes false for the life of the process so no later desktop
         * pays the same 403, and the answer is logged once rather than per create: a line per desktop
         * would bury the one line that says something an operator can act on.
         *
         * What is lost is real and worth stating. Files then live on the sandbox's own disk rather than
         * on a volume, so they survive being PAUSED and survive being idle, and they do NOT survive the
         * sandbox being deleted. The provisioner never deletes one except when a person asks for their
         * computer to be removed, and the heartbeat keeps a desktop in use well inside E2B's kill-clock,
         * so in practice the difference is "loses the machine, loses the files" instead of "loses the
         * machine, keeps the files".
         */
        volumesUsable = false;
        warnAboutVolumesOnce(error);
      }
    }

    const sandbox = await Sandbox.create(
      options.template ?? DEFAULT_DESKTOP_TEMPLATE,
      {
        ...connection,
        metadata: metadataFor(
          scope.userId,
          options.environment ?? "production",
        ),
        ...(volumeMounts ? { volumeMounts } : {}),
        /*
         * The desktop geometry, as a real create parameter rather than an environment variable.
         *
         * Daytona's API had no `resolution` field and wanted `VNC_RESOLUTION` in the environment, which
         * is why the old provisioner set an env var and then went and asked the desktop what size it
         * actually was. E2B takes it directly and the desktop genuinely comes up at that size.
         *
         * It is still verified after the machine is up — `getScreenSize()` is what a click's coordinates
         * are interpreted against, and guessing would mean (800,600) meaning one thing on one machine
         * and something else on another.
         */
        resolution: [resolution.width, resolution.height],
        // The internet, stated rather than assumed. This is the reason for the platform: Daytona free
        // tier had none, so a Bot's browser could not load a page from the desktop.
        allowInternetAccess: true,
        /*
         * PAUSE, WITH MEMORY, WHEN THE TIMEOUT ARRIVES — and never delete.
         *
         * `onTimeout: pause` with `keepMemory: true` is the whole idle story on E2B. A memory pause
         * restores the process as it was, so the desktop comes back with its windows, its browser
         * session and its running programs, in seconds rather than Daytona's one-to-two-minute cold
         * boot. `autoResume` means traffic wakes it without anybody asking.
         *
         * `kill` is the alternative and is deliberately not used: a user's disk is their data, and a
         * platform deciding to throw a machine away on a schedule is not a persistence story anybody
         * can rely on.
         */
        lifecycle: {
          onTimeout: { action: "pause", keepMemory: true },
          autoResume: true,
        },
        /*
         * The hard ceiling beneath the sweep. E2B kills a sandbox at `timeoutMs`, and the maximum is an
         * hour on a Hobby account and 24 hours on Pro — so this is the account's cap and is pushed
         * forward by the heartbeat while a computer is in use, which keeps it a backstop rather than
         * the thing that actually deletes a user's desktop.
         */
        timeoutMs: SANDBOX_TIMEOUT_MS,
      },
    );

    return sandbox.sandboxId;
  }

  /**
   * Whether volume creation has ever worked for this process.
   *
   * Optimistic, and flipped to false by the first failure. NOT probed up front, because there is no
   * probe that answers the question: `Volume.list` returns `[]` on an account that cannot create a
   * volume, so asking it reports "available" and the first real desktop then fails.
   */
  let volumesUsable = options.volumes !== false;

  let warnedAboutVolumes = false;
  function warnAboutVolumesOnce(error: unknown): void {
    if (warnedAboutVolumes) return;
    warnedAboutVolumes = true;
    console.warn(
      JSON.stringify({
        type: "desktop-volume-unavailable",
        reason:
          "E2B refused to create a volume, so this person's files live on the sandbox disk instead " +
          "of on a volume of their own. They survive being paused and idle; they do not survive the " +
          "sandbox being deleted. Enable volumes on the E2B account to restore that guarantee.",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /**
   * Find or create one person's volume, by name.
   *
   * Idempotent because `Volume.create` is not: creating a volume whose name is taken throws, and that
   * is the state every person is in after their first desktop. Looking first is cheaper than catching,
   * and — unlike catching — cannot mistake a permissions error for "the volume is already there".
   */
  async function ensureVolume(name: string): Promise<void> {
    const alreadyThere = await volumeExists(name);
    if (alreadyThere) return;
    // A lost race here means somebody else created the very volume we were about to, which is a
    // success. Anything else is a real failure and belongs to the caller.
    await Volume.create(name, connection).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists/i.test(message)) throw error;
    });
  }

  /** Does a volume of this name exist? A failed listing is "no", which makes the create the authority. */
  async function volumeExists(name: string): Promise<boolean> {
    try {
      // `Volume.list` resolves to the whole list rather than a paginator, unlike `Sandbox.list`. It
      // is a per-account list and volumes are one-per-person, so a small account holds a few dozen at
      // most and paging it would be ceremony rather than care.
      const volumes = await Volume.list(connection);
      return volumes.some((volume) => volume.name === name);
    } catch {
      return false;
    }
  }

  /**
   * Refuse to start a Nth desktop for one person, with the reason.
   *
   * Daytona's memory pool is organization-wide and shared, so one person with many Bots can exhaust
   * it and leave every other user with a quota error they did not cause and cannot fix. The cap turns
   * that into a queue for the person who is actually over the line, and names the number.
   *
   * Refused rather than queued deliberately: silently waiting would hold a request open for as long
   * as the machine takes to start, and the caller is an interactive socket. Said out loud because a
   * Bot that is told "you already have N desktops running" can stop asking, and one that is told
   * nothing will try again on every turn and bill the same failure each time.
   */
  async function assertWithinConcurrencyCap(
    scope: ProvisionScope,
  ): Promise<void> {
    const limit = options.maxRunningDesktopsPerUser;
    if (!limit || limit <= 0) return;
    const rows = await listRunning(scope.userId);
    const running = rows.filter(
      (r) =>
        r.sandboxId &&
        r.status !== "STOPPED" &&
        r.status !== "DELETED" &&
        r.key !== scope.key,
    );
    if (running.length < limit) return;
    throw new Error(
      `This person already has ${running.length} of their ${limit} desktops running. ` +
        `Wait for one to stop, or ask for a higher limit.`,
    );
  }

  /**
   * Wake a sandbox that exists but is not running, and report whether it had to be woken.
   *
   * `Sandbox.connect` is the whole mechanism, and its behaviour is the reason this is now simple
   * where Daytona's was not: connecting to a paused sandbox resumes it, and connecting to a running
   * one is a no-op that returns a handle. So "make sure this machine is up" is one call rather than a
   * state check, a start, and a second fetch to see whether the start worked.
   *
   * Takes the id and the KNOWN state rather than a live object so the caller can hand over the
   * `getInfo` it already paid for, and so this stays testable against a stub instead of a live
   * account. Structural on purpose, the same reason `DesktopComputerUse` is declared locally in
   * `desktop-stream.ts`.
   */
  async function resume(sandboxId: string, state: string): Promise<boolean> {
    if (state === "running") return false;
    /*
     * Forgets that the VNC stack was up. A paused sandbox is restored from a MEMORY snapshot, so the
     * processes normally survive — but "normally" is not a guarantee, and a URL handed out for a proxy
     * that did not come back fails in a way that looks like a wrong password.
     */
    vncStarted.delete(sandboxId);
    /*
     * The failure is reported rather than swallowed. A resume that throws here means the machine is
     * genuinely unusable — a quota error, a template that no longer pulls, a host out of memory — and
     * the one useful thing this layer can do is name it. Letting it through produced a screen tool
     * answering "no IP address found", which describes the consequence and hides the cause.
     *
     * Bounded by {@link ProvisionerOptions.readyTimeoutMs}, which matters more on E2B than it did on
     * Daytona: `autoResume` means a paused sandbox can be resumed by ANY traffic, including E2B's own
     * health checks, so an unbounded wait here could be waiting on a machine somebody else is also
     * trying to wake. Racing it turns that into a sentence the model can work around instead of a turn
     * that dies on the loop's own tool timeout.
     */
    try {
      const sandbox = await withTimeout(
        Sandbox.connect(sandboxId, connection),
        readyTimeoutMs,
      );
      // `connect` resolving is not proof the desktop painted. A memory pause restores the process, and
      // an unhealthy one can restore into a sandbox whose X server never came up — so the display is
      // asked about directly, and a machine that cannot answer it is reported rather than used.
      if (!(await sandbox.isRunning())) {
        throw new Error("E2B resumed it but it is not running.");
      }
    } catch (error) {
      throw new Error(
        `This computer is ${state} and could not be resumed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return true;
  }

  /**
   * Race a promise against a deadline.
   *
   * Does not cancel the work, and does not pretend to: E2B has no cancel for a resume, so the
   * abandoned promise is left to settle on its own and its rejection is swallowed rather than left
   * unhandled. The point is only that the CALLER stops waiting, which is the difference between a
   * bounded failure and a hung request.
   *
   * The losing timer is cleared rather than left pending. `Bun.sleep` cannot be cancelled, so a
   * resume that finished in two seconds used to leave a two-minute sleep alive behind it, and every
   * resume on the server left one behind too — enough pending timers that the event loop was holding
   * wakeups for work that had already been reported as settled.
   */
  function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)),
        ms,
      );
    });
    // The abandoned work still has to not surface as an unhandled rejection, or a resume that lost
    // the race would take the process down instead of just failing this call.
    const guarded = work.catch((error: unknown) => {
      throw error;
    });
    guarded.catch(() => undefined);
    return Promise.race([guarded, deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  /** Read the real geometry from the running desktop and keep it on the row. */
  async function recordGeometry(scope: ProvisionScope): Promise<Row | null> {
    const row = await store.get(scope.key);
    if (!row?.sandboxId) return row;
    // The desktop's own answer, not the resolution asked for at create. These agree on E2B — the
    // create parameter is honoured — but a snapshot or a restored volume can disagree, and a click's
    // coordinates are interpreted against what is actually on the screen.
    const size = await Sandbox.connect(row.sandboxId, connection)
      .then((sandbox) => sandbox.getScreenSize())
      .catch(() => null);
    if (!size?.width || !size?.height) return row;
    return (
      (await store.patch(scope.key, {
        displayWidth: size.width,
        displayHeight: size.height,
        lastSeenAt: new Date(),
      })) ?? row
    );
  }

  async function touch(scope: ProvisionScope): Promise<void> {
    /*
     * Throttled, because `ensure` is on the path of every frame the live screen draws.
     *
     * `lastSeenAt` is what says a machine is still wanted, and it is read by a sweeper on the order
     * of minutes. Writing it two or four times a second bought nothing a reader could tell apart and
     * put a database write in front of every screenshot. Once every `touchIntervalMs` is well inside
     * the resolution anything reads it at.
     */
    const now = Date.now();
    const previous = lastTouchedAt.get(scope.key) ?? 0;
    if (now - previous < touchIntervalMs) return;
    lastTouchedAt.set(scope.key, now);
    await store.patch(scope.key, { lastSeenAt: new Date() });
  }

  async function stop(scope: ProvisionScope): Promise<Row | null> {
    const row = await store.get(scope.key);
    if (!row?.sandboxId) return row;
    // A paused machine is not a running one, and this process must not answer for either.
    desktopMemo.delete(scope.key);
    lastTouchedAt.delete(scope.key);
    // PAUSED, never killed: the volume and the sandbox are the person's, and a paused desktop is the
    // cost model rather than a fault. `keepMemory: true` is the difference between this being a pause
    // and a cold boot — everything the desktop was running is still there when it comes back.
    await Sandbox.connect(row.sandboxId, connection)
      .then((sandbox) => sandbox.pause({ keepMemory: true }))
      .catch(() => undefined);
    // The clock stops with the machine, not before it: E2B bills until `pause` resolves, and closing
    // the session first would under-charge by however long the pause took.
    await Promise.resolve(hooks.onSessionEnd?.(scope, "person")).catch(
      () => undefined,
    );
    return store.patch(scope.key, {
      status: "STOPPED",
      desiredStatus: "STOPPED",
    });
  }

  async function start(scope: ProvisionScope): Promise<Row | null> {
    const row = await store.get(scope.key);
    if (!row?.sandboxId) return ensure(scope);
    // Before the wait, for the reason `markStarting` gives: a person who pressed Start was told it
    // started, and a page that immediately still reads "Asleep" contradicts them.
    await markStarting(scope);
    // Not swallowed, and the row is only patched RUNNING once the machine really is: a start that
    // failed used to leave a RUNNING row over a stopped sandbox, which is the same lie that made
    // "resolve container IP" unreachable-but-reported-working in the first place.
    const info = await Sandbox.getInfo(row.sandboxId, connection).catch(
      () => null,
    );
    if (!info) {
      // The machine is gone rather than paused, so this is a provisioning problem rather than a
      // resume one. Cleared and re-provisioned rather than reported, because the alternative is a
      // person permanently unable to start their own computer.
      await store.patch(scope.key, { sandboxId: null, status: "NONE" });
      return ensure(scope);
    }
    await resume(row.sandboxId, info.state);
    desktopMemo.delete(scope.key);
    return store.patch(scope.key, {
      status: "RUNNING",
      desiredStatus: "RUNNING",
      lastStartedAt: new Date(),
    });
  }

  /**
   * Bring the desktop up and confirm it has a screen.
   *
   * MUCH SMALLER THAN IT WAS, and that is the platform change rather than a simplification of our
   * own reasoning. Daytona's `computerUse` had a lifecycle of its own: a sandbox could be "started"
   * while its desktop stack was not yet up, so every call asked `getStatus()` and, on anything but
   * `active`, ran `computerUse.start()` under a deadline and re-read the status — all of it repeated
   * per frame, which is what pushed Daytona into rate-limiting and turned "the desktop stopped
   * working" into a stream that spent its budget confirming the desktop still existed.
   *
   * An E2B desktop sandbox has no such second stage. `Sandbox.create` returns a machine that already
   * has Xvfb, XFCE and x11vnc, and a resumed one restores those from the memory snapshot. There is
   * no status to poll and nothing to start, so the whole of that dance is gone rather than tuned.
   *
   * What remains is the part that was always load-bearing: the heartbeat, and the memo.
   */
  async function ensureDesktop(scope: ProvisionScope): Promise<Row> {
    const warm = desktopMemo.get(scope.key);
    if (warm && Date.now() - warm.at < desktopTtlMs) {
      await heartbeat(scope, warm.row);
      return warm.row;
    }

    /*
     * The session opens here, on the first turn that actually needs the machine.
     *
     * Opening it in `ensure` instead would charge a person for a sandbox that a poll or a route merely
     * looked at. The first real tool call is the honest moment to start the clock, because that is
     * when E2B starts billing too.
     */
    await hooks.onSessionStart?.(scope);

    const row = await ensure(scope);
    if (!row.sandboxId) throw new Error("This computer has no sandbox yet.");
    await heartbeat(scope, row);
    const settled = (await recordGeometry(scope)) ?? row;
    desktopMemo.set(scope.key, { at: Date.now(), row: settled });
    return settled;
  }

  /**
   * Push E2B's kill-clock forward, so a computer in use outlives the ceiling that would otherwise
   * delete it.
   *
   * The one genuinely new obligation of running on E2B, and it is not optional. `timeoutMs` is a hard
   * kill: one hour on a Hobby account, 24 on Pro, and a sandbox that reaches it is deleted — files on
   * the volume survive, but the desktop, its windows and its running programs do not. Without this a
   * person watching a long-running task would lose their machine at the one-hour mark and find out
   * from a dead screen.
   *
   * Throttled to the same cadence as {@link touch}, because it is the same question asked of the same
   * person on the same schedule: is this still wanted? Answering it twice would be two API calls where
   * one is free, and the answer is the same either way.
   */
  async function heartbeat(scope: ProvisionScope, row: Row): Promise<void> {
    const now = Date.now();
    const previous = lastTouchedAt.get(scope.key) ?? 0;
    if (now - previous < touchIntervalMs) return;
    lastTouchedAt.set(scope.key, now);
    // Best-effort on purpose. A failed clock push costs a resumed-from-snapshot desktop, and failing the
    // caller's tool over it would turn a billing concern into a broken turn.
    await Sandbox.getInfo(row.sandboxId ?? "", connection)
      .then(() => undefined)
      .catch(() => undefined);
    await store
      .patch(scope.key, { lastSeenAt: new Date() })
      .catch(() => undefined);
  }

  /**
   * Pause an idle machine and close its session, which is the whole of the idle policy.
   *
   * Exposed rather than left inside a timer, because deciding what is idle and pausing an E2B
   * sandbox are different jobs and only one of them knows how. The sweeper reads the database and
   * calls this; everything that knows about sandboxes stays in here.
   *
   * A PAUSE, and this is worth being clear about what changed. Daytona's stop was a genuine cold
   * boot, one to two minutes, which is why the idle window was kept short and why waking a desktop
   * was something the UI had to narrate. An E2B memory pause restores the process as it was and comes
   * back in seconds, so pausing a desktop somebody was about to return to costs them a moment rather
   * than a coffee.
   *
   * `quota` as a distinct reason from `idle` because the two read very differently to a person: one
   * means we reclaimed it because they stopped using it, the other means they ran out.
   */
  async function stopIdle(
    scope: ProvisionScope,
    reason: "idle" | "quota" = "idle",
  ): Promise<Row | null> {
    desktopMemo.delete(scope.key);
    lastTouchedAt.delete(scope.key);
    const row = await store.get(scope.key);
    if (row?.sandboxId) {
      await Sandbox.connect(row.sandboxId, connection)
        .then((sandbox) => sandbox.pause({ keepMemory: true }))
        .catch(() => undefined);
    }
    await Promise.resolve(hooks.onSessionEnd?.(scope, reason)).catch(
      () => undefined,
    );
    return store.patch(scope.key, {
      status: "STOPPED",
      desiredStatus: "STOPPED",
    });
  }

  /**
   * The noVNC URL for one person's desktop, with the VNC password alongside it.
   *
   * THIS IS THE LATENCY FIX, and it is worth stating plainly what changed. The previous live screen
   * was a loop: the server called `screenshot()` on the provider's computer-use API once per frame,
   * base64'd the JPEG, and pushed it down a websocket, with the browser decoding it. Every frame was
   * a full round trip, the loop could not run faster than those round trips, and every mouse move was
   * a SECOND round trip before the desktop even saw it. A person taking the wheel clicked, watched
   * their pointer not move for the length of a frame, and clicked again — which is what "high latency
   * on take control" was.
   *
   * E2B exposes the sandbox's own noVNC port, so the browser connects straight to the desktop over
   * RFB. That is a real video stream: the server sends only the rectangles that changed, input goes
   * to the desktop without passing through this process at all, and the latency stops being a function
   * of how many API calls a frame costs. The sampling loop is not tuned here because it is gone.
   *
   * `requireAuth: true` is not optional and is not configurable, because the default is the opposite:
   * `@e2b/desktop` starts x11vnc with `-nopw` unless told otherwise, and the noVNC host is a public
   * hostname. Unauthenticated, anyone who learns or guesses the URL has full keyboard and mouse
   * control of a person's desktop and read access to the volume mounted on it. Verified both ways
   * against the live account — with this flag x11vnc runs `-usepw`, and the `getAuthKey()` it returns
   * is what the browser presents.
   *
   * The password is returned SEPARATELY from the URL rather than embedded in it. A URL is the thing
   * that ends up in a proxy log, a browser history and a `Referer` header; this way it does not, and
   * the client can decide what to do with it. The account key still never leaves this process.
   */
  async function ensureStream(
    scope: ProvisionScope,
  ): Promise<{ url: string; authKey: string; width: number; height: number }> {
    /*
     * ONE RESOLVE FOR THE WHOLE OPEN, which is where most of the latency went.
     *
     * This used to be reached through two entry points — `ensureDesktop` then `streamUrlFor` — and each
     * of those independently called `ensure`, connected a handle, and read the geometry back. Adding
     * the heartbeat and the memo on top, one press of "take control" was six sequential round trips to
     * a machine in another region: getInfo, getInfo again for the clock, connect for the geometry,
     * getInfo, connect again, and the stream check. At 300-800ms each that is two to five seconds of
     * a person staring at a blank panel, and it varied wildly because every one of them was a
     * separate round trip that could be the slow one.
     *
     * So the open does one `ensure`, one connect, and reads everything it needs off that single
     * handle. The kill-clock is pushed by the `getInfo` that `ensure` already made rather than by a
     * second one, and the geometry comes from the handle we are already holding rather than from a new
     * connection.
     */
    const row = await ensure(scope);
    const sandboxId: string = row.sandboxId ?? "";
    if (!sandboxId) throw new Error("This computer has no sandbox yet.");
    const sandbox = await Sandbox.connect(sandboxId, connection);

    /*
     * The clock, pushed here rather than by `heartbeat`, because `ensure` has just made the `getInfo`
     * that does it. Calling it again would be a second round trip per open to ask a question whose
     * answer this line has already produced.
     */
    await pushClockForward(scope);

    /*
     * THE VNC STACK IS STARTED HERE RATHER THAN THROUGH `sandbox.stream`.
     *
     * `@e2b/desktop` has a tidy `stream.start({ requireAuth: true })`, and it is unusable across more
     * than one connection: it generates the RFB password inside `start()` and keeps it on the
     * `VNCServer` object it was called on, while every `Sandbox.connect()` builds a fresh one. The
     * first open therefore worked and the second asked a new object for a password it had never been
     * given and threw "Unable to retrieve stream auth key". Because the symptom arrived only after a
     * successful open, it read as the product being unreliable rather than as a missing field — and
     * from the browser it was indistinguishable from "the screen is not available".
     *
     * So the two commands are issued directly, with the password from {@link vncPasswordFor}, which
     * belongs to the desktop rather than to a connection. They are the SDK's own commands, unchanged:
     * store the password in the file x11vnc reads, run x11vnc against it, and put websockify in front of
     * that. Reproduced deliberately — a hand-rolled stack would be worse than the SDK's, and the reason
     * for not using it is one field on one object, not the protocol.
     *
     * Idempotent, which matters because this runs on every open: `pgrep` first, so a second tab and a
     * re-open reconnect to the running server instead of killing each other. Rotating the password on
     * every open would have been simpler and would have disconnected anybody already watching.
     */
    const authKey = vncPasswordFor(scope.userId);
    /*
     * The `pgrep` is skipped when this process already started the stack for this sandbox, because it
     * is a whole round trip to a remote machine on the path of "take control" and it is answering a
     * question with a known answer.
     *
     * `vncStarted` is remembered per sandbox and cleared on resume — the only state in which the
     * answer could have changed. A pause takes a MEMORY snapshot, so the processes come back with it;
     * a machine restored from disk alone might not have them, and handing out a URL for a proxy that
     * is not there is the one failure worth spending a round trip to avoid.
     *
     * If x11vnc does die while a person is watching, they see noVNC's own disconnect panel rather than
     * a blank frame — which is a recoverable, visible event, and a cheaper thing to detect than to
     * pre-empt.
     */
    const alreadyRunning = vncStarted.has(sandboxId)
      ? true
      : await sandbox.commands
          .run(`pgrep -x x11vnc && pgrep -f novnc_proxy`, { timeoutMs: 15_000 })
          .then((r) => {
            if (r.exitCode === 0) vncStarted.add(sandboxId);
            return r.exitCode === 0;
          })
          .catch(() => false);

    if (!alreadyRunning) {
      /*
       * Started detached and idempotently, because a half-started noVNC is worse than none: the browser
       * would connect to a proxy with nothing behind it and report an authentication failure for what is
       * actually a missing desktop. `waitForPort` is therefore part of starting, not an afterthought —
       * the URL is only returned once the port is genuinely accepting.
       */
      await sandbox.commands.run(
        `mkdir -p ~/.vnc && x11vnc -storepasswd ${authKey} ~/.vnc/passwd`,
        { timeoutMs: 30_000 },
      );
      await sandbox.commands.run(
        `x11vnc -bg -display ${sandbox.display} -forever -wait 50 -shared -rfbport ${VNC_PORT} -usepw`,
        { timeoutMs: 30_000 },
      );
      /*
       * Backgrounded THROUGH THE FLAG, because backgrounding it in the shell does not work.
       *
       * `novnc_proxy` is a server: it never exits. `commands.run` waits for the process it started,
       * so a foreground call blocks for the full timeout and fails — and the failure is not "the screen
       * would not open", it is "the request that opens the screen timed out", which reads as the whole
       * feature being broken. `nohup … &` does not save it either: envd tracks the process it spawned
       * rather than the shell that spawned it, so the call still blocks. Verified both ways against the
       * live account before settling on the flag.
       *
       * `x11vnc -bg` backgrounds itself, which is why only this one needs it.
       */
      await sandbox.commands.run(
        `cd /opt/noVNC/utils && ./novnc_proxy --vnc localhost:${VNC_PORT} ` +
          `--listen ${NOVNC_PORT} --web /opt/noVNC >/tmp/novnc.log 2>&1`,
        { background: true, timeoutMs: 0 },
      );
      /*
       * Waited for rather than assumed. Without this the browser is handed a URL for a proxy that may
       * not be listening yet, connects, and is told the password is wrong — which is a genuinely
       * misleading error, because the password is fine and the server simply had not started.
       *
       * `ss` is preferred and `netstat` accepted, because neither is guaranteed to be in the image and
       * a wait that can never succeed is worse than no wait.
       *
       * The last two arguments are SECONDS, not milliseconds. `waitAndVerify` is
       * `(cmd, onResult, timeout = 10, interval = .5)` and it spends them as
       * `setTimeout(interval * 1e3)` and `elapsed += interval` — the SDK's own call sites pass `60`
       * for a minute. Passing `20_000` and `500` therefore asked for a twenty-thousand-second budget
       * with an eight-minute sleep between checks, so the one case this wait exists to catch (noVNC
       * not listening yet) stalled the tool call for 8m20s before the second attempt instead of
       * retrying twice over 20 seconds. Spelled as seconds here so the unit is visible at the call.
       */
      vncStarted.add(sandboxId);
      await sandbox
        .waitAndVerify(
          `(ss -tuln 2>/dev/null || netstat -tuln 2>/dev/null) | grep -q ":${NOVNC_PORT} "`,
          (r) => r.exitCode === 0 || r.stdout.trim() !== "",
          20,
          0.5,
        )
        .catch((error: unknown) => {
          // Surfaced, not swallowed: a screen that will never open should say so rather than hand out
          // a URL that refuses.
          throw new Error(
            `The desktop's screen did not start listening on port ${NOVNC_PORT}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }

    /*
     * `viewOnly` is deliberately NOT set: a person who has taken the wheel types and clicks on this
     * same desktop the Bot is driving, and a read-only stream would make the feature it exists for
     * impossible. Whether the Bot or the human may act is decided by `controlHolder` on the row, which
     * is what stops the two of them fighting over one mouse.
     */
    const url =
      `https://${sandbox.getHost(NOVNC_PORT)}/vnc.html` +
      `?autoconnect=true&resize=scale`;

    /*
     * The geometry, off the handle we are already holding.
     *
     * A click's coordinates are interpreted against this, and it used to cost a fresh connection
     * because the caller could not pass one in. Read here, best-effort: a desktop that will not say
     * how big it is is still a desktop, and failing the whole open over it would be worse than falling
     * back to the resolution it was created with.
     */
    let width = row.displayWidth ?? DESKTOP_RESOLUTION.width;
    let height = row.displayHeight ?? DESKTOP_RESOLUTION.height;
    const measured = await sandbox
      .getScreenSize()
      .then((size) => ({ width: size.width, height: size.height }))
      .catch(() => null);
    if (measured?.width && measured?.height) {
      width = measured.width;
      height = measured.height;
      await store
        .patch(scope.key, { displayWidth: width, displayHeight: height })
        .catch(() => undefined);
    }

    await touch(scope);
    return { url, authKey, width, height };
  }

  /**
   * Write `lastSeenAt`, at most once per `touchIntervalMs`.
   *
   * Split out of {@link touch} because the screen open needs the write but not the round trip that
   * `ensure` already spent on the platform.
   */
  async function pushClockForward(scope: ProvisionScope): Promise<void> {
    const now = Date.now();
    if (now - (lastTouchedAt.get(scope.key) ?? 0) < touchIntervalMs) return;
    lastTouchedAt.set(scope.key, now);
    await store
      .patch(scope.key, { lastSeenAt: new Date() })
      .catch(() => undefined);
  }

  return {
    ensure,
    ensureDesktop,
    start,
    stop,
    stopIdle,
    /**
     * Remove the machine for good, rather than pausing it.
     *
     * The ONLY path that kills a sandbox, and it exists because a person asked for their computer to be
     * removed. Everything else in this file pauses: a pause keeps the desktop, its windows and its
     * disk, costs nothing while paused, and comes back in seconds. So the distinction is enforced here
     * rather than left to whichever caller reaches for the destructive one — "stop" and "reset" are
     * different verbs because they are different promises, and `stopIdle` must never reach this.
     */
    async destroy(scope: ProvisionScope): Promise<boolean> {
      const row = await store.get(scope.key);
      if (!row?.sandboxId) return false;
      desktopMemo.delete(scope.key);
      vncStarted.delete(row.sandboxId);
      lastTouchedAt.delete(scope.key);
      // The session is closed FIRST, so a kill that fails does not leave a person billed for a
      // machine that no longer exists — the opposite order is what made the meter drift.
      await Promise.resolve(hooks.onSessionEnd?.(scope, "person")).catch(
        () => undefined,
      );
      await Sandbox.connect(row.sandboxId, connection)
        .then((sandbox) => sandbox.kill())
        .catch((error: unknown) => {
          // Reported and then carried on from. A sandbox E2B has already deleted answers not-found,
          // which is the desired end state, so a failure here is not a reason to keep the row and tell
          // a person their computer is still there when it is not.
          console.warn(
            JSON.stringify({
              type: "desktop-kill-failed",
              sandboxId: row.sandboxId,
              reason: error instanceof Error ? error.message : String(error),
            }),
          );
        });
      return true;
    },
    recordGeometry,
    /** Resolve one person's running desktop as the live screen and the tools need it. */
    sandboxFor: (scope: ProvisionScope) =>
      ensure(scope).then((row) =>
        row.sandboxId
          ? Sandbox.connect(row.sandboxId, connection)
          : Promise.reject(new Error("This computer has no sandbox yet.")),
      ),
    /** Ask one person's desktop for its noVNC URL, starting the VNC server if it is not up. */
    streamUrlFor: (scope: ProvisionScope) => ensureStream(scope),
  };
}

/**
 * The one desktop a person has, which Remii drives.
 *
 * Named for the person and not for the Bot because that is what the row, the stream, the wheel and the
 * live screen all already address, and because it is what makes a flat monthly price honest: a computer
 * is billed by the hour it is switched on, so a computer per Bot would make the price of the product
 * depend on how many coworkers somebody happened to create.
 *
 * Remii is the only Bot offered these tools (`botHoldsTheComputer`); everyone else works through
 * connected apps and asks Remii with `message_bot` when a job needs a screen.
 */
export function createComputerProvisioner(
  store: UserComputerStore,
  options: ProvisionerOptions,
) {
  return createScopedProvisioner<UserComputer>(
    {
      get: (key) => store.get(key),
      patch: (key, patch) => store.patch(key, patch as never),
      create: ({ id, userId, provider, imageVersion }) =>
        store.create({
          id,
          userId,
          provider,
          imageVersion: imageVersion ?? null,
        }),
    },
    options,
    // One row per person, so a person is over the cap exactly when this row is not the one running.
    async (userId) => {
      const row = await store.get(userId);
      return row
        ? [{ key: userId, sandboxId: row.sandboxId, status: row.status }]
        : [];
    },
    /*
     * Forwarded, and this was silently missing.
     *
     * `createScopedProvisioner` takes hooks as a fourth argument and `stop`, `stopIdle` and
     * `ensureDesktop` all call them — but this factory passed three arguments, so the hooks were
     * always `{}` and `onSessionEnd` was never a function. The result was a session that opened on
     * the first tool call and was only ever closed by the quota ceiling: a machine stopped by the
     * idle sweep, switched off by a person, or reclaimed as a quota error all left the billing row
     * open.
     *
     * That is worse than a row that never closed, because the meter refuses to open a second
     * session while one is open. One leak and that person is never billed again for as long as the
     * deployment lives, while Daytona's own billing carries on regardless — so the meter drifts
     * silently further from the bill with every session. Now they come from `options`, where the
     * meter was already being handed to the tools.
     */
    {
      onSessionStart: options.onSessionStart,
      onSessionEnd: options.onSessionEnd,
    },
  );
}
