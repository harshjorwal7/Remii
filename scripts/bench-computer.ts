/**
 * What one agent action actually costs, measured rather than argued about.
 *
 * The number everyone argues about is seconds, and seconds are the wrong unit here, because the
 * thing that makes an action slow is a conversation with a machine that is 300ms away, and the count
 * of those conversations is a property of the code rather than of the network. A fix that removes one
 * round trip removes 300ms on a good day and 3s on a bad one; a fix that removes none of them makes
 * the desktop feel slow no matter how fast the link is. So the default mode counts round trips and
 * never touches E2B, which means it is deterministic, free, and runs in CI.
 *
 * WHY A HARNESS AT ALL, given the code is covered. Every fix in the speed work reduces a count, and
 * every one of them is a count that a test asserting on BEHAVIOUR cannot see: memoising a resolve
 * changes nothing an assertion can observe, and neither does collapsing two database reads into one,
 * or re-keying a cache. They are invisible to correctness and visible only here. Without this file the
 * natural pressure is to undo them the first time they look like noise.
 *
 * TWO MODES.
 *
 *   bun scripts/bench-computer.ts          Round trips against an instrumented fake. Free, instant,
 *                                          deterministic. This is the regression gate.
 *   bun scripts/bench-computer.ts --live   Wall-clock percentiles against a real E2B sandbox, and it
 *                                          creates one, so it costs money. Use it to confirm the
 *                                          counts translated into time on the current network.
 *
 * WHAT IS COUNTED, and why each one is here rather than the next one.
 *
 *   exec      A command run inside the sandbox. The dominant cost and the one worth driving to zero.
 *   connect   `Sandbox.connect`, which is a network call AND resumes a paused machine as a side
 *             effect, so an accidental one is expensive in both directions.
 *   getInfo   A cheap status read, but still a round trip, and there is a way to be wrong about it:
 *             using `connect` to ASK whether a machine is up defeats the idle pause.
 *   write     `files.write`, which is how a script gets onto the machine.
 *   db        A store read or write, which is a round trip to Postgres and used to happen twice on
 *             paths that only needed it once.
 *
 * The thresholds are the numbers from the plan this was written for, deliberately set where the
 * current code sits rather than where it ought to: a benchmark that fails on the first run is a
 * benchmark nobody runs twice. They are marked TODO as each phase lands, and lowering them is the
 * point.
 */

import { mock } from "bun:test";

type Counters = {
  exec: number;
  connect: number;
  getInfo: number;
  write: number;
  db: number;
};

const zero = (): Counters => ({
  exec: 0,
  connect: 0,
  getInfo: 0,
  write: 0,
  db: 0,
});

const total = (c: Counters): number =>
  c.exec + c.connect + c.getInfo + c.write + c.db;

/** One measured operation and the round trips it cost. */
type Measurement = {
  name: string;
  counters: Counters;
  ms: number;
  /** Set where the number is a floor rather than a target — the call cannot go below one round trip. */
  floor?: boolean;
};

type Harness = {
  measure(
    name: string,
    fn: () => Promise<unknown>,
    opts?: { floor?: boolean },
  ): Promise<Measurement>;
  counters: Counters;
  reset(): void;
  provisioner: {
    sandboxFor(s: unknown): Promise<unknown>;
    ensureDesktop(s: unknown): Promise<unknown>;
  };
  scope: unknown;
  /** A fresh adapter over a freshly connected handle, exactly as `resolveDesktopFor` builds one. */
  use(): Promise<
    Awaited<
      ReturnType<
        typeof import("../server/src/computer/e2b-desktop")["computerUseFor"]
      >
    >
  >;
};

const now = () => performance.now();

/**
 * A sandbox that counts instead of executing.
 *
 * Deliberately not a mock that returns instantly and cheaply: the point is the COUNT, so every
 * method that would cross the wire is counted and then answered from memory. `waitAndVerify`
 * reports success on the first check, which is the common case and the only one that matters for a
 * regression gate — the failure path is where the units bug lived, and that is covered by
 * `tests/e2b-resume.test.ts` asserting the arguments.
 *
 * `state` is shared across every handle on purpose while the handle itself is not. See
 * `connectFactory` for why that distinction is the whole point of this file.
 */
