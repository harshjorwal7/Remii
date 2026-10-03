/**
 * An E2B desktop sandbox, seen as the interfaces the tools already speak.
 *
 * The tools want {@link DesktopComputerUse} — screenshot, mouse, keyboard, display — and
 * {@link DesktopMachine} — `exec`, `readFile`, `writeFile`, `listFiles`. E2B's SDK wants to be called
 * as `sandbox.screenshot("bytes")`, `sandbox.commands.run(...)`, `sandbox.files.write(...)`. Neither
 * shape is wrong; they are just different, and this file is the seam.
 *
 * It exists for the same reasons the Daytona adapter it replaces existed, and those reasons do not
 * change when the platform underneath does:
 *
 *  - The tools can be tested without a sandbox.
 *  - The coupling to one SDK version is one file rather than a shape smeared through every tool
 *    definition.
 *
 * ONE BEHAVIOURAL DIFFERENCE WORTH FLAGGING, because it is a change and not a translation.
 *
 * Daytona returned screenshots as base64 JPEG from its own `computerUse` API, already compressed and
 * already scoped. E2B returns raw bytes from `screenshot("bytes")`, with no quality and no scale
 * parameter at all — so a naive port would hand the model a full-resolution PNG of a 1920x1080
 * desktop on every look, which is roughly three times the tokens of the 1280-wide JPEG this was
 * already paying for, spent on a picture the model can barely see the difference in.
 *
 * So screenshots are taken through the tools the desktop image is known to carry — `scrot` for the
 * capture, `ffmpeg` for the resize and the JPEG quality — in ONE round trip, with the SDK's own
 * `screenshot()` kept as a fallback for a machine where those are missing. `MODEL_IMAGE_WIDTH` and
 * `takeScreenshot` are where the cost is controlled.
 */
import type {
  DesktopComputerUse,
  DesktopFileInfo,
  DesktopMachine,
} from "./desktop-stream";
import { WORKSPACE_DIR } from "./e2b-sdk";

/**
 * The slice of an E2B desktop sandbox this adapter uses.
 *
 * Declared structurally rather than imported from `@e2b/desktop` so a test can stand in for a
 * sandbox without one, and so an SDK upgrade that renames something fails here — one file — rather
 * than in every tool.
 */
