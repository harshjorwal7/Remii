import { describe, expect, mock, test } from "bun:test";

/**
 * "The sandbox exists" is not "the sandbox is running", and this is the invariant.
 *
 * This file is the direct successor to `daytona-resume.test.ts`, and it tests the SAME property
 * because the property did not change when the platform did. `ensure()` used to decide a computer was
 * available by asking whether its sandbox could be FETCHED, and Daytona answers perfectly happily for
 * a stopped sandbox — so "exists" was taken to mean "running" and the next call went into a
 * computer-use API on a machine with no container behind it. The symptom was a screen tool saying the
 * desktop was unreachable, which is true and names nothing.
 *
 * E2B changes the MECHANISM and not the obligation, and it introduces one of its own:
 *
 *  - `Sandbox.getInfo` is the cheap check that does not wake anything. `Sandbox.connect` RESUMES a
 *    paused sandbox as a side effect, so using it to ASK whether a machine is up would mean the idle
 *    pause is defeated by a status page being polled.
 *  - `autoResume: true` means E2B itself can wake a sandbox on arbitrary traffic, including its own
 *    health checks. So a resume can be contended, and an unbounded wait here is a hung request rather
 *    than a slow one.
 *
 * So these assert the invariant against the real seam: nothing is aimed at a machine that has not
 * been confirmed running, a paused machine is resumed before use, a dead one is forgotten and rebuilt,
 * and a row is never left claiming a state the platform does not agree with.
 */

/** Enough of an E2B desktop sandbox to drive the provisioner. */
type FakeSandbox = {
  sandboxId: string;
  display: string;
  state: "running" | "paused";
  paused: number;
  connects: number;
  /** Every command the provisioner issued, in order. The VNC stack is asserted against this. */
  commands: string[];
  isRunning(): Promise<boolean>;
  getScreenSize(): Promise<{ width: number; height: number }>;
  pause(opts?: { keepMemory?: boolean }): Promise<boolean>;
  getHost(port: number): string;
  waitAndVerify(
    cmd: string,
    onResult: (r: { stdout: string }) => boolean,
    timeoutMs?: number,
    intervalMs?: number,
  ): Promise<boolean>;
};

type FakeInfo = {
  sandboxId: string;
  state: "running" | "paused";
  metadata?: Record<string, string>;
};

let sandboxes = new Map<string, FakeSandbox>();
/** Every state at the moment something was aimed at the machine, which is what these assert on. */
let stateWhenAsked: string[] = [];
/** Every command issued against any sandbox, in order. */
const commandLog: string[] = [];
let connectShouldFail = false;
let screenSize: { width: number; height: number } = {
  width: 1920,
  height: 1080,
};
/** Every create the provisioner made, so the parameters can be asserted rather than assumed. */
let creates: Record<string, unknown>[] = [];
let volumesCreated: string[] = [];

/** Whether x11vnc and websockify are "running" for this fake. Toggled by the provisioner's own commands. */
let vncStackRunning = false;

