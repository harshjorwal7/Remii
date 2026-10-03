import { describe, expect, mock, test } from "bun:test";

/**
 * Two waits that were silently eight minutes long, and a crop that cost more than the screen.
 *
 * Both of these shipped. Both are invisible to every other test in this suite, and that is the point
 * of this file: each was a number passed to somebody else's clock, and no assertion anywhere was
 * looking at that number.
 *
 * `waitAndVerify(cmd, onResult, timeout, interval)` takes SECONDS. It spends them as
 * `setTimeout(interval * 1e3)` and `elapsed += interval`, and E2B's own call sites pass `60` for a
 * minute. The noVNC readiness wait passed `20_000` and `500`, which asked for a twenty-thousand
 * second budget with an eight-minute sleep between checks. It passed every test because the first
 * check succeeds in the normal case, and in the one case the wait exists for — noVNC not listening
 * yet — the tool call stalled for 8m20s before trying again, which reads as a hung agent rather than
 * as a slow one.
 *
 * The crop had the same shape. `captureScreenshot` scales to a width with `scale=W:-1`, which forces
 * BOTH dimensions, so a 400x300 region came back as 1280x960: an upscale, more pixels and more
 * tokens than the uncropped screen the crop existed to avoid sending. The tool description tells the
 * model a crop is cheap, and it was the most expensive way to read the screen.
 */

/** The arguments the provisioner handed to `waitAndVerify`, in order. */
let waitArgs: { cmd: string; timeout?: number; interval?: number }[] = [];

type FakeSandbox = {
  sandboxId: string;
  display: string;
  isRunning(): Promise<boolean>;
  getScreenSize(): Promise<{ width: number; height: number }>;
  getHost(port: number): string;
  pause(opts?: { keepMemory?: boolean }): Promise<boolean>;
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
  /**
   * On the sandbox itself rather than under `commands`, which is where the SDK declares it
   * (`Desktop.waitAndVerify`) and therefore where the provisioner calls it.
   */
  waitAndVerify(
    cmd: string,
    onResult: (r: { stdout: string; exitCode: number }) => boolean,
    timeout?: number,
    interval?: number,
  ): Promise<boolean>;
  files: {
    write(path: string, content: string): Promise<void>;
  };
};

/** Every command string issued against the fake, so the capture can be asserted on directly. */
let commandLog: string[] = [];

/**
 * Whether the VNC stack is up, toggled by the provisioner's own commands.
 *
 * It has to start FALSE. The provisioner asks `pgrep -x x11vnc` before it starts anything, and if
 * that answers "yes" it hands out a URL without ever reaching the wait — so a fake that reports a
 * running stack never exercises the code path this file exists to test.
 */
let vncRunning = false;

