import { describe, expect, test } from "bun:test";
import {
  MODEL_IMAGE_WIDTH,
  captureScreenshot,
  computerUseFor,
  machineFor,
  normaliseKey,
  type E2BDesktopLike,
} from "../src/computer/e2b-desktop";

/**
 * The seam between an E2B desktop and the interfaces the tools already speak.
 *
 * Two things are worth testing here and neither is the adapter's shape.
 *
 * The first is KEY NAMES, because the failure mode is invisible: E2B speaks xdotool's vocabulary and
 * the tools speak a browser's. Passing `Enter` straight through types nothing and reports success,
 * which is the worst combination available — a Bot pressing Enter to submit a form and being told it
 * worked. A mapping bug here does not throw; it makes a Bot confidently wrong.
 *
 * The second is SCREENSHOT FALLBACK. E2B's `screenshot("bytes")` returns raw bytes with no quality and
 * no scale parameter, so a naive port would hand the model a full-resolution PNG of a 1920x1080
 * desktop on every look. The shell path that produces a scaled JPEG is the cheap route, and the SDK
 * call is the fallback for a machine where `scrot` and `ffmpeg` are missing. Both have to work.
 */

/** A sandbox that records what it was asked to do. */
const makeSandbox = (overrides: Partial<E2BDesktopLike> = {}) => {
  const log: string[] = [];
  const sandbox = {
    sandboxId: "sbx-1",
    display: ":0",
    log,
    commands: {
      async run(command: string) {
        log.push(`run ${command}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    files: {
      async read(path: string) {
        log.push(`read ${path}`);
        return new TextEncoder().encode("hello");
      },
      async write(path: string, data: string) {
        log.push(`write ${path} ${String(data).length}`);
      },
      async list(path: string) {
        log.push(`list ${path}`);
        return [
          {
            name: "notes.md",
            path: "/workspace/notes.md",
            type: "file",
            size: 12,
          },
          { name: "sub", path: "/workspace/sub", type: "dir" },
        ];
      },
    },
    async screenshot() {
      log.push("sdk-screenshot");
      return new Uint8Array([1, 2, 3, 4]);
    },
    async getScreenSize() {
      return { width: 1920, height: 1080 };
    },
    ...overrides,
  } as unknown as E2BDesktopLike;
  return { sandbox, log };
};

describe("key names", () => {
  test("translates the browser names the tools use into xdotool's", () => {
    // Every one of these types NOTHING if passed through unchanged. A Bot pressing Enter to submit a
    // login form and being told it worked is the exact failure this table exists to prevent.
    expect(normaliseKey("Enter")).toBe("Return");
    expect(normaliseKey("esc")).toBe("Escape");
    expect(normaliseKey("ArrowLeft")).toBe("Left");
    expect(normaliseKey("ArrowDown")).toBe("Down");
    expect(normaliseKey("Backspace")).toBe("BackSpace");
    expect(normaliseKey("PageUp")).toBe("Prior");
    expect(normaliseKey("PageDown")).toBe("Next");
  });

  test("keeps a hotkey's modifiers and corrects only the key", () => {
    expect(normaliseKey("ctrl+s")).toBe("ctrl+s");
    expect(normaliseKey("Ctrl+Shift+K")).toBe("ctrl+shift+K");
    expect(normaliseKey("cmd+enter")).toBe("super+Return");
    expect(normaliseKey("Meta+ArrowUp")).toBe("meta+Up");
  });

  test("does not mistake a modifier for a key name", () => {
    // `Ctrl` capitalised must stay a MODIFIER. Corrected to some key named `ctrl`, it would be typed
    // rather than held, which is the same invisible failure as `Enter`.
    expect(normaliseKey("Ctrl+A")).toBe("ctrl+A");
    expect(normaliseKey("shift+enter")).toBe("shift+Return");
    // The KEY's own case is left exactly as sent, because xdotool distinguishes `a` from `A` and
    // rewriting it would turn Ctrl+A into a different chord than the caller asked for.
    expect(normaliseKey("ctrl+Shift+A")).toBe("ctrl+shift+A");
  });

  test("passes an xdotool name through untouched, so a caller who knows the platform can use it", () => {
    expect(normaliseKey("Return")).toBe("Return");
    expect(normaliseKey("ctrl+alt+Delete")).toBe("ctrl+alt+Delete");
  });

  test("survives an empty string rather than producing something unpressable", () => {
    // Not a crash: `press("")` is a no-op on xdotool, and the caller had nothing to send.
    expect(normaliseKey("")).toBe("");
  });
});

describe("the machine interface", () => {
  test("resolves a relative path against the workspace, and honours an absolute one", async () => {
    const { sandbox, log } = makeSandbox();
    const machine = machineFor(sandbox);
    await machine.listFiles("");
    await machine.readFile("/etc/hostname");
    // The tools say `notes.md` because that is what a person would say. Resolving against whatever
    // the sandbox's working directory happens to be would be a Bot writing to the wrong place and
    // reporting success. An absolute path is honoured as given, which is not a hole: the tools are
    // offered to one Bot on one machine, and it can already run a shell command with any path.
    expect(log).toContain("list /workspace");
    expect(log).toContain("read /etc/hostname");
  });

  test("uses the VOLUME path when one is mounted", async () => {
    // The volume is where a person's files are, and changing the answer would lose them.
    const { sandbox, log } = makeSandbox({
      commands: {
        async run(command: string) {
          log.push(command);
          if (command.includes("-d /workspace"))
            return { exitCode: 0, stdout: "/workspace\n", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    } as Partial<E2BDesktopLike>);
    await machineFor(sandbox).writeFile("notes.md", "x");
    expect(log).toContain("write /workspace/notes.md 1");
  });

  test("falls back to a writable directory when there is NO volume, because /workspace may not exist", async () => {
    /*
     * The failure this exists for, and it was total.
     *
     * On an E2B account without volumes there is no `/workspace` and no way to make one — the sandbox
     * user cannot write to `/`. Every `computer_shell`, `computer_read_file` and `computer_write_file`
     * then failed with `InvalidArgumentError: cwd '/workspace' does not exist`, on a desktop that
     * looked entirely healthy: a screen, a browser, a working screenshot, and no way to touch a file.
     */
    const { sandbox, log } = makeSandbox({
      commands: {
        async run(command: string) {
          log.push(command);
          if (command.includes("-d /workspace")) {
            return {
              exitCode: 0,
              stdout: "/home/user/workspace\n",
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    } as Partial<E2BDesktopLike>);
    const machine = machineFor(sandbox);

    await machine.writeFile("notes.md", "hello");
    await machine.listFiles("");

    // `files.write` records the byte length, not the text — same bytes either way.
    expect(log).toContain("write /home/user/workspace/notes.md 5");
    expect(log).toContain("list /home/user/workspace");
    // And the detection is asked about rather than assumed, which is the whole point.
    expect(log.some((c) => c.includes("-d /workspace"))).toBe(true);
  });

  test("runs a command in the detected workspace rather than the assumed one", async () => {
    const { sandbox, log } = makeSandbox({
      commands: {
        async run(command: string, opts?: { cwd?: string }) {
          log.push(`run ${command}`);
          if (opts?.cwd) log.push(`cwd ${opts.cwd}`);
          if (command.includes("-d /workspace"))
            return {
              exitCode: 0,
              stdout: "/home/user/workspace\n",
              stderr: "",
            };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    } as Partial<E2BDesktopLike>);
    await machineFor(sandbox).exec("ls");
    // The cwd is the thing under test, and it is not in the command — a command that ran in the wrong
    // directory and succeeded is the failure this is about.
    expect(log).toContain("cwd /home/user/workspace");
  });

  test("falls back to the conventional path when detection cannot answer", async () => {
    const { sandbox, log } = makeSandbox({
      commands: {
        async run() {
          throw new Error("connection reset");
        },
      },
    } as Partial<E2BDesktopLike>);
    await machineFor(sandbox).writeFile("a.txt", "x");
    // Right on any machine that does have the volume, and better than throwing on one that does not.
    expect(log).toContain("write /workspace/a.txt 1");
  });

  test("asks once per sandbox, not once per tool call", async () => {
    const { sandbox, log } = makeSandbox();
    const machine = machineFor(sandbox);
    await machine.exec("ls");
    await machine.exec("pwd");
    await machine.writeFile("a.txt", "x");
    // A round trip per tool call would be a real cost on a remote machine, and this one changes nothing
    // during a session.
    expect(log.filter((c) => c.includes("-d /workspace"))).toHaveLength(1);
  });

  test("keeps an absolute path absolute", async () => {
    const { sandbox, log } = makeSandbox();
    await machineFor(sandbox).readFile("/etc/hostname");
    expect(log).toContain("read /etc/hostname");
  });

  test("runs a command in the workspace and reports a non-zero exit as a result, not a fault", async () => {
    // "The command ran and said no" is the answer the caller asked for. Throwing would make a grep
    // that found nothing look like a failure, and a Bot handed a failure retries or gives up.
    const { sandbox } = makeSandbox({
      commands: {
        async run() {
          return { exitCode: 1, stdout: "", stderr: "no matches" };
        },
      },
    } as Partial<E2BDesktopLike>);
    const result = await machineFor(sandbox).exec("grep nothing");
    expect(result).toEqual({ exitCode: 1, stdout: "no matches" });
  });

  test("reports diagnostics as well as output", () => {
    // A Bot that piped a command's output to a file and read the diagnostic instead of the result is
    // a Bot debugging its own tooling. "permission denied" as an empty string looks like silence.
    const { sandbox } = makeSandbox({
      commands: {
        async run() {
          return {
            exitCode: 2,
            stdout: "partial",
            stderr: "permission denied",
          };
        },
      },
    } as Partial<E2BDesktopLike>);
    return machineFor(sandbox)
      .exec("cat secret")
      .then((result) => {
        expect(result.stdout).toContain("partial");
        expect(result.stdout).toContain("permission denied");
      });
  });

  test("describes a listing, marking directories as directories", async () => {
    const entries = await machineFor(makeSandbox().sandbox).listFiles("");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      name: "notes.md",
      isDirectory: false,
      size: 12,
    });
    expect(entries[1]).toMatchObject({ name: "sub", isDirectory: true });
  });
});

describe("screenshots", () => {
  test("uses the shell path when it works, so the model gets a scaled JPEG", async () => {
    const { sandbox, log } = makeSandbox({
      commands: {
        async run(command: string) {
          log.push(command);
          return { exitCode: 0, stdout: "QUJD", stderr: "" };
        },
      },
    } as Partial<E2BDesktopLike>);

    const shot = await captureScreenshot(sandbox);

    expect(shot?.data).toBe("QUJD");
    // One round trip for the whole capture: `scrot` takes the picture, `ffmpeg` resizes and
    // re-encodes, and the bytes come back base64'd. The naive route — SDK screenshot, write, run,
    // read — is four, with the encode in front of every screenshot.
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("scrot");
    expect(log[0]).toContain("ffmpeg");
    // 1280 rather than the desktop's 1920: the same buttons, same labels, same layout, at a fraction
    // of the tokens.
    expect(log[0]).toContain(`scale=${MODEL_IMAGE_WIDTH}:-1`);
  });

  test("scales to the width asked for", async () => {
    const { sandbox, log } = makeSandbox({
      commands: {
        async run(command: string) {
          log.push(command);
          return { exitCode: 0, stdout: "QUJD", stderr: "" };
        },
      },
    } as Partial<E2BDesktopLike>);

    await captureScreenshot(sandbox, { width: 640 });
    expect(log[0]).toContain("scale=640:-1");
  });

  test("crops when given a region, because a form field should not cost a whole screen", async () => {
    const { sandbox, log } = makeSandbox({
      commands: {
        async run(command: string) {
          log.push(command);
          return { exitCode: 0, stdout: "QUJD", stderr: "" };
        },
      },
    } as Partial<E2BDesktopLike>);

    await captureScreenshot(sandbox, {
      region: { x: 10, y: 20, width: 400, height: 300 },
    });
    // `scrot -g` takes x,y+width+height and not a rectangle.
    expect(log[0]).toContain("-g 10,20+400+300");
  });

  test("falls back to the SDK when the shell tools are missing", async () => {
    // A machine without `scrot` or `ffmpeg` must still produce a picture rather than no screen at all.
    const { sandbox } = makeSandbox({
      commands: {
        async run(command: string) {
          if (command.trim() === "true") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 127, stdout: "", stderr: "scrot: not found" };
        },
      },
    } as Partial<E2BDesktopLike>);

    const shot = await captureScreenshot(sandbox);
    expect(shot?.data).toBeTruthy();
    expect(Buffer.from(shot!.data, "base64").length).toBe(4);
  });

  test("falls back when the scrot call throws outright but the machine still answers", async () => {
    const { sandbox } = makeSandbox({
      commands: {
        async run(command: string) {
          if (command.trim() === "true") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          throw new Error("connection reset");
        },
      },
    } as Partial<E2BDesktopLike>);

    expect(await captureScreenshot(sandbox)).not.toBeNull();
  });

  test("does not serve the SDK's cached frame when the machine has gone away", async () => {
    // `screenshot("bytes")` on a paused or wedged desktop returns the same frozen frame forever.
    // Serving it lets a Bot believe its actions did nothing because the picture never changes.
    // An unreachable machine gets no frame at all.
    const { sandbox } = makeSandbox({
      commands: {
        async run() {
          throw new Error("connection reset");
        },
      },
      async screenshot(): Promise<Uint8Array> {
        return new Uint8Array([1, 2, 3, 4]);
      },
    } as Partial<E2BDesktopLike>);

    expect(await captureScreenshot(sandbox)).toBeNull();
  });

  test("returns null rather than throwing when nothing produced a picture", async () => {
    // A display that is not up yet is an ordinary state, and the caller already has an answer for a
    // screenshot that did not arrive. Throwing here would be a stack trace where a sentence belongs.
    const { sandbox } = makeSandbox({
      commands: {
        async run() {
          return { exitCode: 1, stdout: "", stderr: "" };
        },
      },
      async screenshot(): Promise<Uint8Array> {
        throw new Error("no display");
      },
    } as Partial<E2BDesktopLike>);

    expect(await captureScreenshot(sandbox)).toBeNull();
  });

  test("returns null rather than throwing on an empty picture either", async () => {
    const { sandbox } = makeSandbox({
      commands: {
        async run() {
          return { exitCode: 1, stdout: "", stderr: "" };
        },
      },
      async screenshot(): Promise<Uint8Array> {
        return new Uint8Array();
      },
    } as Partial<E2BDesktopLike>);

    expect(await captureScreenshot(sandbox)).toBeNull();
  });
});

describe("the computer-use interface", () => {
  test("reports the display as one active screen at the desktop's own size", async () => {
    // A click's coordinates are read against this, so it is asked of the machine rather than assumed
    // from the resolution passed at create time.
    const use = computerUseFor(makeSandbox().sandbox);
    const info = await use.display.getInfo();
    expect(info.displays).toEqual([
      { width: 1920, height: 1080, isActive: true },
    ]);
  });

  test("composes a click from a move, a press and a release", async () => {
    const log: string[] = [];
    const { sandbox } = makeSandbox({
      async moveMouse(x: number, y: number) {
        log.push(`move ${x},${y}`);
      },
      async mousePress(button?: string) {
        log.push(`press ${button}`);
      },
      async mouseRelease(button?: string) {
        log.push(`release ${button}`);
      },
    } as Partial<E2BDesktopLike>);

    await computerUseFor(sandbox).mouse.click(800, 600, "right");
    expect(log).toEqual(["move 800,600", "press right", "release right"]);
  });

  test("rounds coordinates, because the desktop has pixels and not fractions", async () => {
    const log: string[] = [];
    const { sandbox } = makeSandbox({
      async moveMouse(x: number, y: number) {
        log.push(`move ${x},${y}`);
      },
    } as Partial<E2BDesktopLike>);

    await computerUseFor(sandbox).mouse.move(800.6, 599.2);
    expect(log).toEqual(["move 801,599"]);
  });

  test("uses the double-click fast path where one exists", async () => {
    // Two presses in the same place is not always what a double-click means to an application, which
    // is why the dedicated call is preferred rather than synthesised.
    const log: string[] = [];
    const { sandbox } = makeSandbox({
      async doubleClick(x?: number, y?: number) {
        log.push(`double ${x},${y}`);
      },
      async moveMouse(x: number, y: number) {
        log.push(`move ${x},${y}`);
      },
      async mousePress() {
        log.push("press");
      },
      async mouseRelease() {
        log.push("release");
      },
    } as Partial<E2BDesktopLike>);

    await computerUseFor(sandbox).mouse.click(10, 20, "left", true);
    expect(log).toEqual(["double 10,20"]);
  });

  test("drags by pressing, moving and releasing", async () => {
    const log: string[] = [];
    const { sandbox } = makeSandbox({
      async moveMouse(x: number, y: number) {
        log.push(`move ${x},${y}`);
      },
      async mousePress(button?: string) {
        log.push(`press ${button}`);
      },
      async mouseRelease(button?: string) {
        log.push(`release ${button}`);
      },
    } as Partial<E2BDesktopLike>);

    await computerUseFor(sandbox).mouse.drag!(0, 0, 100, 200);
    expect(log).toEqual([
      "move 0,0",
      "press left",
      "move 100,200",
      "release left",
    ]);
  });

  test("types with the platform's own writer rather than pressing a whole string as one key", async () => {
    // Handing a whole string to `press` would be read as one key name and type nothing.
    const log: string[] = [];
    const { sandbox } = makeSandbox({
      async write(text: string) {
        log.push(`write ${text}`);
      },
      async press(key: string | string[]) {
        log.push(`press ${key}`);
      },
    } as Partial<E2BDesktopLike>);

    await computerUseFor(sandbox).keyboard.type("hello");
    expect(log[0]).toBe("write hello");
  });

  test("says no windows rather than failing when the window tool is absent", async () => {
    // A bare desktop's accessibility tree will not tell you what is open. That is a degraded answer
    // worth reporting, not a fault worth throwing.
    const { sandbox } = makeSandbox({
      commands: {
        async run() {
          return { exitCode: 0, stdout: "NO_WMCTRL", stderr: "" };
        },
      },
    } as Partial<E2BDesktopLike>);

    expect(await computerUseFor(sandbox).display.getWindows!()).toEqual({
      windows: [],
    });
  });

  test("reads window geometry when the window tool is there", async () => {
    // Without geometry a window list is not usable for clicking anything.
    const { sandbox } = makeSandbox({
      commands: {
        async run() {
          return {
            exitCode: 0,
            stdout:
              "0x001 0 100 200 800 600 host Chromium\n0x002 0 10 20 300 400 host Files\n",
            stderr: "",
          };
        },
      },
    } as Partial<E2BDesktopLike>);

    const { windows } = await computerUseFor(sandbox).display.getWindows!();
    expect(windows).toHaveLength(2);
    expect(windows?.[0]).toMatchObject({ x: 100, y: 200, title: "Chromium" });
    expect(windows?.[1]).toMatchObject({ x: 10, y: 20, title: "Files" });
  });
});