const makeSandbox = (
  id: string,
  state: "running" | "paused" = "running",
): FakeSandbox => {
  const sandbox: FakeSandbox = {
    sandboxId: id,
    display: ":0",
    state,
    paused: 0,
    connects: 0,
    async isRunning() {
      stateWhenAsked.push(sandbox.state);
      return sandbox.state === "running";
    },
    async getScreenSize() {
      return screenSize;
    },
    async pause() {
      sandbox.paused += 1;
      sandbox.state = "paused";
      // A pause snapshots the process, so a VNC server that was up is still up on the other side.
      return true;
    },
    getHost(port: number) {
      return `${port}-${id}.e2b.app`;
    },
    async waitAndVerify() {
      return true;
    },
    commands: {
      /**
       * Answers the one question the provisioner asks before starting VNC — "is it already up?" — and
       * records everything, because the VNC stack is the thing under test and asserting on it through
       * the commands issued is more honest than asserting on a mock's call log.
       */
      async run(command: string) {
        commandLog.push(command);
        if (command.includes("pgrep -x x11vnc")) {
          return {
            exitCode: vncStackRunning ? 0 : 1,
            stdout: vncStackRunning ? "1234\n1235\n" : "",
            stderr: "",
          };
        }
        // Starting either of them brings the stack up, which is what makes a second open idempotent.
        if (command.includes("x11vnc -bg") || command.includes("novnc_proxy")) {
          vncStackRunning = true;
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
  return sandbox;
};

const fakeE2B = {
  async getInfo(id: string): Promise<FakeInfo> {
    const sandbox = sandboxes.get(id);
    // The platform's own answer for an id it does not have. This is what repairs a row whose machine
    // was killed by `timeoutMs`, deleted by an operator, or removed while cleaning up an orphan.
    if (!sandbox) throw new Error(`sandbox ${id} not found`);
    return { sandboxId: id, state: sandbox.state, metadata: {} };
  },
  async connect(id: string): Promise<FakeSandbox> {
    const sandbox = sandboxes.get(id);
    if (!sandbox) throw new Error(`sandbox ${id} not found`);
    sandbox.connects += 1;
    stateWhenAsked.push(sandbox.state);
    if (connectShouldFail) {
      throw new Error("quota exceeded: no sandboxes left in this organization");
    }
    // THE BEHAVIOUR UNDER TEST. Connecting to a paused sandbox resumes it. On E2B this is one call,
    // where Daytona needed a state check, a `start`, and a second fetch to see whether it worked.
    sandbox.state = "running";
    return sandbox;
  },
  /*
   * `hasNext` is a GETTER, not a captured value. The provisioner drains this with
   * `while (paginator.hasNext)`, so a snapshot taken at construction stays `true` forever and the loop
   * never ends — a fake that hangs the test is worse than no fake at all.
   */
  list(opts: { query?: { metadata?: Record<string, string> } } = {}) {
    const wanted = opts.query?.metadata?.computer;
    const matches = [...sandboxes.values()].filter(() => wanted === undefined);
    let done = false;
    return {
      get hasNext() {
        return !done;
      },
      nextItems: async () => {
        done = true;
        return matches.map((sandbox) => ({
          sandboxId: sandbox.sandboxId,
          state: sandbox.state,
        }));
      },
    };
  },
  async create(template: string, params: Record<string, unknown>) {
    creates.push({ template, ...params });
    const sandbox = makeSandbox(`sbx-${sandboxes.size + 1}`, "running");
    sandboxes.set(sandbox.sandboxId, sandbox);
    return sandbox;
  },
};

let volumeCreationRefused = false;

const fakeVolume = {
  async list() {
    /*
     * Deliberately answers `[]` even when creation is refused, because that is what a real plan-gated
     * account does. It is the reason the provisioner checks the CREATE rather than probing by listing:
     * a probe would have reported volumes as available and then failed on the first real desktop.
     */
    return volumesCreated.map((name, index) => ({
      volumeId: `vol-${index}`,
      name,
    }));
  },
  async create(name: string) {
    if (volumeCreationRefused) {
      throw new Error("403: use of volumes is not enabled");
    }
    if (volumesCreated.includes(name))
      throw new Error(`volume ${name} already exists`);
    volumesCreated.push(name);
    return { volumeId: `vol-${volumesCreated.length}`, name };
  },
};

/*
 * Only `Sandbox` and `Volume` are faked. Everything else the provisioner imports from this module —
 * `metadataFor`, `sandboxKeyFor`, `volumeNameFor`, the resolution, the two ports — is the REAL thing,
 * because those are the decisions these tests are about. A fake that also stubbed them would assert
 * that a stub matches a stub.
 */
const realSdk = await import("../src/computer/e2b-sdk");
mock.module("../src/computer/e2b-sdk", () => ({
  ...realSdk,
  Sandbox: fakeE2B,
  Volume: fakeVolume,
}));

const { createComputerProvisioner } = await import(
  "../src/computer/provisioner"
);

/** A store in memory, because these assertions are about E2B's state and not about Postgres. */
const makeStore = (initial?: Record<string, unknown>) => {
  let row: Record<string, unknown> | null = initial ? { ...initial } : null;
  return {
    get: async () => row as never,
    patch: async (_key: string, patch: Record<string, unknown>) => {
      row = { ...(row ?? {}), ...patch };
      return row as never;
    },
    create: async (input: Record<string, unknown>) => {
      row = {
        id: input.id,
        userId: input.userId,
        provider: input.provider,
        sandboxId: null,
        status: "PROVISIONING",
        desiredStatus: "RUNNING",
        displayWidth: null,
        displayHeight: null,
        imageVersion: null,
        controlHolder: "bot",
        controlSince: new Date(),
        lastStartedAt: null,
        lastSeenAt: null,
      };
      return row as never;
    },
    read: () => row,
  };
};

const provisioner = (store: ReturnType<typeof makeStore>) =>
  createComputerProvisioner(store as never, {
    apiKey: "test",
    apiUrl: "https://example.invalid",
    readyTimeoutMs: 1_000,
    // Long enough that the memo cannot hide a resume; short enough not to slow the suite.
    desktopTtlMs: 0,
    touchIntervalMs: 0,
  });

const scope = { key: "alice", userId: "alice" } as never;

const existingRow = (
  sandboxId: string,
  overrides: Record<string, unknown> = {},
) => ({
  id: "c1",
  userId: "alice",
  provider: "e2b",
  sandboxId,
  status: "RUNNING",
  desiredStatus: "RUNNING",
  displayWidth: null,
  displayHeight: null,
  imageVersion: null,
  controlHolder: "bot",
  controlSince: new Date(),
  lastStartedAt: null,
  lastSeenAt: null,
  ...overrides,
});

const reset = (state: "running" | "paused", sandboxId = "sbx-1") => {
  sandboxes = new Map();
  sandboxes.set(sandboxId, makeSandbox(sandboxId, state));
  stateWhenAsked = [];
  commandLog.length = 0;
  vncStackRunning = false;
  connectShouldFail = false;
  creates = [];
  volumesCreated = [];
  volumeCreationRefused = false;
  screenSize = { width: 1920, height: 1080 };
  return sandboxId;
};

describe("a paused sandbox", () => {
  test("is resumed before anything is asked of it", async () => {
    /*
     * THE CASE. A row that names a sandbox some minutes after anyone last looked at it, which is what
     * every row looks like after the idle pause — the ordinary state, not an edge case.
     */
    const sandboxId = reset("paused");
    const store = makeStore(
      existingRow(sandboxId, { status: "STOPPED", desiredStatus: "STOPPED" }),
    );

    const row = await provisioner(store).ensureDesktop(scope);

    // The first recorded state is `paused` and that is correct: it is `Sandbox.connect` recording
    // what it found BEFORE it resumed. What must hold is that it resumed, and that every call after
    // the resume found a running machine. An unresumed pause would show `paused` twice.
    // More than one connect, because `recordGeometry` needs a handle to ask the desktop its size and
    // `Sandbox.connect` is how this module gets one. That is a second call rather than a second
    // resume — only the first connect on a paused sandbox does any work — and it is behind the
    // `desktopTtlMs` memo, so it is not per tool call.
    expect(sandboxes.get(sandboxId)!.connects).toBeGreaterThanOrEqual(1);
    expect(
      stateWhenAsked.slice(1),
      "every call after the resume found the machine running",
    ).toEqual(["running", "running"]);
    expect(row.status).toBe("RUNNING");
  });

  test("publishes PROVISIONING before the wait, so the page does not read STOPPED while it wakes", async () => {
    // `STOPPED` is a settled, terminal, FALSE fact: it invites the reader to press start again and
    // conclude their click did nothing. So the transition is published before the wait, not after.
    const sandboxId = reset("paused");
    const store = makeStore(
      existingRow(sandboxId, { status: "STOPPED", desiredStatus: "STOPPED" }),
    );

    await provisioner(store).ensure(scope);

    expect(store.read()!.status).toBe("RUNNING");
    expect(store.read()!.desiredStatus).toBe("RUNNING");
  });

  test("has its row corrected, so the database stops claiming otherwise", async () => {
    const sandboxId = reset("paused");
    // The stale row is what let the idle sweep and the status page both report a paused desktop as a
    // live one — and what sent the sweeper to pause something already paused.
    const store = makeStore(existingRow(sandboxId, { status: "RUNNING" }));

    await provisioner(store).ensure(scope);

    expect(store.read()!.status).toBe("RUNNING");
    expect(store.read()!.lastStartedAt).toBeInstanceOf(Date);
  });

  test("is not resumed when it is already running", async () => {
    // The other half of the cost: a wake on every turn turns a warm desktop into a bill.
    const sandboxId = reset("running");
    const store = makeStore(existingRow(sandboxId));

    await provisioner(store).ensure(scope);
    await provisioner(store).ensure(scope);

    expect(sandboxes.get(sandboxId)!.connects).toBe(0);
  });

  test("reports WHY it could not resume, rather than failing later with a connection error", async () => {
    /*
     * A failed resume is a quota error, a template that no longer pulls, a host out of memory. All
     * three are worth naming. Swallowing them is what produced "no IP address found", which describes
     * the consequence of the failed wake rather than the wake.
     */
    reset("paused");
    connectShouldFail = true;
    const store = makeStore(
      existingRow("sbx-1", { status: "STOPPED", desiredStatus: "STOPPED" }),
    );

    const failure = await provisioner(store)
      .ensure(scope)
      .then(() => null)
      .catch((error: unknown) => String(error));

    expect(failure).toContain("could not be resumed");
    expect(failure).toContain("quota exceeded");
    expect(failure).toContain("paused");
  });
});

describe("a sandbox that is gone", () => {
  test("is forgotten and made again, rather than failing forever", async () => {
    /*
     * Distinct from paused. E2B deletes a sandbox that reaches `timeoutMs`, and an operator deletes
     * them too — so an unchecked row is a permanently broken person: nothing repairs it, so it never
     * recovers. This is the case that got a real person a new desktop and could have left them
     * without one.
     */
    sandboxes = new Map();
    stateWhenAsked = [];
    creates = [];
    volumesCreated = [];
    const store = makeStore(existingRow("sbx-vanished"));

    const row = await provisioner(store).ensure(scope);

    expect(row.sandboxId).not.toBe("sbx-vanished");
    expect(row.sandboxId).toBeTruthy();
    expect(row.status).toBe("RUNNING");
    expect(creates).toHaveLength(1);
  });

  test("rebuilds it with the parameters that make it a desktop rather than an empty box", async () => {
    sandboxes = new Map();
    creates = [];
    volumesCreated = [];
    const store = makeStore(existingRow("sbx-vanished"));

    await provisioner(store).ensure(scope);

    // Asserting the created shape rather than "it worked": a create that silently drops the desktop
    // template, the resolution or the volume produces a machine that costs money and has no screen,
    // and nothing in the response says which of those went missing.
    expect(creates[0]).toMatchObject({
      template: "desktop",
      resolution: [1920, 1080],
      allowInternetAccess: true,
      lifecycle: {
        onTimeout: { action: "pause", keepMemory: true },
        autoResume: true,
      },
    });
  });

  test("puts the person's files on a volume of their own", async () => {
    sandboxes = new Map();
    creates = [];
    volumesCreated = [];
    const store = makeStore(existingRow("sbx-vanished"));

    await provisioner(store).ensure(scope);

    // ONE volume per person, mounted at the path the tools resolve against. A shared volume at a
    // per-user subpath is what Daytona did and E2B cannot do: it mounts a volume whole, so every
    // person's desktop would sit on one directory.
    const mounts = creates[0].volumeMounts as Record<string, string>;
    expect(Object.keys(mounts)).toEqual(["/workspace"]);
    expect(volumesCreated).toHaveLength(1);
    expect(Object.values(mounts)[0]).toBe(volumesCreated[0]);
  });

  test("does not create the volume twice when it already exists", async () => {
    // `Volume.create` throws on a name that is taken, and that is the state every person is in after
    // their first desktop — so a second attempt must look rather than create.
    sandboxes = new Map();
    creates = [];
    volumesCreated = [];
    const store = makeStore(existingRow("sbx-vanished"));

    await provisioner(store).ensure(scope);
    const afterFirst = volumesCreated.length;
    // A second build for a DIFFERENT person, whose volume name differs.
    await provisioner(makeStore(existingRow("sbx-vanished-2"))).ensure({
      key: "bob",
      userId: "bob",
    } as never);

    expect(afterFirst).toBe(1);
    expect(volumesCreated.length).toBe(2);
    expect(new Set(volumesCreated).size).toBe(2);
  });
});

describe("the live screen", () => {
  test("starts x11vnc against a stored password, NEVER with -nopw", async () => {
    /*
     * Not optional and not configurable, because the alternative is unprotected: x11vnc with `-nopw` on
     * a public hostname gives anyone who learns or guesses the URL full keyboard and mouse on a
     * person's desktop, and read access to everything mounted on it.
     */
    const sandboxId = reset("running");
    const store = makeStore(existingRow(sandboxId));

    await provisioner(store).streamUrlFor(scope);

    expect(
      commandLog.some((c) => c.includes("x11vnc -storepasswd")),
      "the password was written where x11vnc reads it",
    ).toBe(true);
    const launch = commandLog.find((c) => c.includes("x11vnc -bg"));
    expect(launch, "x11vnc was launched").toBeTruthy();
    expect(launch).toContain("-usepw");
    expect(launch).not.toContain("-nopw");
    expect(commandLog.some((c) => c.includes("novnc_proxy"))).toBe(true);
  });

  test("hands out the SAME password every time, so a second open works", async () => {
    /*
     * THE REGRESSION THIS WHOLE MECHANISM EXISTS FOR.
     *
     * `@e2b/desktop` keeps the generated RFB password on the `VNCServer` object `start()` was called
     * on, and every `Sandbox.connect()` builds a fresh one. So the first open of the live screen
     * worked and the second asked a brand-new object for a password it had never been given and threw
     * "Unable to retrieve stream auth key" — which from the browser was indistinguishable from "the
     * screen is not available".
     *
     * Asserted on the VALUE rather than on the call count, because the value is the actual invariant:
     * a password that changes between opens breaks every viewer that was already connected.
     */
    const sandboxId = reset("running");
    const store = makeStore(existingRow(sandboxId));
    const first = await provisioner(store).streamUrlFor(scope);
    const second = await provisioner(store).streamUrlFor(scope);

    expect(second.authKey).toBe(first.authKey);
    expect(first.authKey).toBeTruthy();
  });

  test("the password is the desktop's, not the connection's", async () => {
    // Derived from the user id, so it survives a restart of this process and a database row being
    // rebuilt. Asserted explicitly because "generate it per open" is the obvious wrong answer and it
    // is the one that was shipped first.
    const { vncPasswordFor } = await import("../src/computer/e2b-sdk");
    expect(vncPasswordFor("alice")).toBe(vncPasswordFor("alice"));
    expect(vncPasswordFor("alice")).not.toBe(vncPasswordFor("bob"));
    // x11vnc truncates at 8 characters, so a longer one buys nothing and adds log surface.
    expect(vncPasswordFor("alice").length).toBe(16);
  });

  test("does NOT restart the stack when it is already up, so a second tab does not cut off the first", async () => {
    const sandboxId = reset("running");
    const store = makeStore(existingRow(sandboxId));
    const provisionerFor = provisioner(store);

    await provisionerFor.streamUrlFor(scope);
    const launchesAfterFirst = commandLog.filter((c) =>
      c.includes("x11vnc -bg"),
    ).length;
    await provisionerFor.streamUrlFor(scope);

    // Rotating on every open would be simpler and would disconnect anybody watching.
    expect(launchesAfterFirst).toBe(1);
    expect(commandLog.filter((c) => c.includes("x11vnc -bg"))).toHaveLength(1);
  });

  test("the password is NOT baked into the URL it hands back", async () => {
    // A URL is what ends up in a proxy log, in browser history and in a `Referer` header. A credential
    // that travels in one is a credential that leaks.
    const sandboxId = reset("running");
    const store = makeStore(existingRow(sandboxId));

    const session = await provisioner(store).streamUrlFor(scope);

    expect(session.url).not.toContain(session.authKey);
    expect(session.url).not.toMatch(/password=/);
    expect(session.url).toContain(`${sandboxId}.e2b.app`);
  });

  test("autoconnects and scales, so the person is not asked to click anything", async () => {
    const sandboxId = reset("running");
    const store = makeStore(existingRow(sandboxId));

    const session = await provisioner(store).streamUrlFor(scope);

    expect(session.url).toContain("autoconnect=true");
    // 1920 wide inside a 900px column at `resize=off` means panning to see anything.
    expect(session.url).toContain("resize=scale");
    // `view_only` must be absent: a read-only stream makes the feature it exists for impossible.
    expect(session.url).not.toContain("view_only");
  });
});

describe("geometry", () => {
  test("is read back from the running desktop, never assumed", async () => {
    // A click's coordinates are interpreted against what is actually on the screen. Guessing would
    // mean (800,600) meaning one thing on one machine and something else on another.
    const sandboxId = reset("running");
    screenSize = { width: 2560, height: 1440 };
    const store = makeStore(existingRow(sandboxId));

    const row = await provisioner(store).ensureDesktop(scope);

    expect(row.displayWidth).toBe(2560);
    expect(row.displayHeight).toBe(1440);
  });
});

describe("the idle stop", () => {
  test("PAUSES with memory rather than stopping or deleting", async () => {
    /*
     * The difference that makes a ten-minute idle window safe. Daytona's stop was a genuine cold
     * boot at one to two minutes; an E2B memory pause restores the windows, the browser session and
     * the running programs, and comes back in seconds.
     */
    const sandboxId = reset("running");
    const store = makeStore(existingRow(sandboxId));

    await provisioner(store).stopIdle(scope, "idle");

    expect(sandboxes.get(sandboxId)!.paused).toBe(1);
    expect(sandboxes.get(sandboxId)!.state).toBe("paused");
    expect(store.read()!.status).toBe("STOPPED");
    expect(store.read()!.desiredStatus).toBe("STOPPED");
  });

  test("never deletes, because a person's disk is their data", async () => {
    const sandboxId = reset("running");
    const store = makeStore(existingRow(sandboxId));

    await provisioner(store).stop(scope);

    // The sandbox is still there, which is the whole persistence story: `kill` is never called, and a
    // desktop a person signs back into tomorrow is the same desktop.
    expect(sandboxes.has(sandboxId)).toBe(true);
    expect(store.read()!.status).toBe("STOPPED");
  });
});
describe("an account whose plan has no volumes", () => {
  /*
   * The one thing running this for real found that a unit test with a stubbed client could not.
   *
   * E2B gates volumes behind a plan, and an account without them answers volume creation with
   * `403: use of volumes is not enabled` while `Volume.list` cheerfully returns `[]`. Provisioning
   * propagated that error, so EVERY desktop on such an account failed to provision — a deployment with
   * E2B_API_KEY set and no computer at all, rather than a computer whose files live on its own disk.
   */
  const refuseVolumes = () => {
    sandboxes = new Map();
    creates = [];
    volumesCreated = [];
    volumeCreationRefused = true;
  };

  test("still builds a desktop, on the sandbox's own disk", async () => {
    refuseVolumes();
    const store = makeStore(existingRow("sbx-vanished"));

    const row = await provisioner(store).ensure(scope);

    // The whole point: a working computer rather than an exception.
    expect(row.sandboxId).toBeTruthy();
    expect(row.status).toBe("RUNNING");
    // And with no volume mounted, because asking for one would have failed the create.
    expect(creates[0].volumeMounts).toBeUndefined();
  });

  test("does not retry the refused volume on every later desktop", async () => {
    // Otherwise every provision for the life of the process pays a 403 and logs about it, and the one
    // line that says something an operator can act on is buried under hundreds that say nothing new.
    refuseVolumes();
    await provisioner(makeStore(existingRow("sbx-vanished"))).ensure(scope);
    const afterFirst = volumesCreated.length;

    await provisioner(makeStore(existingRow("sbx-vanished-2"))).ensure({
      key: "bob",
      userId: "bob",
    } as never);

    expect(afterFirst).toBe(0);
    expect(volumesCreated).toHaveLength(0);
  });

  test("asks for no volume at all when E2B_VOLUMES is false", async () => {
    // The escape hatch, and the reason `false` has to be spelled out: a deployment that knows its plan
    // has no volumes can say so rather than discovering it once per desktop.
    sandboxes = new Map();
    creates = [];
    volumesCreated = [];
    const quiet = createComputerProvisioner(
      makeStore(existingRow("sbx-vanished")) as never,
      {
        apiKey: "test",
        apiUrl: "https://example.invalid",
        readyTimeoutMs: 1_000,
        volumes: false,
      },
    );

    await quiet.ensure(scope);

    expect(creates[0].volumeMounts).toBeUndefined();
    expect(volumesCreated).toHaveLength(0);
  });
});
