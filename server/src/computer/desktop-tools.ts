/**
 * What the AI can do on a real desktop.
 *
 * NOT THE BROWSER TOOLS. Those navigate a URL and read a document; a desktop has neither. It has a
 * screen, a pointer, a keyboard and a shell, so the tool set is built from those and the reasoning
 * is different: the AI is not fetching a page, it is working a machine.
 *
 * THE ACCESSIBILITY TREE IS THE POINT. Without it the AI could click pixels it cannot see and would
 * be guessing. The accessibility tree covers the live AT-SPI tree, so `computer_screen` returns what is actually
 * on the screen — window titles, buttons, fields, their roles — as text. That is what makes this
 * usable rather than a blind interface, and it is why no image is required for the AI to know
 * whether its click worked.
 *
 * Coordinates come from that tree. A node's bounds are in the same space as a screenshot, so a
 * click lands where the AI was looking. Nothing here assumes 1024x768: the geometry is read from
 * the running desktop, which is set per machine and recorded on the row.
 */
import { z } from "zod";
import type { DesktopComputerUse, DesktopMachine } from "./desktop-stream";
import { HUMAN_HAS_CONTROL } from "./user-computers";

export type DesktopToolsOptions = {
  /**
   * Resolve the user's computer, or answer why there isn't one.
   *
   * Asked per call rather than captured once, because a tool set is built per Bot while the
   * computer is per PERSON and is stopped and started underneath. A captured handle would be a
   * sandbox that a stop had invalidated, and every later call would fail on an id nobody chose.
   */
  resolve: () => Promise<{
    computerUse: DesktopComputerUse;
    machine?: DesktopMachine;
    /**
     * The desktop's own pixel width, when the row has been measured.
     *
     * Carried rather than read off `computerUse` because reading it is a remote round trip and this
     * is needed on EVERY screenshot — the scale a picture is taken at is decided by the desktop's
     * width, and asking for that width separately is how a screenshot tool ends up costing twice what
     * it should. Absent on a machine whose geometry has not been recorded yet, which costs one
     * full-resolution picture and nothing worse.
     */
    displayWidth?: number;
    displayHeight?: number;
  } | null>;
  /** Whose turn this is. Recorded on the human-control refusals so a refusal can be explained. */
  actor: { id: string; userId?: string };
  botId: string;
  onHelpRequested?: (input: { reason: string }) => void | Promise<void>;
  /**
   * Ask a person for one value the Bot must not be told.
   *
   * Returns a promise for the answer, which is the ONLY place a typed value ever appears — see
   * `desktop-secrets.ts`, which deliberately cannot store one. Implemented here rather than inline in
   * the tool so this module has no opinion about how long a request lives or who may supersede it.
   */
  requestSecret?: (label: string) => {
    answered: Promise<string | null>;
    superseded: boolean;
  };
  /**
   * Who has the wheel, read fresh on every call.
   *
   * A function and not a value, on purpose: the person takes the wheel while the Bot is mid-turn,
   * and a value captured when these tools were built cannot see that happen.
   */
  controlHolder?: () => Promise<"bot" | "human" | null>;
  /**
   * Called the first time a turn actually touches the machine, and again when it stops.
   *
   * A collaborator rather than a database handle, because metering is a billing concern and this module
   * has no business with money. Never awaited by the tools: a metering write must not be able to fail a
   * turn, and a missed opening is a few cents against a plan's whole month.
   */
  onSessionStart?: () => void | Promise<void>;
  onSessionEnd?: (reason: "idle" | "quota" | "person") => void | Promise<void>;
  /**
   * How long one stretch of use may run, in minutes.
   *
   * A CEILING rather than a target, and the reason it is here rather than in the provisioner is that
   * this is the only place that knows a turn is in progress. A run still making progress is never cut
   * off — but nothing can hold a machine awake for hours by nudging it every few minutes, and the
   * twenty-minute cap in the guidance is the number Remii is told about, so the two agree.
   *
   * Absent disables the ceiling, which is what a deployment with no plan does.
   */
  maxSessionMinutes?: number;
  /**
   * Whether this person may have the computer at all right now.
   *
   * Asked per call rather than captured, because the allowance is a fact about this second: a person
   * who is out of computer time must be told by the tool call that refused, in a sentence they can
   * read, and not by a machine that mysteriously does not answer.
   */
  mayUseComputer?: () => Promise<
    { allowed: true } | { allowed: false; reason: string }
  >;
};

/**
 * The reading tools are exempt from the wheel; the acting ones are not.
 *
 * A Bot that cannot see the screen while a person is driving it is not a Bot that is being polite,
 * it is a Bot that is blind, and it would sit there guessing. What it cannot do is move the mouse.
 */
/**
 * How long this tool waits for a person before giving up, and why it is not the store's own deadline.
 *
 * The store keeps a request alive for five minutes, which is generous for a human. The agent loop's
 * tool timeout is shorter than that, so waiting the full five would have the turn killed by the loop
 * while this promise was still legitimately pending — and the failure a model sees for that is a bare
 * timeout naming neither the request nor the person. Ninety seconds is long enough for somebody to
 * notice a box and type a code, and short enough that the turn ends with a sentence instead of dying.
 */
