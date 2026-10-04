import { describe, expect, mock, test } from "bun:test";

/**
 * One person, one desktop — proved by counting the machines rather than reading the row.
 *
 * The provisioner inserted a row before it created anything, so a second caller could not tell "this
 * user has no sandbox" from "this user's sandbox is on its way". Both would read a row with a null
 * `sandboxId`, both would pass the concurrency cap (which counts rows that HAVE a sandbox), both
 * would list sandboxes, find nothing, and both would call `Sandbox.create`. One row, two machines,
 * one orphaned and billing.
 *
 * Nothing caught it, because the row was correct afterwards. `singleFlight` on the provision path is
 * what closes the window, and this asserts the property that matters: the number of `Sandbox.create`
 * calls, which is the number of machines.
 */

let created: string[] = [];
/**
 * When set, `Sandbox.create` waits on this before returning. The test releases it, which is what
 * makes the race reachable deterministically: without a hold, both callers run their `list` and then
 * create back to back, and a test counting calls would be at the mercy of scheduling.
 */
let createHeld: Promise<void> | null = null;
/** Makes the next `Sandbox.create` reject, so the lock's release-on-failure can be observed. */
let createShouldFail = false;

type FakeSandbox = {
  sandboxId: string;
  display: string;
  isRunning(): Promise<boolean>;
  getScreenSize(): Promise<{ width: number; height: number }>;
  getHost(port: number): string;
  commands: {
    run(
      command: string,
      opts?: { timeoutMs?: number },
    ): Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  };
  files: { write(p: string, c: string): Promise<void> };
};

let counter = 0;
const nextSandboxId = (): string => {
  counter += 1;
  return `created-${counter}`;
};

const fakeSandbox = (): FakeSandbox => ({
  sandboxId: nextSandboxId(),
  display: ":0",
  async isRunning() {
    return true;
  },
  async getScreenSize() {
    return { width: 1920, height: 1080 };
  },
  getHost(port: number) {
    return `${port}.s1.e2b.app`;
  },
  commands: {
    async run() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  },
  files: { async write() {} },
});

const realSdk = await import("../src/computer/e2b-sdk");
mock.module("../src/computer/e2b-sdk", () => ({
  ...realSdk,
  Sandbox: {
    create: async () => {
      created.push("create");
      if (createShouldFail) throw new Error("E2B refused to create a sandbox.");
      const instance = fakeSandbox();
      if (createHeld) await createHeld;
      return instance as never;
    },
    list: async () => ({ items: [] }),
    connect: async (id: string) =>
      ({ ...fakeSandbox(), sandboxId: id }) as never,
    getInfo: async (id: string) => ({ sandboxId: id, state: "running" }),
  },
  Volume: {
    list: async () => ({ items: [] }),
    create: async () => ({}),
  },
}));

const { createComputerProvisioner } = await import(
  "../src/computer/provisioner"
);
const { resetSingleFlight } = await import("../src/computer/user-computers");

/** A store that starts with NO row, which is the state a brand-new user is in. */
const makeStore = () => {
  let row: Record<string, unknown> | null = null;
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
    listRunning: async () => (row ? [row] : []),
  };
};

const newProvisioner = () =>
  createComputerProvisioner(
    makeStore() as never,
    {
      apiKey: "test",
      apiUrl: "https://example.invalid",
      readyTimeoutMs: 2_000,
      desktopTtlMs: 0,
      touchIntervalMs: 0,
    } as never,
  );

describe("two callers racing on a person who has no desktop yet", () => {
  test("build exactly one machine", async () => {
    resetSingleFlight();
    created = [];
    createShouldFail = false;

    const provisioner = newProvisioner();
    const scope = { key: "racer", userId: "racer" } as never;

    /*
     * Both callers ask at once, and the first create is held open so the second genuinely arrives
     * while the row says `sandboxId: null` and the sandbox list is still empty. That is the exact
     * interleaving that used to produce two desktops.
     */
    let release!: () => void;
    createHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = provisioner.ensureDesktop(scope);
    const second = provisioner.ensureDesktop(scope);
    // Let the second caller reach the lock before the first is let go.
    await Bun.sleep(50);
    release();
    createHeld = null;

    await Promise.all([first, second]);

    // The property, stated as the number of machines rather than as the shape of a row.
    expect(created).toHaveLength(1);
  });

  test("both callers get the same row back", async () => {
    resetSingleFlight();
    created = [];
    createShouldFail = false;
    createHeld = null;

    const provisioner = newProvisioner();
    const scope = { key: "racer", userId: "racer" } as never;

    const [a, b] = await Promise.all([
      provisioner.ensureDesktop(scope),
      provisioner.ensureDesktop(scope),
    ]);

    // Not merely "one sandbox id appears twice" — the same provision, observed twice. Two answers
    // that agree because they came from one run is the property; two that agree because both read a
    // shared row after two runs would still be two machines.
    expect(a.sandboxId).toBe(b.sandboxId);
    expect(created).toHaveLength(1);
  });

  test("a failed attempt does not wedge the next one", async () => {
    resetSingleFlight();
    created = [];
    createHeld = null;
    createShouldFail = true;

    const provisioner = newProvisioner();
    const scope = { key: "recover", userId: "recover" } as never;

    /*
     * `singleFlight` removes its entry in a `finally`, so a rejection is inherited by the callers that
     * were waiting at the time and by nobody after them. A lock that leaked its entry on failure would
     * turn one transient E2B error into a permanently broken person — which is a worse failure than
     * the duplicate sandbox this was added to prevent.
     */
    await expect(provisioner.ensureDesktop(scope)).rejects.toThrow();

    createShouldFail = false;
    const recovered = await provisioner.ensureDesktop(scope);
    expect(recovered.sandboxId).toBeTruthy();
    expect(created).toHaveLength(2);
  });
});
