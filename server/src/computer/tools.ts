import { z } from "zod";
import type { GrantedTool } from "../plugins/tools";
import {
  ElementNotFoundError,
  HumanHasControlError,
  StaleSnapshotError,
} from "./client";
import {
  type ActionActor,
  ActionRefusedError,
  type ComputerGateway,
} from "./gateway";

/**
 * THE COMPUTER, AS TOOLS A BOT CAN CALL.
 *
 * The gateway was always reachable — by the app's live screen, over signed-in HTTP — and never by a
 * model. Nothing joined the two: `COMPUTER_TOOLS` was declared in `schema.ts` and referenced nowhere,
 * the eleven names existed only as policy keys and audit action strings, and the tool list a run is
 * given was assembled from granted skills, the Remi set, Composio search and batch, and the
 * escalation tool. A Bot was told it had "real hands" and a "real web browser the person can watch"
 * and was offered none of them.
 *
 * So the whole capability was unreachable by the only party that needs it, and the gap was invisible:
 * no test failed, no error was logged, and the conversation just said the Bot had no browser. The
 * prompt describing a capability that does not exist is worse than silence, because the model
 * believes it and then reports the absence — and reaches for a familiar story to explain it.
 *
 * Every method here is already governed. `govern()` wraps each one inside the gateway, so the action
 * policy, the audit trail, the target guard and the per-(user, Bot) computer lookup are all decided
 * below this file and are not re-implemented or second-guessed here. Wrapping is deliberately thin:
 * a second policy decision would be a second answer to the same question.
 */

/** The tools a run is offered, and what each one is for. */
export type ComputerToolsOptions = {
  gateway: ComputerGateway;
  /** Whose computer this run is driving. Every gateway call takes it; none of them may omit it. */
  actor: ActionActor;
  /** The Bot whose computer this is, and the Bot a refusal names. */
  botId: string;
  /**
   * Told when this Bot asks a person to take the wheel, so the roster can say so.
   *
   * The request is stored on the computer and audited, and neither of those is visible to somebody
   * who is not already looking at the screen. So a Bot could block on a QR code indefinitely and the
   * only sign of it was a dot on a channel nobody had open — the same silence the activity row for a
   * live run exists to prevent, and the same silence that had this reported as a missing capability.
   *
   * No run id is passed, because tools are resolved per Bot rather than per run and there is no run
   * context to read one from. The open run for this person is the run that is asking, so the caller
   * looks it up rather than being handed a guess.
   */
  onHelpRequested?: (input: { reason: string }) => void | Promise<void>;
  /**
   * Offer the shell, which this deployment's isolation has made safe.
   *
   * A shell is confined by its WORKING DIRECTORY and nothing else — not by a jail. `bash` will
   * `cd ..`, and the file tools' refusal of `..` does not reach a command line. So the question is
   * never "is this shell contained" but "who else is on this machine", and the answer is decided by
   * the provider rather than by anything here:
   *
   *   - one computer per Bot: the container is the boundary, and a Bot's shell is in its own kernel,
   *     filesystem and volume. Contained.
   *   - one shared computer: only reachable at all when the deployment has asserted a single tenant,
   *     because that is the one condition the provider refuses without. So every Bot's shell is on
   *     the one machine belonging to the one person who owns them all.
   *
   * `false` is therefore a refusal to run a shell where neither answer holds — a shared computer on a
   * deployment that may serve more than one person, which cannot currently be configured, and is
   * wired so that it stays refused if that ever changes.
   */
  allowShell: boolean;
};

/**
 * A refusal, said as something the model can act on rather than as a stack trace.
 *
 * These are the errors a Bot will hit repeatedly and on purpose — a page it is not allowed to open, a
 * ref from a page that has moved on, a person currently holding the wheel. Each one has a next step
 * the model can take, and that step is what belongs in the answer. A thrown `Error` reaching the
 * provider instead spends the turn on a string with no action in it.
 */
function refusalOf(error: unknown): string | null {
  if (error instanceof ActionRefusedError) {
    return `Refused by this deployment's boundaries: ${error.message}`;
  }
  if (error instanceof StaleSnapshotError) {
    return `The page moved since that snapshot was taken, so those refs are no longer valid. Take a fresh computer_snapshot and read the refs again. (${error.message})`;
  }
  if (error instanceof ElementNotFoundError) {
    return `No element with that ref is on the page. Take a fresh computer_snapshot and use a ref it lists. (${error.message})`;
  }
  if (error instanceof HumanHasControlError) {
    /*
     * The one a model most needs in the right shape. A person is holding the browser because the Bot
     * asked them to, so "a person has control" is not a failure to retry around — it is the answer
     * to the Bot's own request, and the next move is to wait.
     */
    return `A person has control of the browser right now, which is what you asked for when you called computer_request_help. Do not retry. Wait for it to be handed back, then carry on. (${error.message})`;
  }
  return null;
}