const SECRET_ASK_TIMEOUT_MS = 90_000;

const READ_ONLY_TOOLS = new Set([
  "computer_screen",
  "computer_screenshot",
  "computer_read_file",
  /*
   * A person reaches into the machine here, not the Bot — the value is typed by them and the Bot is
   * refused it. So this does NOT obey the wheel the way every other acting tool does, because refusing
   * it because someone had taken the wheel would block the exact case where it is needed most: a Bot
   * stuck at a login, asking for the password, while the person who has the wheel is right there.
   */
  "computer_request_secret",
  /*
   * A person reaches into the machine here, not the Bot — the value is typed by them and the Bot is
   * refused it. So this does NOT obey the wheel the way every other acting tool does.
   */
  "computer_request_secret",
  "computer_list_files",
]);

/**
 * How much of a file or a command's output comes back.
 *
 * Not decoration: an unbounded answer is a model's whole context spent, or a 400KB file dumped into a
 * transcript, and the Bot that asked for it cannot tell a truncation from a complete answer. So every
 * one of these says when it cut something off, and the model is told to narrow the query rather than
 * to retry the same call.
 */
const MAX_OUTPUT_CHARS = 20_000;
const MAX_LIST_ENTRIES = 200;

/** Trim to the cap and say so, because a truncated answer that looks whole is worse than a long one. */
function bounded(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const kept = text.slice(0, limit);
  return `${kept}\n\n[truncated at ${limit} characters — ${text.length - limit} more. Narrow the query rather than repeating this one.]`;
}

/**
 * The same shape every other granted tool has, imported rather than restated.
 *
 * A local copy of this type looked harmless and was not: it had no `ref` and a looser `execute`,
 * so the compiler happily accepted a tool the runtime would then reject at the point the model was
 * offered it. One type, imported, is the only way that cannot happen.
 */
type GrantedTool = import("../plugins/tools").GrantedTool;
type ToolResult = import("../plugins/tools").ToolResult;

/**
 * How wide a screenshot sent to the model is.
 *
 * THE COST OF A PICTURE IS ITS AREA, NOT ITS FILE SIZE, and this is the one number that decides
 * whether the desktop is usable. An image is billed as tiles over the pixels, so a 1920x1080 PNG is
 * ~1,650 tokens and a 1920x1080 JPEG at quality 95 is the same order — while at 1280 wide it is
 * roughly a third of that, and at 1024 it is a quarter. The old call used `takeFullScreen`, which is
 * a lossless PNG at native resolution: the largest, most expensive shape available, thrown away
 * immediately.
 *
 * 1280 is the number to use. It is wide enough that a browser toolbar, a form field and its label are
 * all legible at the sizes people actually build at, and `computer_zoom` exists for the case where
 * they are not — which is a far better trade than paying for 1,650 tokens to look at a toolbar.
 */
const MODEL_IMAGE_WIDTH = 1280;

/**
 * The scale a screenshot should be taken at for the model.
 *
 * Derived from the desktop's own width rather than hardcoded, because the provider bills an image by
 * its AREA: a deployment that raises `VNC_RESOLUTION_WIDTH` to 2560 would otherwise make every
 * screenshot 78% more expensive with nothing on screen having changed. The width comes off the
 * desktop itself, and the row's recorded geometry is the fallback when a call cannot measure it.
 *
 * Never above 1. Scaling up throws away detail and buys tokens; there is no resolution at which a
 * smaller-than-native picture is the better picture.
 */
export function modelImageScale(nativeWidth?: number): number {
  const native = Number(nativeWidth);
  if (!Number.isFinite(native) || native <= 0) return 1;
  return native <= MODEL_IMAGE_WIDTH
    ? 1
    : Number((MODEL_IMAGE_WIDTH / native).toFixed(4));
}

/** A node from the accessibility tree, with the fields a Bot acts on. */
type TreeNode = {
  id?: string;
  role?: string;
  name?: string;
  bounds?: { x?: number; y?: number; width?: number; height?: number };
  value?: string;
  children?: TreeNode[];
};

function flatten(
  node: TreeNode | undefined,
  out: TreeNode[] = [],
  depth = 0,
): TreeNode[] {
  if (!node || depth > 12) return out;
  // Only nodes that can be named or acted on. A desktop tree is thousands of nodes deep, and
  // "a nameless generic container" is not something a Bot can do anything with.
  if (node.name || node.role) out.push(node);
  for (const child of node.children ?? []) flatten(child, out, depth + 1);
  return out;
}

/**
 * The screen as text, which is the only form the AI can reliably act on.
 *
 * Bounded, because a full XFCE desktop is a lot of nodes and an unbounded answer would be mostly
 * panel furniture. Interactive roles are preferred and the rest is dropped, so what comes back is
 * the things worth clicking.
 */