export type E2BDesktopLike = {
  sandboxId: string;
  display: string;
  screenshot(format: "bytes"): Promise<Uint8Array>;
  getScreenSize(): Promise<{ width: number; height: number }>;
  commands: {
    run(
      command: string,
      opts?: {
        cwd?: string;
        timeoutMs?: number;
        envs?: Record<string, string>;
        /**
         * Start it and return at once, for a command that never exits.
         *
         * Required for websockify, which IS a server: without it `run` waits for the process and the
         * call that opens the live screen times out instead of returning a URL. Backgrounding the
         * command in the shell (`nohup … &`) does not help — envd tracks the process it spawned, not
         * the shell — so this flag is the only thing that works.
         */
        background?: boolean;
      },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  files: {
    read(path: string): Promise<Uint8Array>;
    write(path: string, data: string | Uint8Array): Promise<unknown>;
    list(
      path: string,
    ): Promise<
      Array<{ name?: string; path?: string; type?: string; size?: number }>
    >;
    makeDir?(path: string): Promise<unknown>;
  };
  moveMouse?(x: number, y: number): Promise<void>;
  mousePress?(button?: "left" | "right" | "middle"): Promise<void>;
  mouseRelease?(button?: "left" | "right" | "middle"): Promise<void>;
  doubleClick?(x?: number, y?: number): Promise<void>;
  scroll?(direction?: "up" | "down", amount?: number): Promise<void>;
  press?(key: string | string[]): Promise<void>;
  write?(
    text: string,
    opts?: { chunkSize: number; delayInMs: number },
  ): Promise<void>;
  getCursorPosition?(): Promise<{ x: number; y: number }>;
};

/**
 * The width a screenshot is scaled to before a model sees it.
 *
 * 1280 rather than the desktop's own 1920, and the reason is token cost rather than legibility. The
 * desktop's native width is 1920; a 1280-wide JPEG of the same screen costs a fraction of the tokens
 * and a model reading a 1280-wide screenshot can see the same buttons, same labels and same layout.
 * This is what the screenshot arguments mean when they are not passed, and the tools scale relative
 * to it.
 */
export const MODEL_IMAGE_WIDTH = 1280;

/** JPEG quality for a model-facing screenshot. 55-70 is visually clean for UI text and web pages. */
const MODEL_IMAGE_QUALITY = 6;

const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64",
  );

/**
 * A tool's path, as an absolute one.
 *
 * An empty path means "the workspace itself" — `computer_shell` with no cwd and `listFiles("")` are
 * both asking for the root of the tree — so it resolves to exactly `/workspace` rather than to
 * `/workspace/`, which is a different string to every filesystem API and a needless way to fail.
 */
/**
 * Where a person's files actually are on this machine.
 *
 * NOT ALWAYS `/workspace`, and finding that out the hard way cost every shell and file tool.
 *
 * `/workspace` is where the VOLUME is mounted, so it exists exactly when the account has volumes. An
 * account without them has no `/workspace` at all — and cannot be given one, because the sandbox user
 * has no write permission on `/` and `mkdir /workspace` answers "Permission denied". Which meant every
 * `computer_shell`, `computer_read_file` and `computer_write_file` failed with
 * `InvalidArgumentError: cwd '/workspace' does not exist`, on a desktop that looked completely healthy:
 * a screen, a browser, a screenshot, and no way to touch a file or run a command.
 *
 * So the workspace is resolved rather than assumed, and the answer is cached per sandbox because the
 * adapter is built on every resolve and a round trip per tool call would be a real cost.
 *
 * Order matters. A mounted volume wins, because that is where a person's files are supposed to be and
 * changing the answer would lose them. The home directory is the fallback, and it is a real fallback
 * rather than a shrug: it is writable, it persists for the life of the sandbox exactly as the volume
 * did, and the volume name stays derived from the same user id so enabling volumes later points at the
 * same data.
 */
const workspaceCache = new WeakMap<object, Promise<string>>();

async function detectWorkspace(sandbox: E2BDesktopLike): Promise<string> {
  try {
    const result = await sandbox.commands.run(
      `if [ -d ${WORKSPACE_DIR} ] && [ -w ${WORKSPACE_DIR} ]; then echo ${WORKSPACE_DIR}; ` +
        `elif mkdir -p "$HOME/workspace" 2>/dev/null && [ -w "$HOME/workspace" ]; then ` +
        `echo "$HOME/workspace"; ` +
        `elif [ -w "$HOME" ]; then echo "$HOME"; ` +
        `else echo ${WORKSPACE_DIR}; fi`,
      { timeoutMs: 15_000 },
    );
    const found = result.stdout.trim().split("\n").pop()?.trim();
    if (found?.startsWith("/")) {
      // First real call on this sandbox: plant the in-sandbox helper scripts now, so a later
      // computer_shell of `python3 /tmp/remii-dom.py` finds them even if computer_screen was not
      // the first tool call of the turn.
      void ensureSandboxScripts(sandbox);
      return found;
    }
  } catch {
    // Falls through to the conventional path, which is right on any machine that does have the volume.
  }
  return WORKSPACE_DIR;
}

/** This sandbox's workspace, resolved once. */
function workspaceFor(sandbox: E2BDesktopLike): Promise<string> {
  const existing = workspaceCache.get(sandbox as object);
  if (existing) return existing;
  const detected = detectWorkspace(sandbox);
  workspaceCache.set(sandbox as object, detected);
  return detected;
}

/**
 * A tool's path, as an absolute one, against the workspace we found.
 *
 * An empty path means "the workspace itself" — no cwd on a shell command and `listFiles("")` both ask
 * for the root of the tree — so it resolves to exactly the workspace rather than to a trailing-slashed
 * version of it, which is a different string to every filesystem API.
 */
const makeResolve =
  (workspace: string) =>
  (path: string): string => {
    if (path.startsWith("/")) return path;
    return path ? `${workspace}/${path}` : workspace;
  };

/**
 * Take a picture of the desktop, scaled and as a JPEG, in one round trip.
 *
 * `scrot` captures the X display and `ffmpeg` resizes and re-encodes, both confirmed present in the
 * desktop image. Doing it in the shell rather than in two API calls is what keeps the whole capture
 * at one round trip: the alternative is `screenshot("bytes")` followed by a `files.write`, a
 * `commands.run` and a `files.read`, which is four and puts the encode in front of every screenshot.
 *
 * The crop path exists because reading a 400x300 form field should not cost a whole screen's worth
 * of tokens. `scrot -g` takes an `x,y+w+h` geometry, so a region costs the same one call.
 *
 * Returns `null` when neither the shell tools nor the SDK produced a picture, rather than throwing:
 * a machine whose display is not up yet is an ordinary state, and the caller already has an answer
 * for a screenshot that did not arrive.
 */
export async function captureScreenshot(
  sandbox: E2BDesktopLike,
  options: {
    width?: number;
    region?: { x: number; y: number; width: number; height: number };
    /**
     * Draw the pointer into the picture?
     *
     * `scrot` includes it by default and omits it with `-o`. Left defaulting to TRUE here because the
     * coordinate `getCursorPosition` returns is captured from the same display at the same moment, and
     * a pointer drawn in the picture at a position the model cannot read numerically is worse than no
     * pointer at all — but it is a parameter because a caller asking for a picture of a FORM wants the
     * fields, not an arrow over the one it is about to fill in.
     */
    showCursor?: boolean;
  } = {},
): Promise<{ data: string; cursorPosition?: { x: number; y: number } } | null> {
  const width = options.width ?? MODEL_IMAGE_WIDTH;
  const omit = options.showCursor === false ? "-o" : "";
  const capture = options.region
    ? `scrot ${omit} -g ${geometry(options.region)} ${TMP_PNG}`.replace(
        /\s+/g,
        " ",
      )
    : `scrot ${omit} ${TMP_PNG}`.replace(/\s+/g, " ");
  /*
   * A crop no wider than the model's window is not resampled at all.
   *
   * `scale=${width}:-1` forces the output to `width` in BOTH directions, so a 400x300 region came
   * back as 1280x960 — an upscale, which costs a resample on the sandbox and then MORE tokens than
   * the uncropped 1280-wide screen the crop existed to avoid sending. That is why
   * `takeCompressedRegion` looked like the cheap option and was not: the tool description promises
   * "a fraction of the whole screen" and the encoder was delivering several times the whole screen.
   *
   * So the filter is dropped when there is nothing to gain, and applied only to a region genuinely
   * wider than the window.
   */
  const needsDownscale = !options.region || options.region.width > width;
  const scaleFilter = needsDownscale ? `-vf scale=${width}:-1 ` : "";

  try {
    const result = await sandbox.commands.run(
      `${capture} && ffmpeg -y -loglevel error -i ${TMP_PNG} ` +
        `${scaleFilter}-q:v ${MODEL_IMAGE_QUALITY} ${TMP_JPG} && base64 -w0 ${TMP_JPG}`,
      /*
       * 60 seconds, not 30. A desktop coming back from E2B's memory PAUSE resumes commands rather than
       * failing them, and a resume can take minutes; at 30s the scrot call times out across that whole
       * stall and the fallback below serves the same frozen cached frame for every poll until the
       * machine finishes waking — which is exactly the "stale capture this session" report.
       */
      { timeoutMs: 60_000 },
    );
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      const cursorPosition = await sandbox
        .getCursorPosition?.()
        .catch(() => undefined);
      return { data: result.stdout.trim(), cursorPosition };
    }
  } catch {
    // Falls through to the liveness check below, then the SDK path.
  }

  /*
   * Only fall back to the SDK's screenshot when the machine itself still answers.
   *
   * `screenshot("bytes")` on a paused or wedged desktop does not fail — it returns the same frozen
   * cached frame forever. Serving that is not a degraded picture, it is a confident lie: the Bot
   * reads "the screen hasn't changed" as "nothing happened", which is how a session reads every
   * window opening as "no change". Verify with a cheap shell call first; a machine that answers is
   * a machine for which the SDK picture is live, and one that does not is the case worth saying no
   * to (null → "The screen could not be captured"), not worth dressing up as a picture.
   */
  try {
    const probe = await sandbox.commands.run("true", { timeoutMs: 15_000 });
    if (probe.exitCode !== 0) return null;
  } catch {
    return null;
  }

  try {
    const bytes = await sandbox.screenshot("bytes");
    if (!bytes || bytes.byteLength === 0) return null;
    const cursorPosition = await sandbox
      .getCursorPosition?.()
      .catch(() => undefined);
    return { data: toBase64(bytes), cursorPosition };
  } catch {
    return null;
  }
}