/*
 * NOTE THE ONE SIGNATURE DIFFERENCE IN THIS FILE.
 *
 * Eight of these calls take an `ActionActor` and are wrapped in the gateway's `govern()`, so the
 * action policy, the audit trail and the target guard all apply. `read` and `snapshot` take a bare
 * actor id instead, because they change nothing: reading a page the Bot has already been allowed to
 * open, or describing the controls on it, is not a new decision. That asymmetry is the gateway's and
 * is deliberate — see `COMPUTER_ACTING_TOOLS` in `schema.ts` — so it is called out here rather than
 * left to look like a mistake to be tidied away.
 */

/** Run a governed gateway call and render the outcome, turning every refusal into advice. */
async function act<T>(
  what: string,
  call: () => Promise<T>,
  render: (result: T) => string,
): Promise<string> {
  try {
    return render(await call());
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal) return refusal;
    // Anything else is a real fault — no computer, stopped container, a transport failure. The
    // message is the model's only clue, and it is not secret, so it is passed on rather than hidden.
    return `${what} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The page's own words, cut to something a model can hold in context. */
function pageText(text: string, limit = 4000): string {
  const trimmed = text.trim();
  return trimmed.length <= limit
    ? trimmed
    : `${trimmed.slice(0, limit)}\n[truncated — ${trimmed.length - limit} more characters]`;
}

const target = {
  ref: z
    .string()
    .describe("An element ref from computer_snapshot. Never construct one."),
  snapshotId: z
    .number()
    .int()
    .describe(
      "The snapshotId from the computer_snapshot that produced this ref.",
    ),
};

export function computerToolsFor(options: ComputerToolsOptions): GrantedTool[] {
  const { gateway, actor, botId } = options;

  const tool = (
    name: string,
    description: string,
    parameters: z.ZodType,
    execute: (args: Record<string, never>) => Promise<string>,
  ): GrantedTool => ({
    name,
    description,
    parameters,
    ref: `computer/${name}`,
    // Navigation writes (it changes where the Bot is), everything else is a read of the workspace or
    // the page. Recorded so a tool list can be read at a glance; the gateway decides the real policy.
    effect: name === "computer_navigate" ? "write" : "read",
    execute: async (args: unknown) =>
      execute((args ?? {}) as Record<string, never>),
  });

  return [
    tool(
      "computer_navigate",
      "Open a page in this Bot's own browser and return its readable text. This is the way to reach anything on the web: a site with no connected app can still be opened and read here. The person can watch it live. Returns the page's text, not an image.",
      z.object({
        url: z.string().describe("The address to open, including the scheme."),
      }),
      async (args) => {
        const url = String((args as { url?: unknown }).url ?? "").trim();
        if (!url) return "Give an address to open.";
        return act(
          "Opening the page",
          () => gateway.navigate(botId, actor, url),
          (result) =>
            `Opened ${result.url} — ${result.title || "(no title)"}\n\n${pageText(result.text)}`,
        );
      },
    ),

    tool(
      "computer_read",
      "Re-read the page already open, as text. Use after something changed on it, rather than navigating again.",
      z.object({}),
      async () =>
        act(
          "Reading the page",
          () => gateway.read(botId, actor.id),
          (result) =>
            `${result.url} — ${result.title || "(no title)"}\n\n${pageText(result.text)}`,
        ),
    ),

    tool(
      "computer_snapshot",
      "List the things on the current page you can act on — buttons, links, fields — each with an opaque ref. Call this before clicking or typing and use the refs it gives you. Refs are only valid for the snapshotId it returns; if the page re-renders, take a new snapshot.",
      z.object({}),
      async () =>
        act(
          "Snapshotting the page",
          () => gateway.snapshot(botId, actor.id),
          (result) => {
            const lines = [
              `${result.url} — ${result.title || "(no title)"}`,
              `snapshotId: ${result.snapshotId}`,
              "",
            ];
            for (const element of result.elements) {
              const label = element.name ? ` "${element.name}"` : "";
              lines.push(`[${element.ref}] ${element.role}${label}`);
            }
            if (result.truncated) {
              lines.push(
                "",
                "More interactive elements exist than are listed here.",
              );
            }
            if (result.elements.length === 0) {
              lines.push("Nothing on this page is clickable or typeable.");
            }
            return lines.join("\n");
          },
        ),
    ),

    tool(
      "computer_click",
      "Click one thing on the page, named by a ref from computer_snapshot.",
      z.object(target),
      async (args) => {
        const a = args as { ref?: unknown; snapshotId?: unknown };
        return act(
          "Clicking",
          () =>
            gateway.click(botId, actor, {
              ref: String(a.ref ?? ""),
              snapshotId: Number(a.snapshotId),
            }),
          () => "Clicked.",
        );
      },
    ),

    tool(
      "computer_type",
      "Type into one field, named by a ref from computer_snapshot. Set submit to press Enter afterwards, which is how a single-field form is submitted.",
      z.object({
        ...target,
        text: z.string().describe("What to type into the field."),
        submit: z
          .boolean()
          .optional()
          .describe("Press Enter after typing, to submit the form."),
      }),
      async (args) => {
        const a = args as {
          ref?: unknown;
          snapshotId?: unknown;
          text?: unknown;
          submit?: unknown;
        };
        return act(
          "Typing",
          () =>
            gateway.type(botId, actor, {
              ref: String(a.ref ?? ""),
              snapshotId: Number(a.snapshotId),
              text: String(a.text ?? ""),
              ...(a.submit === true ? { submit: true } : {}),
            }),
          () => (a.submit === true ? "Typed and submitted." : "Typed."),
        );
      },
    ),

    tool(
      "computer_key",
      "Press one key, such as Enter, Tab, Escape, or an arrow. Name a ref first to press a key inside that field.",
      z.object({
        key: z.string().describe("The key to press, such as Enter or Escape."),
        ref: z
          .string()
          .optional()
          .describe("A ref from computer_snapshot, to focus a field first."),
        snapshotId: z
          .number()
          .int()
          .optional()
          .describe("The snapshot that produced that ref."),
      }),
      async (args) => {
        const a = args as {
          key?: unknown;
          ref?: unknown;
          snapshotId?: unknown;
        };
        return act(
          "Pressing a key",
          () =>
            gateway.key(botId, actor, {
              key: String(a.key ?? ""),
              ...(a.ref ? { ref: String(a.ref) } : {}),
              ...(a.snapshotId === undefined
                ? {}
                : { snapshotId: Number(a.snapshotId) }),
            }),
          () => `Pressed ${String(a.key ?? "")}.`,
        );
      },
    ),

    tool(
      "computer_scroll",
      "Scroll the page. Omit the amount to scroll down a screen.",
      z.object({
        deltaY: z
          .number()
          .optional()
          .describe("Pixels to scroll. Negative scrolls up."),
      }),
      async (args) => {
        const a = args as { deltaY?: unknown };
        return act(
          "Scrolling",
          () =>
            gateway.scroll(
              botId,
              actor,
              a.deltaY === undefined ? {} : { deltaY: Number(a.deltaY) },
            ),
          () => "Scrolled.",
        );
      },
    ),

    tool(
      "computer_read_file",
      "Read a file from this Bot's own workspace — the files it has saved, which outlive any one run.",
      z.object({
        path: z
          .string()
          .describe("A path inside the workspace, relative to its root."),
      }),
      async (args) => {
        const path = String((args as { path?: unknown }).path ?? "").trim();
        return act(
          "Reading the file",
          () => gateway.readFile(botId, actor, { path }),
          (result) =>
            `${result.path} (${result.bytes} bytes${result.truncated ? ", truncated" : ""})\n\n${result.text}`,
        );
      },
    ),

    tool(
      "computer_write_file",
      "Save a file to this Bot's own workspace, so it survives the run and can be handed to the person later. Save anything they will need to read; a file is the durable form of an answer.",
      z.object({
        path: z
          .string()
          .describe("A path inside the workspace, relative to its root."),
        contents: z.string().describe("What to write."),
        append: z.boolean().optional().describe("Append instead of replacing."),
      }),
      async (args) => {
        const a = args as {
          path?: unknown;
          contents?: unknown;
          append?: unknown;
        };
        return act(
          "Writing the file",
          () =>
            gateway.writeFile(botId, actor, {
              path: String(a.path ?? ""),
              contents: String(a.contents ?? ""),
              ...(a.append === true ? { append: true } : {}),
            }),
          (result) => `Saved ${result.path} (${result.bytes} bytes).`,
        );
      },
    ),

    tool(
      "computer_list_files",
      "List what is in this Bot's workspace, or in one folder of it.",
      z.object({
        path: z.string().optional().describe("A folder inside the workspace."),
      }),
      async (args) => {
        const path = (args as { path?: unknown }).path;
        return act(
          "Listing the folder",
          () =>
            gateway.listFiles(botId, actor, path ? { path: String(path) } : {}),
          (result) =>
            result.entries.length === 0
              ? `${result.path} is empty.`
              : result.entries
                  .map((entry) =>
                    entry.kind === "folder"
                      ? `${entry.path}/`
                      : `${entry.path} (${entry.bytes ?? 0} bytes)`,
                  )
                  .join("\n"),
        );
      },
    ),

    ...(options.allowShell
      ? [
          /*
           * THE SHELL, AND WHY IT IS THE LAST TOOL IN THIS LIST.
           *
           * A shell is not a bigger browser tool; it is a different kind of thing. Everything above reads
           * and writes through methods the gateway already governs one action at a time, where a refusal is
           * a decision about a named URL or a named file. This runs whatever string it is given.
           *
           * It is exposed because the person asked for a coworker that can work, and on one computer a
           * coworker that cannot install a tool or look at a log is a coworker that reports a wall as a
           * finding. What keeps that from being a hole rather than a feature:
           *
           *   - it is governed like every other action, so the policy decides and the audit records it;
           *   - the shell's working directory is the Bot's OWN workspace, so on one shared computer this
           *     is a per-Bot sandbox rather than a whole machine;
           *   - the computer confines the workspace, so `..` out of it is refused there and not here.
           *
           * What it is NOT is bounded to this Bot's own files by anything in this file. A command can
           * read the machine it runs on. That is a materially larger capability than a browser and it
           * deserves its own review, which is why it is the last tool rather than the first.
           */
          tool(
            "computer_run_command",
            "Run one shell command inside this Bot's own computer, in this Bot's own workspace. Use it for work a browser cannot do: installing a tool, reading a log, running a script. Anything the command writes lands in your workspace and survives. The person can see what you run.",
            z.object({
              command: z
                .string()
                .describe("The command to run, as you would type it."),
              timeoutMs: z
                .number()
                .int()
                .optional()
                .describe(
                  "How long to allow. The computer caps this on its own.",
                ),
            }),
            async (args) => {
              const a = args as { command?: unknown; timeoutMs?: unknown };
              const command = String(a.command ?? "").trim();
              if (!command) return "Give a command to run.";
              return act(
                "Running the command",
                () =>
                  gateway.runCommand(botId, actor, {
                    command,
                    ...(a.timeoutMs === undefined
                      ? {}
                      : { timeoutMs: Number(a.timeoutMs) }),
                  }),
                (result) =>
                  [
                    result.exitCode === 0 ? null : `Exited ${result.exitCode}.`,
                    result.stdout?.trim()
                      ? `stdout:\n${result.stdout.trim()}`
                      : null,
                    result.stderr?.trim()
                      ? `stderr:\n${result.stderr.trim()}`
                      : null,
                    !result.stdout?.trim() && !result.stderr?.trim()
                      ? "No output."
                      : null,
                  ]
                    .filter(Boolean)
                    .join("\n"),
              );
            },
          ),
        ]
      : []),

    tool(
      "computer_request_help",
      "Ask the person to take control of your browser, because something only they can do is in the way — a sign-in, a QR code, a CAPTCHA, an approval. Say exactly what you need done. They take the wheel, do that part, and hand it back; then you continue in the same session. Call this INSTEAD of telling them in prose to sign in and let you know, and do not retry while you wait.",
      z.object({
        reason: z
          .string()
          .describe(
            "What you need the person to do, in one sentence. They see this verbatim.",
          ),
      }),
      async (args) => {
        const reason = String(
          (args as { reason?: unknown }).reason ?? "",
        ).trim();
        const said = reason || "The assistant needs a person to continue.";
        const answer = await act(
          "Asking for help",
          () => gateway.requestHelp(botId, actor, said),
          (state) =>
            state.requested
              ? "Asked. The person can take the wheel now. Wait — do not retry — and carry on when it is handed back."
              : "A person already has control. Carry on.",
        );
        // Only on a request that actually landed. A refusal, or a Bot that already had the wheel,
        // is not a Bot that needs anybody, and marking it as one would be a false signal in the
        // roster — which is the exact failure this was added to stop.
        if (answer.startsWith("Asked.")) {
          await options.onHelpRequested?.({ reason: said });
        }
        return answer;
      },
    ),
  ];
}