function describeScreen(tree: { root?: TreeNode } | null | undefined): string {
  const nodes = flatten(tree?.root);
  const interactive = new Set([
    "push button",
    "button",
    "link",
    "text",
    "entry",
    "password text",
    "combo box",
    "check box",
    "radio button",
    "menu item",
    "list item",
    "toggle button",
    "slider",
    "spin button",
    "tab",
    "tree item",
  ]);
  const useful = nodes.filter(
    (node) =>
      interactive.has(String(node.role ?? "").toLowerCase()) || node.name,
  );
  const shown = useful.slice(0, 60);
  if (shown.length === 0) {
    return `The desktop is running with nothing named on it. ${nodes.length} nodes were on screen, none of them interactive or labelled.`;
  }
  return shown
    .map((node, index) => {
      const b = node.bounds ?? {};
      const at =
        b.width && b.height
          ? ` [x=${Math.round(b.x ?? 0)} y=${Math.round(b.y ?? 0)} ${Math.round(b.width)}x${Math.round(b.height)}]`
          : "";
      const value = node.value ? ` = ${String(node.value).slice(0, 60)}` : "";
      return `${index}. ${node.role ?? "?"} "${String(node.name ?? "").slice(0, 80)}"${at}${value}`;
    })
    .join("\n");
}