function fakeSandbox(
  counters: Counters,
  id: string,
  state: { running: boolean; installed: boolean },
) {
  const run = async (command: string) => {
    counters.exec += 1;
    if (command.includes("pyatspi"))
      return { exitCode: state.installed ? 0 : 1, stdout: "", stderr: "" };
    if (command.includes("scrot"))
      return { exitCode: 0, stdout: "BASE64JPEG", stderr: "" };
    if (command.includes("wmctrl"))
      return {
        exitCode: 0,
        stdout: "0x001 0 -10 40 1200 800 host Chromium",
        stderr: "",
      };
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  return {
    sandboxId: id,
    display: ":0",
    getHost: () => `https://${id}.e2b.dev`,
    commands: {
      run,
      /*
       * The SDK spends the last two arguments as SECONDS (`setTimeout(interval * 1e3)`,
       * `elapsed += interval`). Reproduced so a caller that passes milliseconds behaves in the
       * benchmark exactly the way it behaves live — which is how the 8-minute stall stayed invisible
       * to every test that only asserted the wait was called.
       */
      waitAndVerify: async (
        _cmd: string,
        _onResult: (r: { stdout: string }) => boolean,
        timeout = 10,
        interval = 0.5,
      ) => {
        counters.exec += 1;
        void timeout;
        void interval;
        return true;
      },
    },
    files: {
      write: async () => {
        counters.write += 1;
      },
      read: async () => new Uint8Array(),
    },
    moveMouse: async () => {
      counters.exec += 1;
    },
    /*
     * E2B's one-shot clicks, present on a real handle and counted as the single round trip they are.
     * Without these the click falls back to move/press/release and the benchmark reports the
     * pre-fix number, which is how a fix like that would end up looking like it did nothing.
     */
    leftClick: async () => {
      counters.exec += 1;
    },
    rightClick: async () => {
      counters.exec += 1;
    },
    middleClick: async () => {
      counters.exec += 1;
    },
    mousePress: async () => {
      counters.exec += 1;
    },
    mouseRelease: async () => {
      counters.exec += 1;
    },
    write: async () => {
      counters.exec += 1;
    },
    press: async () => {
      counters.exec += 1;
    },
    getCursorPosition: async () => {
      counters.exec += 1;
      return { x: 1, y: 1 };
    },
    getScreenSize: async () => {
      counters.exec += 1;
      return { width: 1920, height: 1080 };
    },
    isRunning: async () => state.running,
    pause: async () => {
      counters.exec += 1;
      state.running = false;
      return true;
    },
  };
}

/**
 * The instrumented store and provisioner.
 *
 * `desktopTtlMs` is the production default (5s), and `touchIntervalMs` is 0 so every write is
 * counted — with it throttled, a steady read would show 0 db writes for the right reason and a db
 * regression would hide. The memo stays ON, though, because that is the honest shape of a working
 * session: a tool call finds the desktop already verified rather than re-asking for it, and the
 * steady-state numbers the table reports are what that produces. The one thing still coarse here is
 * that a fresh fake handle is minted for the FIRST steady read (cold), and a real session would
 * amortise that same way.
 */
async function harness(): Promise<Harness> {
  const counters = zero();
  const sandboxId = "bench";

  let row: Record<string, unknown> | null = null;
  const store = {
    get: async () => {
      counters.db += 1;
      return row as never;
    },
    patch: async (_key: string, patch: Record<string, unknown>) => {
      counters.db += 1;
      row = { ...(row ?? {}), ...patch };
      return row as never;
    },
    create: async (input: Record<string, unknown>) => {
      counters.db += 1;
      row = {
        id: input.id,
        userId: input.userId,
        provider: input.provider,
        sandboxId,
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
      return row as never;
    },
    listRunning: async () => {
      counters.db += 1;
      return row ? [row] : [];
    },
  };

  /*
   * The E2B seam is replaced at the module, not through the constructor — that is where
   * `provisioner.ts` reaches the platform (`e2b-sdk.ts`), and it is the seam the existing
   * `e2b-resume.test.ts` uses for the same reason. Mocking it has to happen before the provisioner
   * module is imported, or it keeps the real `Sandbox` and the benchmark tries to reach
   * `example.invalid` over a real socket, which is a slower and much more confusing way to learn
   * that.
   */
  const shared = { running: true, installed: true };
  const realSdk = await import("../server/src/computer/e2b-sdk");
  mock.module("../server/src/computer/e2b-sdk", () => ({
    ...realSdk,
    Sandbox: {
      create: async () => fakeSandbox(counters, sandboxId, shared) as never,
      list: async () => ({ items: [] }) as never,
      /*
       * A NEW HANDLE ON EVERY CALL, which is the single most important detail in this file.
       *
       * The real `Sandbox.connect` returns a fresh instance every time, and the three caches in
       * `e2b-desktop.ts` are `WeakMap`s keyed on that instance. So in production they miss on every
       * single tool call — each `computer_screen` re-probes for pyatspi and rewrites two scripts,
       * each shell call re-detects the workspace. A fake that returns one shared object makes those
       * caches hit every time, which hides the bug completely and reports a number that looks fine.
       *
       * Returning a fresh handle is what makes this benchmark measure the shipping system rather than
       * the system someone wishes shipped.
       */
      connect: async (id: string) => {
        counters.connect += 1;
        return fakeSandbox(counters, id, shared) as never;
      },
      getInfo: async (id: string) => {
        counters.getInfo += 1;
        return {
          sandboxId: id,
          state: shared.running ? "running" : "paused",
        } as never;
      },
    },
    Volume: {
      list: async () => ({ items: [] }) as never,
      create: async () => ({}) as never,
    },
  }));

  const { createComputerProvisioner } = await import(
    "../server/src/computer/provisioner"
  );
  const provisioner = createComputerProvisioner(
    store as never,
    {
      apiKey: "bench",
      apiUrl: "https://example.invalid",
      readyTimeoutMs: 1_000,
      desktopTtlMs: 5_000,
      touchIntervalMs: 0,
    } as never,
  );

  const scope = { key: "bench", userId: "bench" } as never;

  const reset = () => {
    for (const key of Object.keys(counters) as (keyof Counters)[])
      counters[key] = 0;
  };

  return {
    counters,
    reset,
    provisioner: provisioner as never,
    scope,
    /*
     * Resolving through the provisioner rather than reaching for a handle directly, because THAT is
     * what production does: `resolveDesktopFor` calls `sandboxFor`, which calls `Sandbox.connect`,
     * which hands back a new object. Handing the adapter a long-lived fake handle instead — which is
     * what the first version of this file did — makes every per-sandbox cache hit and the benchmark
     * reports numbers the server never produces.
     */
    async use() {
      const { computerUseFor } = await import(
        "../server/src/computer/e2b-desktop"
      );
      return computerUseFor((await provisioner.sandboxFor(scope)) as never);
    },
    async measure(name, fn, opts) {
      reset();
      const started = now();
      await fn();
      const ms = now() - started;
      return {
        name,
        counters: { ...counters },
        ms,
        ...(opts?.floor ? { floor: true } : {}),
      };
    },
  };
}

/**
 * Where each operation sits today, and where it is going.
 *
 * `at` is measured, not estimated — run the script and it prints. `target` is what the phase that
 * owns it is supposed to deliver, and it is here rather than in a comment so that "did the phase
 * actually land" is a number instead of an opinion.
 *
 * The gate is `at`. A benchmark that fails on the first run is a benchmark nobody runs twice, and
 * the regression worth catching is a count going UP, not a count being high. So the check is "no
 * worse than today", and lowering `at` as each phase lands is how progress is tracked. Anything the
 * phases improve shows up as a gap between `at` and the measurement.
 */
const THRESHOLDS: Record<
  string,
  {
    at: { exec: number; total: number };
    target: { exec?: number; total?: number };
    note: string;
  }
> = {
  computer_screen: {
    at: { exec: 3, total: 6 },
    target: { exec: 2, total: 3 },
    note:
      "Cold first read: exec 3 (pyatspi probe + tree + windows), 1 connect, 2 writes, total 6. Steady-state — " +
      "what every later read costs — is now exec 2, 1 connect, 0 writes, 0 db, total 3: the AT-SPI probe and the " +
      "helper writes happen once per sandbox (phase 2 re-keyed the caches on sandboxId), and the double resolve is " +
      "collapsed (phase 2.5), so no store read or getInfo on the hot path. If a steady read ever shows 2 writes or a db " +
      "row again, one of those has regressed.",
  },
  computer_click: {
    at: { exec: 1, total: 2 },
    target: { exec: 1, total: 2 },
    note:
      "1 exec, 1 connect, total 2 — down from 3 execs + 4 round trips. The exec is E2B's one-shot " +
      "leftClick; the composed move/press/release it replaced was three sequential calls to a machine ~300ms away, " +
      "and the skills have the model LOOK, click, VERIFY, so that was paid before every action of every task. " +
      "The composition remains as the fallback for a handle without the one-shot methods, where the three " +
      "calls cannot be parallelised because the press must land after the move.",
  },
  "resolve (sandboxFor)": {
    at: { exec: 0, total: 1 },
    target: { total: 1 },
    note:
      "One connect, nothing else. The memo hit means no SELECT, no getInfo, no resume (`ensureDesktop` has " +
      "already verified and cached the row, so `sandboxFor` resolves from the same map rather than running a second " +
      "`ensure`). This was 4 round trips before phase 2.5.",
  },
};

async function main() {
  const live = process.argv.includes("--live");
  if (live) {
    console.error(
      "Live mode is not wired up yet. The round-trip mode is the regression gate and needs no\n" +
        "credentials; live mode is for confirming the counts on the current network.",
    );
    process.exit(1);
  }

  const h = await harness();
  const results: Measurement[] = [];

  // The provisioner has to have a row before it will resolve a sandbox, and that first resolve is a
  // cold start rather than a warm read. It is done once, outside every measurement, so what is
  // reported below is the cost of an action and not the cost of the first action ever taken.
  await h.provisioner.ensureDesktop(h.scope);

  /*
   * `computer_screen` as the TOOL calls it, which is `accessibility.getTree()` plus
   * `display.getWindows()` — not a screenshot. `desktop-tools.ts` is explicit that this tool
   * "returns text, not an image", so measuring a capture here would have measured the wrong
   * operation and made the tree cost look like a picture cost.
   */
  const screenOnce = () =>
    h.measure("computer_screen", async () => {
      const cu = await h.use();
      await cu.accessibility?.getTree?.().catch(() => null);
      await cu.display.getWindows().catch(() => null);
    });

  results.push(await screenOnce());

  results.push(
    await h.measure("computer_click", async () => {
      const cu = await h.use();
      await cu.mouse.click(400, 300);
    }),
  );

  results.push(
    await h.measure("resolve (sandboxFor)", async () => {
      await h.provisioner.sandboxFor(h.scope);
    }),
  );

  // A second screen read immediately after the first, which is what the skills actually ask for
  // (LOOK, act, VERIFY). If the caches were working this should cost the SAME as the first. The gap
  // between them IS the cache-miss bug, so it is reported as its own line rather than averaged in.
  const first = await screenOnce();
  const second = await screenOnce();
  results.push(first, second);

  const pad = (s: string, n: number) => s.padEnd(n);
  const padStart = (s: string, n: number) => s.padStart(n);

  console.log("");
  console.log(
    `  ${pad("operation", 34)}${padStart("exec", 6)}${padStart("conn", 6)}${padStart("info", 6)}${padStart("wr", 5)}${padStart("db", 5)}${padStart("TOTAL", 8)}${padStart("ms", 8)}`,
  );
  console.log(`  ${"-".repeat(78)}`);
  for (const r of results) {
    const c = r.counters;
    console.log(
      `  ${pad(r.name, 34)}${padStart(String(c.exec), 6)}${padStart(String(c.connect), 6)}` +
        `${padStart(String(c.getInfo), 6)}${padStart(String(c.write), 5)}${padStart(String(c.db), 5)}` +
        `${padStart(String(total(c)), 8)}${padStart(r.ms.toFixed(1), 8)}`,
    );
  }

  /*
   * Steady-state cache health: a repeat screen read should cost zero helper-script writes. Two writes
   * here means the per-sandbox caches regressed to per-handle keys, which is the difference between
   * a screen read being two execs and it being three execs plus two uploads.
   */
  const steadyWrites = second.counters.write;
  console.log("");
  console.log(
    `  a steady screen read spends ${steadyWrites} helper-script upload(s)`,
  );
  console.log(
    steadyWrites === 0
      ? "  CACHE IS WORKING — one probe + one script-write per sandbox, not per read"
      : "  CACHE IS DEAD — the probe and script writes re-run on every screen read",
  );

  console.log("");
  let regressed = 0;
  for (const [name, limit] of Object.entries(THRESHOLDS)) {
    const match = results.find((r) => r.name === name);
    if (!match) continue;
    const c = match.counters;
    const overExec = c.exec > limit.at.exec;
    const overTotal = total(c) > limit.at.total;
    if (overExec || overTotal) regressed += 1;
    const mark = overExec || overTotal ? "OVER" : "ok";
    const tgt =
      limit.target.total !== undefined ? ` target ${limit.target.total}` : "";
    console.log(
      `  [${mark}] ${pad(name, 24)} exec ${padStart(String(c.exec), 2)}/${limit.at.exec}  total ${padStart(String(total(c)), 2)}/${limit.at.total}${tgt}`,
    );
  }

  console.log("");
  console.log("  notes");
  for (const [name, limit] of Object.entries(THRESHOLDS)) {
    console.log(`    ${name}: ${limit.note}`);
  }

  console.log("");
  console.log(
    regressed === 0
      ? "  no regressions against today's numbers\n"
      : `  ${regressed} operation(s) WORSE than the recorded baseline — that is a regression\n`,
  );
  if (regressed > 0) process.exitCode = 1;
}

await main();
