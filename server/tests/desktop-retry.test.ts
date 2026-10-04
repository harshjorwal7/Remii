import { describe, expect, test } from "bun:test";
import type { E2BDesktopLike } from "../src/computer/e2b-desktop";
import { computerUseFor, machineFor } from "../src/computer/e2b-desktop";

/**
 * Retrying is only safe where we can be certain nothing happened.
 *
 * There was no retry anywhere in this adapter, and the reason to add one is specific rather than
 * general: the model retries too. Hand a failed call back and it reissues, which is right for "that did
 * not work" and wrong for "that worked but the answer was lost" — and a click is exactly the case where
 * those two look identical. So the question this file answers is not "does it retry" but "which failures
 * does it consider safe to retry".
 *
 * Two of these are as important as the ones that retry: a command that reported a non-zero exit, and a
 * command that ran out of time. Both mean the sandbox already did the thing, and running either again is
 * a second action rather than a retry.
 */

let counter = 0;
/** A distinct id per sandbox, so a per-sandbox cache cannot leak between them. */
const nextId = (): string => {
  counter += 1;
  return `retry-${counter}`;
};

/** A sandbox whose chosen primitive fails a fixed number of times before working. */
const sandboxThat = (
  behaviour: {
    failures?: number;
    error?: () => Error;
    calls?: () => number;
  } = {},
) => {
  let calls = 0;
  const fail = () => {
    calls += 1;
    return (behaviour.failures ?? 0) >= calls;
  };
  const errorFor = behaviour.error ?? (() => new Error("socket hang up"));
  return {
    sandboxId: nextId(),
    display: ":0",
    getHost: () => "https://x.e2b.dev",
    commands: {
      // `exec` goes through here, so this is where the command-level failures have to be raised —
      // the mouse and keyboard primitives are a different set of methods entirely.
      run: async (command: string) => {
        // Only the caller's own command counts. `exec` resolves the workspace first, which is a probe
        // rather than the command, and counting it would make every assertion here off by one.
        if (command.startsWith("if [ -d ")) {
          return { exitCode: 0, stdout: "/workspace\n", stderr: "" };
        }
        if (fail()) throw errorFor();
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    files: { read: async () => new Uint8Array(), write: async () => {} },
    leftClick: async () => {
      if (fail()) throw errorFor();
    },
    press: async () => {
      if (fail()) throw errorFor();
    },
    write: async () => {
      if (fail()) throw errorFor();
    },
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    calls: () => calls,
  } as unknown as E2BDesktopLike & { calls(): number };
};

describe("a click whose connection was refused", () => {
  test("is retried, because the request never arrived", async () => {
    const sandbox = sandboxThat({ failures: 2 });
    await computerUseFor(sandbox).mouse.click(10, 10);

    // Two refusals then a success. Retried until it worked, rather than being reported as a failed
    // click the model would have reissued — which is what made this a double press.
    expect(sandbox.calls()).toBe(3);
  });

  test("gives up rather than retrying forever", async () => {
    const sandbox = sandboxThat({ failures: 99 });
    await expect(computerUseFor(sandbox).mouse.click(10, 10)).rejects.toThrow();
    // Bounded, so a machine that is genuinely gone costs a moment rather than hanging the turn.
    expect(sandbox.calls()).toBe(3);
  });
});

describe("a failure that means the sandbox already acted", () => {
  test("is not retried", async () => {
    const sandbox = sandboxThat({
      failures: 99,
      error: () => new Error("command exited with status 1"),
    });

    await expect(machineFor(sandbox).exec("false")).rejects.toThrow();
    /*
     * Exactly one attempt. A command that ran and reported failure HAS run — retrying it is a second
     * command, and for anything that writes or submits that is the difference between one side effect
     * and two.
     */
    expect(sandbox.calls()).toBe(1);
  });

  test("a timeout is not retried either, because the command is still running", async () => {
    const sandbox = sandboxThat({
      failures: 99,
      error: () => new Error("Command timed out after 60000ms"),
    });

    await expect(machineFor(sandbox).exec("sleep 600")).rejects.toThrow();
    /*
     * The process is alive inside the sandbox and may still produce a result. Re-issuing would run it a
     * second time, concurrently with the first, against the same files.
     */
    expect(sandbox.calls()).toBe(1);
  });
});

describe("a refusal from the deployment", () => {
  test("is not retried", async () => {
    const sandbox = sandboxThat({
      failures: 99,
      error: () =>
        new Error("This computer is not running. It may have been stopped."),
    });

    await expect(computerUseFor(sandbox).mouse.click(10, 10)).rejects.toThrow();
    /*
     * A refusal is a decision, not a glitch. Retrying it would re-run the decision, spend the backoff,
     * and — if the decision was about money or a person holding the wheel — look like the machine
     * arguing with itself.
     */
    expect(sandbox.calls()).toBe(1);
  });
});

describe("text that failed to arrive", () => {
  test("is retried, because half a field is worse than a slow one", async () => {
    const sandbox = sandboxThat({ failures: 1 });
    await computerUseFor(sandbox).keyboard.type("hello", 0);
    expect(sandbox.calls()).toBe(2);
  });
});