export function desktopToolsFor(options: DesktopToolsOptions): GrantedTool[] {
  const withComputer = async <T>(
    toolName: string,
    work: (
      computerUse: DesktopComputerUse,
      display: { width?: number; height?: number },
    ) => Promise<T>,
    render: (result: T) => ToolResult,
  ): Promise<ToolResult> => {
    /*
     * The wheel, checked before anything touches the desktop.
     *
     * The check is a fresh read rather than a cached value, because the other side of it is a person
     * in a browser, and a flag read when these tools were built would be wrong the moment they took
     * over. And the refusal is a SENTENCE, not just a stop: a Bot told "refused" retries or gives
     * up; one told a person has the computer waits, and says what it was about to do.
     */
    const holder = await options.controlHolder?.();
    if (holder === "human" && !READ_ONLY_TOOLS.has(toolName)) {
      return HUMAN_HAS_CONTROL;
    }
    /*
     * The allowance, before anything is touched.
     *
     * Ahead of the resolve and ahead of the wheel, because a person who is out of allowance must not be
     * made to wait out a 90-second start to be told no — and because the sentence comes from billing,
     * where the reset time is known, rather than from a machine that simply never answers.
     *
     * Fails OPEN. A failed read of somebody's own allowance must not take their computer away: the
     * worst case is a turn that costs a few cents more than it should have, and the alternative is a
     * person who paid for a computer being told they may not use it because a query timed out.
     */
    const permitted = await options.mayUseComputer?.().catch(() => null);
    if (permitted && permitted.allowed === false) return permitted.reason;

    const computer = await options.resolve();
    if (!computer) {
      return "This computer is not running. It may have been stopped; start it and try again.";
    }

    /*
     * The ceiling, measured on the session rather than on the call.
     *
     * Only acting tools count, because a run that keeps LOOKING without touching anything is not
     * costing the clock anything worth stopping — and a Bot cut off mid-investigation is a Bot that
     * reports a failure it caused itself.
     */
    if (!READ_ONLY_TOOLS.has(toolName) && options.maxSessionMinutes) {
      const runningSince = sessionStartedAt.get(options.botId);
      if (
        runningSince !== undefined &&
        Date.now() - runningSince > options.maxSessionMinutes * 60_000
      ) {
        await Promise.resolve(options.onSessionEnd?.("quota")).catch(
          () => undefined,
        );
        sessionStartedAt.delete(options.botId);
        return `You have been using this computer for more than ${options.maxSessionMinutes} minutes, so I have switched it off for you. Anything you have saved is still on disk — tell me what you were doing and we can start again.`;
      }
    }

    markSessionStart();
    return render(
      await work(computer.computerUse, {
        width: computer.displayWidth,
        height: computer.displayHeight,
      }),
    );
  };

  /**
   * The same shape, for the machine's own API rather than its screen.
   *
   * Split from `withComputer` because the wheel does not govern these. A person holding the wheel is
   * driving the mouse and the keyboard; a file the Bot writes while that happens is not something the
   * person can see or is about to lose, and refusing it would break the ordinary case of someone
   * watching a screen while a report gets saved. The refusal rule belongs to anything that moves the
   * pointer, which is what `withComputer` is for.
   *
   * `machine` is optional on the resolved handle, so a deployment whose sandbox cannot reach its own
   * filesystem still gets the screen tools and a sentence saying so, rather than a tool that throws.
   */
  const withMachine = async <T>(
    toolName: string,
    work: (machine: DesktopMachine) => Promise<T>,
    render: (result: T) => string,
  ): Promise<string> => {
    const computer = await options.resolve();
    if (!computer) {
      return "This computer is not running. It may have been stopped; start it and try again.";
    }
    if (!computer.machine) {
      return `This computer cannot reach its own files or run commands, so ${toolName} is unavailable here. Use computer_screen to work with what is on the screen instead.`;
    }
    markSessionStart();
    return render(await work(computer.machine));
  };

  /**
   * When this Bot's current stretch of use began, for the session ceiling.
   *
   * A module-level map rather than a field on the options, because the options object is rebuilt for
   * every turn and a stamp stored on it would be gone before the ceiling could read it.
   *
   * Keyed by Bot, so two people using the same deployment never share a clock. A stamp is written the
   * first time a Bot acts and never refreshed, which is the point: this measures a stretch of work, and
   * a stretch that kept restarting itself would never end.
   */
  const sessionStartedAt = new Map<string, number>();
  const markSessionStart = () => {
    if (!sessionStartedAt.has(options.botId)) {
      sessionStartedAt.set(options.botId, Date.now());
      void Promise.resolve(options.onSessionStart?.()).catch(() => undefined);
    }
  };

  const tool = (
    name: string,
    description: string,
    parameters: z.ZodType,
    execute: (args: unknown) => Promise<ToolResult>,
  ): GrantedTool => ({
    name,
    description,
    parameters,
    // A desktop tool drives the deployment's own computer, the same as the browser tools, and is
    // named the same way. `ref` is what a grant and a skill match on, so it has to be real and has
    // to be stable — a tool that cannot be granted is a tool nobody can withhold.
    ref: `computer/${name}`,
    effect: READ_ONLY_TOOLS.has(name) ? "read" : "write",
    execute,
  });

  return [
    tool(
      "computer_screen",
      "Look at the desktop and see what is on it: every window, button, field and menu, with the coordinates each occupies. This is how you know what to click — call it before acting rather than guessing at positions. Returns text, not an image.",
      z.object({}),
      async () =>
        withComputer(
          "computer_screen",
          async (cu) => {
            const tree = (await cu.accessibility
              ?.getTree?.()
              .catch(() => null)) as { root?: TreeNode } | null | undefined;
            /*
             * The window list as well as the tree.
             *
             * On a freshly booted desktop the tree is nearly empty — an XFCE panel and a window
             * manager and little else — so a Bot told to look at the screen would be told there is
             * nothing there even with three applications open. The window list is the one place
             * that reliably says what is actually open, so it is reported alongside rather than
             * instead: it answers "what is running", the tree answers "what can I press".
             */
            const windows = (await cu.display.getWindows().catch(() => null)) as
              | {
                  windows?: {
                    id?: number;
                    title?: string;
                    isActive?: boolean;
                  }[];
                }
              | null
              | undefined;
            return { tree: tree ?? null, windows: windows?.windows ?? [] };
          },
          ({
            tree,
            windows,
          }: {
            tree: { root?: TreeNode } | null;
            windows: { title?: string; isActive?: boolean }[];
          }) => {
            const open = windows.filter((w) => w.title);
            const header = open.length
              ? `Open windows: ${open
                  .map((w) => `"${w.title}"${w.isActive ? " (focused)" : ""}`)
                  .join(", ")}\n\n`
              : "No windows are open.\n\n";
            return header + describeScreen(tree);
          },
        ),
    ),

    tool(
      "computer_screenshot",
      "Take a picture of the whole screen and LOOK at it. Use this only when computer_screen's tree has no names for what you need — a chart, a colour, an error dialog, a layout, text you need to read. Computer_screen gives you names and coordinates for free; this costs tokens. After an action that changes the screen, only take another one when the tree could not tell you whether it worked.",
      z.object({
        region: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
          })
          .optional()
          .describe(
            "Optional rectangle of the screen to photograph, in the same coordinates as computer_screen. Use it to read small text instead of taking the whole screen: the same pixels cost far fewer tokens zoomed in.",
          ),
      }),
      async (args) => {
        const region = (
          args as {
            region?: { x: number; y: number; width: number; height: number };
          }
        ).region;
        return withComputer(
          "computer_screenshot",
          async (cu, display) => {
            /*
             * JPEG, scaled, cursor on.
             *
             * This is the change that made the desktop usable. The old call took a lossless
             * `takeFullScreen` PNG at native 1920x1080, measured the base64 to print a KB figure, and
             * returned the figure. The model was told a picture existed and was given none, so the
             * only way it could learn anything was the AT-SPI tree — which on XFCE is a panel, a
             * window manager, and whatever one application happens to expose. It was not "bad at
             * using a computer", it was blind.
             *
             * `scale` is the other half. Daytona's `scale` multiplies the native resolution, and the
             * provider bills an image by its AREA, so a native 1920-wide PNG is ~1,650 tokens versus
             * ~550 here. Legibility of a toolbar is unaffected; that is what the `region` argument is
             * for, and a crop costs a fraction of re-sending the whole screen.
             *
             * The cursor is included on purpose: a Bot that cannot see where the pointer is cannot
             * tell a hover state from a click, and hover is how menus open.
             */
            const options = {
              format: "jpeg",
              quality: 60,
              showCursor: true,
              ...(region ? {} : { scale: modelImageScale(display.width) }),
            };
            /*
             * A region on an SDK without `takeCompressedRegion` degrades to the whole screen rather
             * than throwing. Losing the crop costs tokens; losing the tool costs the Bot the ability
             * to see at all, and that is a much worse trade to make on a version difference.
             */
            const crop = cu.screenshot.takeCompressedRegion;
            const shot =
              region && crop
                ? await crop.call(cu.screenshot, region, options)
                : await cu.screenshot.takeCompressed(options);
            return {
              data: shot?.screenshot ?? "",
              cursor: shot?.cursorPosition ?? null,
              cropped: Boolean(region) && Boolean(crop),
            };
          },
          ({ data, cursor, cropped }): ToolResult => {
            if (!data) return "The screen could not be captured.";
            const size = Math.round((data.length * 3) / 4 / 1024);
            const where =
              region && cropped
                ? `the region ${Math.round(region.width)}x${Math.round(region.height)} at ${Math.round(region.x)}, ${Math.round(region.y)}`
                : region
                  ? "the whole screen (this build cannot crop, so the region was not applied)"
                  : "the whole screen";
            return {
              text:
                `Here is ${where}, as it is right now (${size} KB JPEG).` +
                (cursor
                  ? ` The mouse pointer is at ${cursor.x}, ${cursor.y}.`
                  : "") +
                " Look at it before deciding what to click next — these are the desktop's real coordinates.",
              images: [{ data, mimeType: "image/jpeg" }],
            };
          },
        );
      },
    ),

    tool(
      "computer_click",
      "Click somewhere on the screen. Give the x and y from computer_screen — they are the same coordinates the screen is drawn at, so a click lands on what the tree named there.",
      z.object({
        x: z.number().describe("Horizontal position, from computer_screen."),
        y: z.number().describe("Vertical position, from computer_screen."),
        button: z
          .enum(["left", "right", "middle"])
          .optional()
          .describe("Defaults to left."),
        double: z.boolean().optional().describe("Click twice at once."),
      }),
      async (args) => {
        const { x, y, button, double } = args as {
          x: number;
          y: number;
          button?: string;
          double?: boolean;
        };
        return withComputer(
          "computer_click",
          async (cu) => {
            /*
             * ONE call, not two.
             *
             * This used to `await cu.mouse.move(x, y)` and then `await cu.mouse.click(x, y)`. Each
             * of those is a round trip to the sandbox — a real HTTP call to a remote machine — so
             * every click cost two, and the Bot's most frequent action paid double latency for a
             * move the click performs anyway. `click` takes coordinates and moves there itself.
             *
             * The hover problem is now solved by the pointer being visible in the screenshot instead,
             * which is strictly better: it is one fact rather than a second action the model has to
             * remember to take and cannot verify.
             */
            await cu.mouse.click(x, y, button ?? "left", double === true);
            return true;
          },
          () =>
            `Clicked at ${Math.round(x)}, ${Math.round(y)}. Look at the screen to check what happened.`,
        );
      },
    ),

    tool(
      "computer_drag",
      "Press at one point, drag and release at another. Use it to move a window, scroll a slider, resize something, or select a range of text. Cheaper and steadier than clicking and holding.",
      z.object({
        fromX: z.number().describe("Where to press, from computer_screen."),
        fromY: z.number().describe("Where to press, from computer_screen."),
        toX: z.number().describe("Where to release."),
        toY: z.number().describe("Where to release."),
        button: z
          .enum(["left", "right", "middle"])
          .optional()
          .describe("Defaults to left."),
      }),
      async (args) => {
        const { fromX, fromY, toX, toY, button } = args as {
          fromX: number;
          fromY: number;
          toX: number;
          toY: number;
          button?: string;
        };
        return withComputer(
          "computer_drag",
          async (cu) => {
            if (typeof cu.mouse.drag === "function") {
              await cu.mouse.drag(fromX, fromY, toX, toY, button ?? "left");
              return true;
            }
            /*
             * The synthesised version, for an SDK without `drag`.
             *
             * Four sequential calls, so this path is slower and can leave a button held if it fails
             * partway — but it is still better than refusing, because without it there is no way to
             * move a window at all.
             */
            await cu.mouse.move(fromX, fromY);
            await cu.mouse.click(fromX, fromY, button ?? "left");
            await cu.mouse.move(toX, toY);
            await cu.mouse.click(toX, toY, button ?? "left");
            return true;
          },
          () =>
            `Dragged from ${Math.round(fromX)}, ${Math.round(fromY)} to ${Math.round(toX)}, ${Math.round(toY)}.`,
        );
      },
    ),

    tool(
      "computer_type",
      "Type text into whatever currently has focus. Click the field first. To press Enter or Tab, use computer_key instead. Newlines type Return, so a multi-line paste works.",
      z.object({ text: z.string().describe("The text to type.") }),
      async (args) => {
        const { text } = args as { text: string };
        return withComputer(
          "computer_type",
          async (cu) => {
            /*
             * Typed as one block, at the SDK's fastest sane rate.
             *
             * Passing an explicit `delay` of 0 rather than omitting it: the default is Daytona's,
             * which is a per-character delay chosen to look like a human, and a Bot pasting a 40
             * character URL paid 40 human-speed intervals for it. Zero still produces real key events
             * — autofill, key handlers and form validation all see them — it just does not pause
             * between them.
             */
            await cu.keyboard.type(text, 0);
            return text.length;
          },
          (n) => `Typed ${n} characters.`,
        );
      },
    ),

    tool(
      "computer_key",
      "Press one key or a combination — Enter, Tab, Escape, ctrl+s, alt+F4. Use this for anything typing cannot produce.",
      z.object({
        keys: z.string().describe("For example Enter, Tab, Escape, ctrl+s."),
      }),
      async (args) => {
        const { keys } = args as { keys: string };
        return withComputer(
          "computer_key",
          async (cu) => {
            await cu.keyboard.hotkey(keys);
            return keys;
          },
          (k) => `Pressed ${k}.`,
        );
      },
    ),

    tool(
      "computer_scroll",
      "Scroll the window under a point.",
      z.object({
        x: z.number().describe("Where to scroll."),
        y: z.number().describe("Where to scroll."),
        amount: z
          .number()
          .describe("Notches down. Use a negative number to scroll up."),
      }),
      async (args) => {
        const { x, y, amount } = args as {
          x: number;
          y: number;
          amount: number;
        };
        return withComputer(
          "computer_scroll",
          async (cu) => {
            await cu.mouse.scroll(
              x,
              y,
              amount < 0 ? "up" : "down",
              Math.max(1, Math.round(Math.abs(amount))),
            );
            return true;
          },
          () => `Scrolled ${amount > 0 ? "down" : "up"}.`,
        );
      },
    ),

    tool(
      "computer_request_help",
      "Ask the person to take over the computer. Use this when you are stopped by something only they can do — a sign-in, a password, a code on their phone, a payment, a CAPTCHA — and say exactly what you need done. They watch your screen, take the wheel, do that part, and hand it back.",
      z.object({
        reason: z
          .string()
          .describe("What you need them to do, in one sentence."),
      }),
      async (args) => {
        const { reason } = args as { reason: string };
        await options.onHelpRequested?.({ reason });
        return "Asked. They will see your screen and can take over.";
      },
    ),

    /*
     * ONE VALUE THE BOT MUST NOT BE TOLD, typed by a person into whatever has focus.
     *
     * The prompt named this tool for the length of a computer's existence and nothing implemented it,
     * so a Bot that reached for it was offered a tool that could not run — the same shape of failure as
     * a dead route, and the reason the header comment on `shared/bot-prompt.ts` says every tool named
     * in it is registered. This is that tool, against the machine that exists.
     *
     * It is a WEAPON in the wrong hands if the value ever comes back, so it does not: the person's
     * browser POSTs the value to the server, the server types it into the focused field with
     * `keyboard.type`, and the model is told only that a person entered it. The value exists in the
     * form and in the keystrokes, and nowhere else — see `desktop-secrets.ts`, which is deliberately
     * incapable of holding it.
     *
     * Read-only by the wheel's rules, because it moves the pointer's target without the person driving:
     * this is a person reaching into the machine, not the Bot, and refusing it because someone had taken
     * the wheel would block the exact case where it is needed most.
     */
    tool(
      "computer_request_secret",
      "Ask the person to type ONE value you must not be told: a password, a one-time code, a card number. Focus the field first with computer_click, then call this with a short label for what you need. They type it into a masked box which goes straight into the focused field. You will never see the value. Prefer this over a full takeover when you only need one field filled in; the value is only TYPED, so submit the form yourself afterwards.",
      z.object({
        label: z
          .string()
          .describe(
            "What you need, in a few words, e.g. 'the code sent to your phone'",
          ),
      }),
      async (args) => {
        const { label } = args as { label: string };
        if (!options.requestSecret) {
          return "This deployment cannot ask you for a value, so there is nowhere to put one. Ask the person to do it themselves by taking the wheel.";
        }
        const computer = await options.resolve();
        if (!computer) {
          return "This computer is not running, so there is no field to type into. Ask the person to start it.";
        }
        const { answered, superseded } = options.requestSecret(label);

        /*
         * Awaited, because the model cannot be told what happened until it has — and bounded by
         * `SECRET_ASK_TIMEOUT_MS`, which is SHORTER than the request's own lifetime on purpose.
         *
         * Those are two different deadlines and conflating them is how this becomes a hung turn: the
         * store will happily keep a request alive for minutes, but the agent loop's tool timeout is
         * shorter than that, so a person who walks away would have the turn killed underneath a
         * promise that was still legitimately waiting. This gives up first, and says so, so the model
         * gets a sentence and the turn ends cleanly instead of dying with a timeout that names
         * nothing.
         *
         * `value` is the thing a person typed. It is in scope for exactly the lines below, is never
         * logged, never stored, never rendered and never returned — and the sentence the model gets
         * says only whether it arrived.
         */
        /*
         * Three outcomes, not two, and told apart as a tagged result rather than by comparing a value
         * against a sentinel.
         *
         * "Nobody answered in time" and "the person closed the box" are both "no value", and collapsing
         * them would tell a Bot whose box someone DELIBERATELY closed the same thing as one whose box
         * was ignored — the first is a decision the person made, the second is something that happened.
         * The person deserves to be distinguishable from a timeout in what the model is told, and a
         * string comparison against a magic value is not a way to express that.
         */
        const answer = await Promise.race([
          answered.then((value) =>
            value === null
              ? ({ kind: "cancelled" } as const)
              : ({ kind: "typed", value } as const),
          ),
          Bun.sleep(SECRET_ASK_TIMEOUT_MS).then(
            () => ({ kind: "timeout" }) as const,
          ),
        ]);
        if (superseded) {
          return "Your earlier request was replaced by a newer one before an answer arrived, so nothing was typed. Ask again if you still need it.";
        }
        if (answer.kind === "timeout") {
          return "Nobody entered it before the wait ran out, so nothing was typed. Do not ask for it another way, and do not guess.";
        }
        if (answer.kind === "cancelled") {
          return "The request was cancelled and nothing was typed. Do not ask for it another way, and do not guess.";
        }
        const typed = await computer.computerUse.keyboard
          .type(answer.value, 0)
          .then(() => true)
          .catch(() => false);
        return typed
          ? "The person entered it and it has been typed into the field. You were not told what it is. Continue from here — if the form needs submitting, do that yourself."
          : "The value arrived but could not be typed into the field. Tell the person, and do not ask for it another way.";
      },
    ),

    /*
     * The machine's own API. Faster than the screen for anything that is really a file or a command,
     * and the model is told which is which — see the guidance.
     */

    tool(
      "computer_shell",
      "Run a shell command on this computer and get its output. Use this instead of opening a terminal window on screen: it is one call instead of several screen round trips, and it returns the text directly. The exit code is part of the answer — a command that found nothing still succeeded at running.",
      z.object({
        command: z
          .string()
          .describe("The command line to run, e.g. `ls -la` or `git status`."),
        cwd: z
          .string()
          .optional()
          .describe(
            "Directory to run it in. Relative to the workspace. Omit for the default.",
          ),
      }),
      async (args) => {
        const { command, cwd } = args as { command: string; cwd?: string };
        return withMachine(
          "computer_shell",
          (machine) => machine.exec(command, cwd ?? undefined, undefined, 120),
          ({ exitCode, stdout }) =>
            stdout.trim()
              ? `${bounded(stdout)}\n(exit ${exitCode})`
              : `The command ran and printed nothing. (exit ${exitCode})`,
        );
      },
    ),

    tool(
      "computer_list_files",
      "List what is in a directory on this computer. Use this rather than opening a file manager, and always use it before claiming a file does not exist — this is how you find out what is really there.",
      z.object({
        path: z
          .string()
          .optional()
          .describe("Directory to list. Defaults to your workspace."),
      }),
      async (args) => {
        const { path } = args as { path?: string };
        return withMachine(
          "computer_list_files",
          (machine) => machine.listFiles(path ?? "."),
          (entries) => {
            if (entries.length === 0) return "That directory is empty.";
            const shown = entries.slice(0, MAX_LIST_ENTRIES);
            const lines = shown.map(
              (entry) => `${entry.isDirectory ? "d" : "-"} ${entry.path}`,
            );
            const hidden = entries.length - shown.length;
            return bounded(
              `${lines.join("\n")}${hidden > 0 ? `\n[${hidden} more entries not shown]` : ""}`,
              8_000,
            );
          },
        );
      },
    ),

    tool(
      "computer_read_file",
      "Read a file from this computer and get its contents as text. Much faster and more reliable than opening it on screen. If it says the file does not exist, that is a real answer — do not retry, list the directory instead.",
      z.object({
        path: z
          .string()
          .describe(
            "The file to read, relative to your workspace, e.g. notes.md",
          ),
      }),
      async (args) => {
        const { path } = args as { path: string };
        return withMachine(
          "computer_read_file",
          (machine) => machine.readFile(path),
          (contents) => contents,
        );
      },
    ),

    tool(
      "computer_write_file",
      "Save text to a file on this computer, creating or replacing it. Use this to keep anything worth having later — a report, notes, a result — rather than only saying it in the conversation.",
      z.object({
        path: z
          .string()
          .describe(
            "The file to write, relative to your workspace, e.g. report.md",
          ),
        contents: z.string().describe("The full text to save."),
      }),
      async (args) => {
        const { path, contents } = args as { path: string; contents: string };
        return withMachine(
          "computer_write_file",
          async (machine) => {
            await machine.writeFile(path, contents);
            return path;
          },
          (saved) =>
            `Saved ${saved} (${contents.length} characters). Read it back with computer_read_file if you need to check it.`,
        );
      },
    ),

    tool(
      "computer_navigate",
      "Open a web address in the browser on this computer and tell you what the page shows. " +
        "Returns the page's labelled elements with their coordinates, which is cheaper than a " +
        "picture and enough to decide what to click; to see the page as it looks, call " +
        "computer_screen instead. To then DO something, use computer_click with the coordinates " +
        "from either. IMPORTANT: this types into whichever browser window is already open, so if " +
        "no browser is open this does nothing and says so — start one first, with computer_shell " +
        "(`DISPLAY=:0 nohup chromium --no-sandbox --disable-gpu --remote-debugging-port=9222 --remote-allow-origins=* about:blank &`).",
      z.object({
        url: z.string().describe("The full address, including https://"),
      }),
      async (args) => {
        const { url } = args as { url: string };
        if (!/^https?:\/\//i.test(url)) {
          return `That is not a web address: ${url}. Give the whole thing, including https://.`;
        }
        return withComputer(
          "computer_navigate",
          async (cu, display) => {
            /*
             * Whether there is a browser to type into, asked BEFORE typing rather than inferred
             * afterwards.
             *
             * `ctrl+l` focuses the address bar of a window that is already running. On a bare XFCE
             * desktop there is no such window, the keystrokes go nowhere, and the tool returns a
             * screen description of an empty desktop — which reads exactly like a page that failed
             * to load, so the caller concludes the site is down and goes looking for another way to
             * open it. Asking first turns a silent no-op into a sentence naming the cause.
             */
            const before = (await cu.display.getWindows().catch(() => null)) as
              | { windows?: { title?: string }[] }
              | null
              | undefined;
            const openTitles = (before?.windows ?? [])
              .map((w) => w.title)
              .filter((t): t is string => Boolean(t));
            const browserOpen = openTitles.some((title) =>
              /chrom|firefox|brave|edge|safari/i.test(title),
            );
            if (!browserOpen) {
              return {
                screen:
                  `No browser is open on this computer, so ${url} was not opened — there is no ` +
                  "address bar to type into. Open one first, then call this again: " +
                  "computer_shell with " +
                  "`DISPLAY=:0 nohup chromium --no-sandbox --disable-gpu --remote-debugging-port=9222 --remote-allow-origins=* about:blank &`",
                titles: openTitles,
                navigated: false as const,
              };
            }

            // Focus the address bar, replace whatever was in it, go. Chromium and Firefox both take
            // ctrl+l for this, which is why this is a hotkey rather than a click on a coordinate that
            // would be different on every window size.
            await cu.keyboard.hotkey("ctrl+l");
            await cu.keyboard.type(url, 0);
            await cu.keyboard.press("Return");
            /*
             * The page has to arrive before there is anything to read.
             *
             * Polling this tightly and briefly rather than sleeping long and once: the old shape was
             * three sleeps of 2s, so the worst case was 6s of dead time before the model was told
             * anything, most of it spent waiting after the page had already painted. 600ms x 5 is
             * three seconds of budget with four chances to notice, and a cached page returns on the
             * first one. `describeScreen` is not the emptiness test — it returns a non-empty sentence
             * even for a blank desktop — so the node count is what decides.
             */
            let tree = await readTree(cu);
            for (let attempt = 0; attempt < 5; attempt += 1) {
              if (countNodes(tree) > 0) break;
              await Bun.sleep(600);
              tree = await readTree(cu);
            }
            const windows = await readWindows(cu);
            /*
             * The page, photographed.
             *
             * Navigating and then being handed a text tree was the old contract, and it is the
             * reason `computer_navigate` felt broken: the Bot asked for a page, was told its window
             * titles, and had no idea whether the site had loaded, redirected, or shown a paywall.
             * The picture is the answer to the question that was actually asked, and it arrives on
             * the same call rather than costing another round trip for `computer_screenshot`.
             */
            const shot = await cu.screenshot
              .takeCompressed({
                format: "jpeg",
                quality: 60,
                showCursor: true,
                scale: modelImageScale(display.width),
              })
              .catch(() => null);
            return {
              screen: describeScreen(tree),
              titles: (windows?.windows ?? [])
                .map((w) => w.title)
                .filter((t): t is string => Boolean(t)),
              navigated: true as const,
              image: shot?.screenshot ?? "",
            };
          },
          ({ screen, titles, navigated, image }): ToolResult => {
            if (!navigated) return screen;
            const header = titles.length
              ? `Open windows: ${titles.join(", ")}\n\n`
              : "";
            const body = `${header}${screen}`;
            if (!image) return body;
            return {
              text: `${body}\n\nThat is the page as it loaded. Look at it before clicking anything on it.`,
              images: [{ data: image, mimeType: "image/jpeg" }],
            };
          },
        );
      },
    ),
  ];
}

/** The accessibility tree, or null when the desktop cannot produce one. */
const readTree = async (
  cu: DesktopComputerUse,
): Promise<{ root?: TreeNode } | null> =>
  ((await cu.accessibility?.getTree?.().catch(() => null)) as
    | { root?: TreeNode }
    | null
    | undefined) ?? null;

/** The open windows, or null when they cannot be listed. */
const readWindows = async (
  cu: DesktopComputerUse,
): Promise<{ windows?: { title?: string; isActive?: boolean }[] } | null> =>
  (await cu.display.getWindows().catch(() => null)) ?? null;

/**
 * How many nodes are on the tree at all.
 *
 * Used to tell "the page has not drawn yet" from "the page is genuinely empty". Without it the
 * retry above has to compare a rendered description against prose, which cannot distinguish an
 * unloaded document from a blank one.
 */
function countNodes(tree: { root?: TreeNode } | null): number {
  return tree ? flatten(tree.root).length : 0;
}