const sandbox = (): FakeSandbox => {
  const instance: FakeSandbox = {
    sandboxId: "s1",
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
    async pause() {
      return true;
    },
    commands: {
      async run(command: string) {
        commandLog.push(command);
        if (command.includes("pgrep -x x11vnc"))
          return {
            exitCode: vncRunning ? 0 : 1,
            stdout: vncRunning ? "1\n" : "",
            stderr: "",
          };
        // Starting either process brings the stack up, which is what makes a second open idempotent.
        if (command.includes("x11vnc -bg") || command.includes("novnc_proxy"))
          vncRunning = true;
        if (command.includes("pyatspi"))
          return { exitCode: 0, stdout: "", stderr: "" };
        if (command.includes("scrot"))
          return { exitCode: 0, stdout: "BASE64", stderr: "" };
        if (command.includes("wmctrl"))
          return {
            exitCode: 0,
            stdout: "0x1 0 0 0 100 100 h Chromium",
            stderr: "",
          };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    async waitAndVerify(cmd, _onResult, timeout, interval) {
      waitArgs.push({
        cmd,
        ...(timeout === undefined ? {} : { timeout }),
        ...(interval === undefined ? {} : { interval }),
      });
      return true;
    },
    files: {
      async write() {
        /* the helper script lands; nothing here reads it back */
      },
    },
  };
  return instance;
};

const fakeSdk = {
  Sandbox: {
    create: async () => sandbox(),
    list: async () => ({ items: [] }),
    connect: async () => sandbox(),
    getInfo: async (id: string) => ({ sandboxId: id, state: "running" }),
  },
  Volume: { list: async () => ({ items: [] }), create: async () => ({}) },
};

const realSdk = await import("../src/computer/e2b-sdk");
mock.module("../src/computer/e2b-sdk", () => ({ ...realSdk, ...fakeSdk }));

const { createComputerProvisioner } = await import(
  "../src/computer/provisioner"
);
const { captureScreenshot } = await import("../src/computer/e2b-desktop");

const makeStore = () => {
  let row: Record<string, unknown> | null = {
    id: "u1",
    userId: "u1",
    provider: "e2b",
    sandboxId: "s1",
    status: "RUNNING",
    desiredStatus: "RUNNING",
    displayWidth: 1920,
    displayHeight: 1080,
    imageVersion: null,
    controlHolder: "bot",
    controlSince: new Date(),
    lastStartedAt: new Date(),
    lastSeenAt: new Date(),
  };
  return {
    get: async () => row as never,
    patch: async (_key: string, patch: Record<string, unknown>) => {
      row = { ...(row ?? {}), ...patch };
      return row as never;
    },
    create: async () => row as never,
    listRunning: async () => [row] as never,
  };
};

const scope = { key: "u1", userId: "u1" } as never;

const newProvisioner = () =>
  createComputerProvisioner(
    makeStore() as never,
    {
      apiKey: "test",
      apiUrl: "https://example.invalid",
      readyTimeoutMs: 1_000,
      desktopTtlMs: 0,
      touchIntervalMs: 0,
    } as never,
  );

describe("the wait for the screen to start listening", () => {
  test("asks for seconds, because the SDK spends seconds", async () => {
    waitArgs = [];
    vncRunning = false;
    const provisioner = newProvisioner();
    await provisioner.streamUrlFor(scope);

    expect(waitArgs.length).toBeGreaterThan(0);
    for (const call of waitArgs) {
      /*
       * The assertion that would have caught this. Anything above a few tens is not a count of
       * seconds: the SDK's own default is 10, and a noVNC process that has not bound its port in
       * twenty seconds is not going to bind it in twenty thousand.
       */
      expect(call.timeout).toBeLessThanOrEqual(60);
      expect(call.interval).toBeLessThanOrEqual(5);
      // And specifically the values the fix settled on, so a well-meaning edit cannot quietly
      // re-inflate the budget while keeping it under the ceiling above.
      expect(call.timeout).toBe(20);
      expect(call.interval).toBe(0.5);
    }
  });
});

describe("a screenshot cropped to a region", () => {
  test("is not scaled UP to the model's window", async () => {
    commandLog = [];
    const s = sandbox();

    /*
     * A 400x300 region, which is the size of a form field and the reason the crop path exists.
     * Widening it to 1280 — which `scale=1280:-1` does unconditionally — produces 1280x960, more
     * pixels than the 1280x720 full screen and so strictly more tokens than not cropping at all.
     */
    await captureScreenshot(s as never, {
      region: { x: 100, y: 100, width: 400, height: 300 },
    });

    const capture = commandLog.find((c) => c.includes("scrot"));
    expect(capture).toBeDefined();
    // No scale filter at all, because there is nothing to gain by resampling a region that is already
    // narrower than the window.
    expect(capture).not.toContain("scale=");
  });

  test("is still scaled DOWN when the region is wider than the window", async () => {
    commandLog = [];
    const s = sandbox();

    await captureScreenshot(s as never, {
      region: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    const capture = commandLog.find((c) => c.includes("scrot"));
    expect(capture).toBeDefined();
    expect(capture).toContain("scale=1280:-1");
  });

  test("leaves a full screen alone", async () => {
    commandLog = [];
    const s = sandbox();

    await captureScreenshot(s as never, { width: 1280 });

    const capture = commandLog.find((c) => c.includes("scrot"));
    expect(capture).toBeDefined();
    expect(capture).toContain("scale=1280:-1");
  });
});