/** `scrot` geometry, which is `x,y+width+height` and not a rectangle. */
function geometry(region: {
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  return `${Math.round(region.x)},${Math.round(region.y)}+${Math.round(region.width)}+${Math.round(region.height)}`;
}

const TMP_PNG = "/tmp/remii-shot.png";
const TMP_JPG = "/tmp/remii-shot.jpg";

const ATSPI_DUMP_PATH = "/tmp/remii-atspi-dump.py";

/**
 * Walks AT-SPI and prints one JSON tree to stdout.
 *
 * Written into the sandbox on first use rather than baked into the prebuilt desktop template, so the
 * fast tree-based screen read works on a stock `desktop` image without a custom build. Kept small and
 * dependency-light: exactly `python3-pyatspi`, nothing else. Depth and breadth are capped because a
 * desktop tree is thousands of nodes deep and the model only acts on the named/interactive ones.
 */
const ATSPI_DUMP_SCRIPT = `
import json, sys
try:
    import pyatspi
except ImportError:
    print(json.dumps({"root": None, "error": "no-pyatspi"}))
    sys.exit(0)

MAX_DEPTH = 12
MAX_CHILDREN = 120

def node(acc, depth):
    if acc is None or depth > MAX_DEPTH:
        return None
    info = {}
    try: info["id"] = acc.get_id() if hasattr(acc, "get_id") else None
    except Exception: info["id"] = None
    try: info["role"] = acc.get_role_name()
    except Exception:
        try: info["role"] = acc.getRoleName()
        except Exception: info["role"] = None
    try:
        info["name"] = acc.name or ""
    except Exception:
        try: info["name"] = acc.get_name() or ""
        except Exception: info["name"] = ""
    try:
        comp = getattr(acc, "query_component", None) or getattr(acc, "queryComponent")
        comp = comp()
        try:
            extent = comp.get_extents(0)
            info["bounds"] = {"x": extent.x, "y": extent.y, "width": extent.width, "height": extent.height}
        except Exception:
            x, y = comp.get_position(0)
            w, h = comp.get_size()
            info["bounds"] = {"x": x, "y": y, "width": w, "height": h}
    except Exception:
        info["bounds"] = None
    try:
        value_iface = (getattr(acc, "query_value", None) or getattr(acc, "queryValue"))()
        info["value"] = str(value_iface.current_value)
    except Exception:
        info["value"] = None
    kids = []
    try:
        count = getattr(acc, "childCount", None)
        if count is None:
            count = acc.get_child_count()
        get_child = getattr(acc, "get_child_at_index", None) or getattr(acc, "getChildAtIndex")
        for i in range(min(count, MAX_CHILDREN)):
            child = node(get_child(i), depth + 1)
            if child is not None:
                kids.append(child)
    except Exception:
        pass
    info["children"] = kids
    return info

try:
    _registry = pyatspi.Registry
    _get_desktop = getattr(_registry, "get_desktop", None) or getattr(_registry, "getDesktop")
    desktop = _get_desktop(0)
    print(json.dumps({"root": node(desktop, 0)}))
except Exception as e:
    print(json.dumps({"root": None, "error": str(e)[:200]}))
`;

/**
 * AT-SPI readiness, cached per sandbox.
 *
 * `python3-pyatspi` is NOT in the prebuilt desktop template, so the first read probes the import and,
 * missing it, installs it once via apt (the sandboxes have egress — the reason this desktop runs E2B at
 * all). Cached so every subsequent `computer_screen` costs exactly one exec, not a probe plus an exec,
 * and so a failed install is remembered as "no tree" rather than retried on every turn.
 */
const atspiCache = new WeakMap<object, Promise<boolean>>();

async function ensureAtSpi(sandbox: E2BDesktopLike): Promise<boolean> {
  try {
    const probe = await sandbox.commands.run(
      `python3 -c "import pyatspi, websocket" 2>/dev/null`,
      { timeoutMs: 15_000 },
    );
    if (probe.exitCode === 0) return true;
  } catch {
    return false;
  }

  try {
    const install = await sandbox.commands.run(
      `apt-get update -qq && apt-get install -y -qq python3-pyatspi at-spi2-core python3-websocket 2>&1 | tail -1`,
      { timeoutMs: 120_000 },
    );
    const verify = await sandbox.commands.run(
      `python3 -c "import pyatspi, websocket" 2>/dev/null`,
      { timeoutMs: 15_000 },
    );
    return install.exitCode === 0 && verify.exitCode === 0;
  } catch {
    return false;
  }
}

function atSpiReady(sandbox: E2BDesktopLike): Promise<boolean> {
  const existing = atspiCache.get(sandbox as object);
  if (existing) return existing;
  const ready = ensureAtSpi(sandbox);
  atspiCache.set(sandbox as object, ready);
  return ready;
}

/** The live AT-SPI tree, or `{ root: null }` when the sandbox cannot produce one. */
async function getAccessibilityTree(
  sandbox: E2BDesktopLike,
): Promise<{ root?: unknown }> {
  try {
    if (!(await atSpiReady(sandbox))) return { root: null };
    await ensureSandboxScripts(sandbox);
    const result = await sandbox.commands.run(`python3 ${ATSPI_DUMP_PATH}`, {
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0 || !result.stdout.trim()) return { root: null };
    const parsed = JSON.parse(result.stdout) as { root?: unknown };
    return { root: parsed?.root ?? null };
  } catch {
    return { root: null };
  }
}

const DOM_DUMP_PATH = "/tmp/remii-dom.py";

/**
 * Reads Chromium's live DOM over the DevTools protocol and prints a bounded, text-first summary.
 *
 * Web pages are where screenshots are most expensive and most lossy: a form field list or a results
 * page is far cheaper as text than as pixels. Chromium already runs with `--remote-debugging-port=9222`
 * (see the launch line in the skills), so this is one exec through `computer_shell` and no image
 * tokens at all. It reports the endpoint's state rather than failing cryptically when no browser is
 * running or it was started without the debugging flag.
 */
const DOM_DUMP_SCRIPT = `
import json, sys, urllib.request

try:
    import websocket
except ImportError:
    print("websocket-client missing: apt-get install -y python3-websocket")
    sys.exit(0)

JS = r"""
(() => {
  const grab = (sel, map) => Array.from(document.querySelectorAll(sel)).slice(0, 60).map(map);
  return JSON.stringify({
    title: document.title,
    url: location.href,
    headings: grab("h1,h2,h3", h => h.innerText.trim()).filter(Boolean),
    buttons: grab("button,input[type=submit],a[role=button]", b => (b.innerText || b.value || b.getAttribute("aria-label") || "").trim()).filter(Boolean),
    links: grab("a[href]", a => a.innerText.trim()).filter(Boolean).slice(0, 40),
    fields: grab("input,textarea,select", f => ({
      name: f.name || f.id || "",
      type: f.type || f.tagName.toLowerCase(),
      value: f.type === "password" ? "" : (f.value || "").slice(0, 80),
      label: (document.querySelector("label[for='" + f.id + "']") || {}).innerText || f.getAttribute("aria-label") || "",
      placeholder: f.placeholder || "",
    })),
    text: (document.body && document.body.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 4000),
  });
})()
"""

try:
    targets = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json", timeout=5))
except Exception:
    print("No Chromium DevTools endpoint on 127.0.0.1:9222. Start Chromium with --remote-debugging-port=9222 --remote-allow-origins=*.")
    sys.exit(0)

page = next((t for t in targets if t.get("type") == "page"), None)
if not page:
    print("No open page target on the DevTools endpoint.")
    sys.exit(0)

try:
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=15)
    ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                        "params": {"expression": JS, "returnByValue": True}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == 1:
            break
    result = (((msg.get("result") or {}).get("result") or {}).get("value"))
    ws.close()
    print(result if isinstance(result, str) else json.dumps(result))
except Exception as e:
    print("DOM read failed: " + str(e))
`;

/** Best-effort: both helper scripts into the sandbox, once per sandbox. */
const scriptsCache = new WeakMap<object, Promise<void>>();

function ensureSandboxScripts(sandbox: E2BDesktopLike): Promise<void> {
  const existing = scriptsCache.get(sandbox as object);
  if (existing) return existing;
  const written = (async () => {
    try {
      await sandbox.files.write(ATSPI_DUMP_PATH, ATSPI_DUMP_SCRIPT);
      await sandbox.files.write(DOM_DUMP_PATH, DOM_DUMP_SCRIPT);
    } catch (error) {
      // Retry next time: a sandbox mid-provisioned momentarily refuses writes.
      scriptsCache.delete(sandbox as object);
      throw error;
    }
  })();
  scriptsCache.set(sandbox as object, written);
  return written.catch(() => undefined);
}

/**
 * Adapt an E2B desktop to the computer-use interface the tools expect.
 *
 * The mouse is composed from `moveMouse` + `mousePress` + `mouseRelease` rather than taken from E2B's
 * `leftClick` and friends, because the tools ask for a button and a double-click as data, and
 * decomposing that into moves and presses is what lets one implementation answer every case. The
 * `doubleClick` fast path is still used where it exists, because two presses in the same place is not
 * always what a double-click means to an application.
 */
export function computerUseFor(sandbox: E2BDesktopLike): DesktopComputerUse {
  const buttonFor = (button?: string): "left" | "right" | "middle" => {
    const normalised = button?.toLowerCase();
    if (normalised?.includes("right")) return "right";
    if (normalised?.includes("middle")) return "middle";
    return "left";
  };

  return {
    screenshot: {
      async takeCompressed(takeOptions?: Record<string, unknown>) {
        const shot = await captureScreenshot(sandbox, {
          ...(typeof takeOptions?.scale === "number"
            ? {
                width: Math.round(
                  MODEL_IMAGE_WIDTH *
                    Math.min(1, Math.max(0.1, takeOptions.scale)),
                ),
              }
            : {}),
        });
        return shot
          ? { screenshot: shot.data, cursorPosition: shot.cursorPosition }
          : {};
      },

      async takeCompressedRegion(region) {
        const shot = await captureScreenshot(sandbox, { region });
        return shot
          ? { screenshot: shot.data, cursorPosition: shot.cursorPosition }
          : {};
      },

      async takeFullScreen(showCursor = true) {
        /*
         * This is only about what the MODEL is shown.
         *
         * The person watching sees a live VNC stream in which noVNC draws the pointer itself and the
         * desktop's own pointer moves underneath, so nothing here concerns them. For the model the
         * pointer is in the picture, and `getCursorPosition` is reported alongside so it also has the
         * numbers.
         */
        const shot = await captureScreenshot(sandbox, {
          width: MODEL_IMAGE_WIDTH,
          showCursor,
        });
        return shot ? { screenshot: shot.data } : {};
      },
    },

    mouse: {
      async move(x, y) {
        await sandbox.moveMouse?.(Math.round(x), Math.round(y));
      },

      async click(x, y, button, double) {
        const target = buttonFor(button);
        const px = Math.round(x);
        const py = Math.round(y);
        if (double && target === "left") {
          await sandbox.doubleClick?.(px, py);
          return;
        }
        await sandbox.moveMouse?.(px, py);
        await sandbox.mousePress?.(target);
        await sandbox.mouseRelease?.(target);
      },

      async drag(startX, startY, endX, endY, button) {
        const target = buttonFor(button);
        await sandbox.moveMouse?.(Math.round(startX), Math.round(startY));
        await sandbox.mousePress?.(target);
        await sandbox.moveMouse?.(Math.round(endX), Math.round(endY));
        await sandbox.mouseRelease?.(target);
      },

      async scroll(x, y, direction, amount) {
        await sandbox.moveMouse?.(Math.round(x), Math.round(y));
        await sandbox.scroll?.(direction, amount);
      },
    },

    keyboard: {
      async type(text) {
        if (!text) return;
        // `write` is E2B's own typing, which chunks the text and paces it. Handing a whole string to
        // `press` would be read as one key name and type nothing.
        await (sandbox.write
          ? sandbox.write(text, { chunkSize: 25, delayInMs: 20 })
          : sandbox.press?.(text));
      },

      async press(key) {
        await sandbox.press?.(normaliseKey(key));
      },

      async hotkey(keys) {
        await sandbox.press?.(normaliseKey(keys));
      },
    },

    display: {
      async getInfo() {
        const size = await sandbox.getScreenSize();
        return {
          displays: [
            {
              width: size.width,
              height: size.height,
              isActive: true,
            },
          ],
        };
      },

      async getWindows() {
        // `wmctrl -lG` answers with `id desktop x y w h host title`, which is the one shape that has
        // geometry in it. `xdotool search` alone gives ids and titles but no position, and a window
        // list without geometry is not usable for clicking anything.
        const result = await sandbox.commands
          .run("wmctrl -lG 2>/dev/null || echo NO_WMCTRL", {
            timeoutMs: 15_000,
          })
          .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
        if (result.stdout.includes("NO_WMCTRL")) return { windows: [] };

        return {
          /*
           * `wmctrl -lG` answers `id desktop x y w h hostname title`, so the title starts at field
           * SEVEN. Slicing from six put the hostname in front of it — "host Chromium" rather than
           * "Chromium" — which reads as a window titled by the machine and defeats any lookup by
           * title.
           */
          windows: result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const parts = line.split(/\s+/);
              return {
                // `wmctrl` prints the id in hex (`0x001`), so it is parsed rather than cast: `Number`
                // on "0x001" is 1, which is a real window id but not the one wmctrl will accept back.
                id: parts[0]?.startsWith("0x")
                  ? Number.parseInt(parts[0], 16) || undefined
                  : Number(parts[0]) || undefined,
                x: Number(parts[2]) || undefined,
                y: Number(parts[3]) || undefined,
                width: Number(parts[4]) || undefined,
                height: Number(parts[5]) || undefined,
                title: parts.slice(7).join(" ") || line,
              };
            }),
        };
      },
    },

    /*
     * THE ACCESSIBILITY TREE, NOW WIRED.
     *
     * E2B's SDK exposes no AT-SPI, so the tree is dumped in-sandbox by `python3-pyatspi` over
     * `sandbox.commands.run` — one exec round trip, and no screenshot tokens for the common read. The
     * dependency is lazily apt-installed and cached, so the prebuilt template stays prebuilt and a
     * sandbox that cannot install it degrades to `{ root: null }`, which `desktop-tools` already
     * reports as "tree unavailable; here is the window list" rather than crashing.
     */
    accessibility: {
      async getTree() {
        return getAccessibilityTree(sandbox);
      },
    },
  };
}

/**
 * A key name E2B's `press` will accept.
 *
 * The tools speak browser-style names — `Enter`, `ArrowLeft`, `Backspace` — and E2B speaks xdotool's,
 * where they are `Return`, `Left`, `BackSpace`. Passing a browser name straight through types nothing
 * and reports success, which is the worst combination available: a Bot pressing Enter to submit a form
 * and being told it worked.
 *
 * A name already in xdotool's vocabulary is left alone, so a caller who knows the platform can use it.
 */
export function normaliseKey(key: string): string {
  const aliases: Record<string, string> = {
    enter: "Return",
    return: "Return",
    esc: "Escape",
    escape: "Escape",
    del: "Delete",
    delete: "Delete",
    backspace: "BackSpace",
    tab: "Tab",
    space: "space",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    arrowup: "Up",
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right",
    pageup: "Prior",
    pagedown: "Next",
    home: "Home",
    end: "End",
    " ": "space",
  };

  // Hotkeys arrive as `ctrl+s` or `Cmd+Shift+K`. Only the last segment is a key name; the modifiers
  // are already spelled the way xdotool wants them.
  const segments = key.split("+").filter(Boolean);
  if (segments.length === 0) return key;
  const mapped = segments.map((segment, index) => {
    const isLast = index === segments.length - 1;
    const lower = segment.toLowerCase();
    // A modifier segment is a modifier whatever its capitalisation, so `Ctrl` is not corrected to
    // some key named `ctrl` and then typed.
    if (
      !isLast &&
      [
        "ctrl",
        "control",
        "alt",
        "shift",
        "meta",
        "cmd",
        "super",
        "win",
      ].includes(lower)
    ) {
      return lower === "cmd" ? "super" : lower === "control" ? "ctrl" : lower;
    }
    return aliases[lower] ?? segment;
  });
  return mapped.join("+");
}

/**
 * Adapt an E2B desktop to the machine interface.
 *
 * Paths are resolved against {@link WORKSPACE_DIR} rather than left to whatever the sandbox's working
 * directory happens to be. The tools describe paths as relative (`notes.md`) because that is what a
 * person would say, and an API that silently resolved them against a directory nobody chose is a Bot
 * writing to the wrong place and reporting success.
 *
 * An absolute path is honoured as given. That is not a hole: the tools are offered to one Bot on one
 * machine, it can already run a shell command with any path it likes, and pretending otherwise would
 * only mean the two disagreed.
 *
 * `exec` resolves a non-zero exit as a successful call carrying that code, because "the command ran and
 * said no" is the answer the caller asked for. Throwing would make a grep that found nothing look like
 * a fault, and a Bot handed a fault retries or gives up.
 */
export function machineFor(sandbox: E2BDesktopLike): DesktopMachine {
  return {
    async exec(command, cwd, env, timeoutSeconds) {
      // Awaited here rather than in a closure, because every path below needs it and resolving it once
      // per call is what the cache above is for.
      const workspace = await workspaceFor(sandbox);
      const result = await sandbox.commands.run(command, {
        cwd: cwd ? makeResolve(workspace)(cwd) : workspace,
        ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1000 } : {}),
        ...(env && Object.keys(env).length > 0 ? { envs: env } : {}),
      });
      /*
       * stdout and stderr are concatenated, because a Bot that piped a command's output to a file and
       * read the diagnostic instead of the result is a Bot debugging its own tooling. Reporting only
       * stdout is how "permission denied" became an empty string and looked like silence.
       */
      const stdout = [result.stdout, result.stderr]
        .filter((part) => typeof part === "string" && part.length > 0)
        .join("\n");
      return { exitCode: result.exitCode, stdout };
    },

    async readFile(path) {
      const bytes = await sandbox.files.read(
        makeResolve(await workspaceFor(sandbox))(path),
      );
      return Buffer.from(bytes).toString("utf8");
    },

    async writeFile(path, contents) {
      await sandbox.files.write(
        makeResolve(await workspaceFor(sandbox))(path),
        contents,
      );
    },

    async listFiles(path): Promise<DesktopFileInfo[]> {
      const workspace = await workspaceFor(sandbox);
      const root = makeResolve(workspace);
      const entries = await sandbox.files.list(root(path));
      return entries.map((entry) => {
        // E2B's entry carries the full path but not always the bare name, so the name is the last
        // segment of whatever path is there. An entry with neither is passed through as an empty name
        // rather than dropped: a listing that quietly loses the one entry it could not describe is
        // worse than one that shows an entry with nothing in it.
        const entryPath = entry.path ?? entry.name ?? "";
        const name =
          entry.name ?? entryPath.split("/").filter(Boolean).pop() ?? "";
        return {
          name,
          path: entryPath.startsWith("/") ? entryPath : root(entryPath),
          isDirectory: entry.type === "dir",
          ...(typeof entry.size === "number" ? { size: entry.size } : {}),
        } as DesktopFileInfo;
      });
    },
  };
}
