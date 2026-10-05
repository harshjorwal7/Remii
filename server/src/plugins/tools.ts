import { z } from "zod";
import type { AuditInitiator } from "../audit";
import type { ResultBudgetClass } from "./result-budget";
import type { SelectableSkill } from "./selection";
import {
  isDeploymentFault,
  PluginInvalidArgumentsError,
  PluginRefusedError,
  type PluginStore,
} from "./store";

/**
 * The tools a Bot may call, as the runtime's own tool definitions, executed on the server.
 *
 * The loop used to run in the browser: every MCP tool was registered with `useFrontendTool` and its
 * handler posted back to `/api/plugins/call`. That made a browser a hard requirement for a Bot to do
 * anything, which rules out an embedded widget, a run nobody is watching, and any surface that is
 * not our own app.
 *
 * Nothing about governance moves with it. `callTool` is still the only path to a vendor: it checks
 * the grant, evaluates the policy, writes the audit row, and only then calls out. This module hands
 * the model a description of what it may call; the store remains what decides whether a call happens.
 *
 * Read at run time rather than captured, so a grant an administrator adds or revokes applies to the
 * next run rather than after a restart.
 */
/**
 * What a refused call answers with.
 *
 * The transcript draws a refusal differently from a result, and it has only the tool's answer to go
 * on. Guessing from the wording would break the first time an administrator rephrased a policy
 * message, so the answer says which it is. The model reads this too, and "Refused." in front of a
 * reason is what it should be told anyway.
 */
export const REFUSAL_MARKER = "Refused.";

/**
 * What a model is told a vendor answered: its result as written, or its error named as one.
 *
 * `isError` used to be dropped, and it cost a diagnosis. Google refused the Drive MCP server with
 * `isError: true` and the text "The caller does not have permission"; the model received that as an
 * ordinary result, believed it, and told the person it had no access to their Drive — which read as
 * the Bot being confused rather than as the vendor refusing.
 *
 * The prefix is the vendor's, and says so. It is deliberately NOT `REFUSAL_MARKER`: that one means
 * this deployment declined, and the transcript draws it as a boundary holding. A vendor saying no is
 * a different fact with a different fix, and collapsing the two would make a misconfigured connector
 * look like a policy working correctly.
 *
 * One function for both doors to one store — {@link grantedTools} for a Bot running here, and
 * `/api/agent-tools/call` for a Bot running its own loop — because the second answered with the bare
 * text, and neither framework Bot words an `isError` answer on its way through. Which door a Bot
 * arrives at is a deployment topology decision, not a decision about what its model is told.
 */
export function vendorAnswer(result: { text: string; isError: boolean }) {
  return result.isError
    ? `The vendor reported an error: ${result.text}`
    : result.text;
}

const workbenchCodeParameters = z.object({
  code: z.string().min(1).max(200_000),
});

const sandboxCommandParameters = z.object({
  command: z.string().min(1).max(20_000),
});

function workbenchTools(
  workbench: NonNullable<PluginStore["workbench"]>,
  actorId: string,
): GrantedTool[] {
  const run = async (
    toolSlug: "COMPOSIO_REMOTE_WORKBENCH" | "COMPOSIO_REMOTE_BASH_TOOL",
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const result = await workbench.execute({
      userId: actorId,
      toolSlug,
      args,
      signal,
    });
    signal?.throwIfAborted();
    return typeof result === "string" ? result : JSON.stringify(result);
  };

  return [
    {
      name: "composio_workbench",
      ref: "bot/composio_workbench",
      description:
        "Use the user's preconnected Composio sandbox to write and run Python that can call the user's connected apps. This is the Composio workbench, not a general computer shell.",
      parameters: workbenchCodeParameters,
      effect: "write",
      execute: async (args, signal) => {
        const parsed = workbenchCodeParameters.safeParse(args);
        if (!parsed.success)
          return "Provide non-empty Python code for the Composio workbench.";
        try {
          return await run(
            "COMPOSIO_REMOTE_WORKBENCH",
            { code_to_execute: parsed.data.code },
            signal,
          );
        } catch (error) {
          return `The Composio workbench could not run that code: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
    {
      name: "composio_sandbox_bash",
      ref: "bot/composio_sandbox_bash",
      description:
        "Run one shell command in the user's preconnected Composio sandbox. Use only when the task needs sandbox shell execution.",
      parameters: sandboxCommandParameters,
      effect: "write",
      execute: async (args, signal) => {
        const parsed = sandboxCommandParameters.safeParse(args);
        if (!parsed.success)
          return "Provide one non-empty command for the Composio sandbox.";
        try {
          return await run(
            "COMPOSIO_REMOTE_BASH_TOOL",
            { command: parsed.data.command },
            signal,
          );
        } catch (error) {
          return `The Composio sandbox could not run that command: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
  ];
}

/**
 * One image a tool wants the model to actually look at.
 *
 * `data` is raw base64 with no `data:` prefix and no newlines. The prefix is added at the one place
 * that builds a provider URL, so a tool that gets it wrong produces a provider error naming the URL
 * rather than a silently blank image the model then describes as "a grey rectangle".
 *
 * Base64 is carried rather than a URL because there is nowhere to put a URL. A desktop screenshot
 * exists only inside a Daytona sandbox that the model cannot fetch from, so the bytes have to travel
 * in the message or not travel at all — which is the whole reason this type exists.
 */
export type ToolImage = {
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
};

/**
 * A tool answer that carries pictures as well as words.
 *
 * WHY THIS EXISTS, because returning a string was not a limitation anybody chose.
 *
 * The desktop had a tool called `computer_screenshot` whose whole result was
 * `Screenshot taken (412 KB as a PNG).` — it fetched a full-screen PNG, measured the base64 length,
 * and threw the pixels away. The model was told a picture had been taken and was never sent one, so
 * the only way it could learn what a window said was the AT-SPI tree, which on an XFCE desktop is
 * nearly empty, capped at 60 nodes, and describes controls by role rather than by what they look
 * like. That is not "the model is bad at computers"; that is the model being blind and told it had
 * just looked at something.
 *
 * A string-only channel cannot be fixed from inside a tool, so the channel itself is widened here.
 * Everything that already returns a string still does — this is a union, not a replacement — and
 * every consumer that reads a tool result has to keep working with the string arm.
 */
export type ToolResult =
  | string
  | {
      /** What the tool says. Always present: a picture with no sentence is not an answer. */
      text: string;
      images?: ToolImage[];
    };

/**
 * Narrow a tool answer to the plain text, which is what the transcript and every event carries.
 *
 * The images are deliberately NOT part of it. A full-screen JPEG is ~150KB of base64; putting one
 * in a `TOOL_CALL_RESULT` event means every observer of a run — the transcript, the SSE stream, a
 * reconnecting client replaying history — pays to carry a picture nobody is drawing. The model gets
 * the pixels in its context, where they are the point; the transcript gets the sentence, which is
 * where the human reads.
 */
export function toolResultText(result: ToolResult): string {
  return typeof result === "string" ? result : result.text;
}

export type GrantedTool = {
  name: string;
  description: string;
  parameters: z.ZodType;
  /**
   * `<serverId>/<toolName>`, carried alongside the name the model is offered.
   *
   * The two spellings exist because a model tool name may not contain a slash, and selection has to
   * compare a tool against what a skill declared, which is written in the ref spelling because that
   * is how a grant is written. Carried rather than derived at the comparison, so there is one place
   * the two forms are converted (`toolNameFor`) and no second parser to drift from it.
   */
  ref: string;
  /**
   * How much of this tool's result a model is shown. See {@link ResultBudgetClass}.
   *
   * Declared here rather than inferred at the cut, because the answer's SIZE is what decides it and
   * size is what this tool's vendor is: a screen tool returns what our own machine printed, a
   * connected app returns somebody's mailbox, and one number for both was cutting the mailbox to
   * the size of a screen reading. Absent means the screen bound, which is the one that was always
   * applied and the one every desktop tool was written against.
   */
  resultBudget?: ResultBudgetClass;
  effect?: "read" | "write";
  execute: (args: unknown, signal?: AbortSignal) => Promise<ToolResult>;
};

/**
 * A vendor's JSON Schema as something the model can be handed.
 *
 * Anything that is not an object schema describes something other than a tool's arguments, and a
 * schema we cannot read must not stop the tool being offered: an open object lets the model call it
 * and lets the vendor be the one to reject a bad argument, which is where that error belongs.
 */
export function parametersFor(inputSchema: Record<string, unknown>): z.ZodType {
  try {
    const converted = z.fromJSONSchema(inputSchema as never);
    if (converted instanceof z.ZodObject) return converted;
  } catch {}
  return z.object({}).catchall(z.unknown());
}

/*
 * THE CONVERSION IS MEMOISED, keyed by the schema OBJECT rather than by a hash of it.
 *
 * The grant row's schema object is re-read from a five-minute cache (`SERVERS_TTL_MS`), which means
 * the same object arrives on most requests, and `z.fromJSONSchema` over a sixty-tool catalogue is a
 * real cost paid for every run that shares it. A hash would have to walk the whole schema to produce
 * the key, which is the work it exists to avoid; the object identity is ready, and a WeakMap drops
 * the entry the moment the grant cache replaces the object rather than leaking it into later ones.
 */
const zodBySchema = new WeakMap<Record<string, unknown>, z.ZodType>();

export function parametersForCached(
  inputSchema: Record<string, unknown>,
): z.ZodType {
  const cached = zodBySchema.get(inputSchema);
  if (cached) return cached;
  const converted = parametersFor(inputSchema);
  zodBySchema.set(inputSchema, converted);
  return converted;
}

/**
 * What this Bot holds, said in its instructions rather than left to be inferred from a tool list.
 *
 * A tool array tells a model a tool exists. It does not tell it that the tool is the right way to
 * reach that system, and it competes with a page of prose about the browser that every Bot is given
 * whether or not it has any connectors at all. The browser prose wins: it is emphatic, it is about
 * capability, and it says "never claim you cannot browse".
 *
 * So a Bot holding four Google Drive tools browsed to drive.google.com, met a sign-in page its
 * container could never satisfy, and asked its person to sign in to a vendor that person had already
 * connected. The tools were there the whole time.
 *
 * Generated from the grants rather than written down, because the point is that it tracks them. An
 * administrator switching a connector on, or granting one more of its tools, changes what the Bot is
 * told on its next run with nothing else to remember and nothing to keep in step.
 *
 * Empty when the Bot holds nothing, so a deployment with no connectors says nothing about them.
 */
export function grantedToolGuidance(
  tools: GrantedTool[],
  /**
   * Systems this deployment connects to that this Bot holds nothing for.
   *
   * Without these a Bot holding no grants is told nothing at all, so it treats a connected vendor as
   * an ordinary website and browses to it. That is how a Bot with no Drive grant ended up on Google's
   * sign-in page asking a person to sign in to an account the deployment had already connected: the
   * connector existed, the Bot simply was not on it, and nothing said so.
   */
  connectedButNotHeld: readonly string[] = [],
): string {
  if (tools.length === 0 && connectedButNotHeld.length === 0) return "";

  const bySystem = new Map<string, string[]>();
  for (const tool of tools) {
    // `mcp__server__tool`, which is the shape the model is offered.
    const parts = tool.name.replace(/^mcp__/, "").split("__");
    const system = parts.length > 1 ? (parts[0] as string) : "this deployment";
    const rest = parts.length > 1 ? parts.slice(1).join("__") : tool.name;
    bySystem.set(system, [...(bySystem.get(system) ?? []), rest]);
  }

  /*
   * THE APP, NOT EVERY ACTION OF IT, and this is the sentence that used to be unreadable.
   *
   * It listed every action name it held, which for a Gmail Bot is sixty-three of them — several
   * thousand characters pasted into the system prompt of every single run, above the question the
   * model was asked, for no information the tool list did not already carry. The list right above it
   * IS the tool array, and it names every action with its full description. So the same names
   * appeared twice per run: once in prose where they can only be skimmed, and once where they are
   * chosen from.
   *
   * What the sentence is FOR is the thing a tool array cannot say: that this system is reachable
   * directly, as the person, with their own access, and that reaching for it beats a browser. Which
   * systems those are is the whole content. The count is kept because "sixty-three actions" is what
   * tells a model there is more here than it has been offered, and {@link composio_search_tools} is
   * how it asks.
   */
  const held = [...bySystem.keys()];
  const missing = connectedButNotHeld.filter(
    (system) => !held.includes(system),
  );
  /*
   * Named in full only up to a point. A deployment with a thousand connected
   * systems would otherwise paste a thousand names into every prompt — tens
   * of thousands of tokens the model pays attention to instead of the
   * question, which is exactly the failure this guidance exists to prevent.
   * Past the cap the sentence says how many more there are, which is all a
   * model needs to say "not granted" about one of them.
   */
  const MAX_MISSING_SYSTEMS = 25;
  const shownMissing = missing.slice(0, MAX_MISSING_SYSTEMS);
  const hiddenMissing = missing.length - shownMissing.length;

  return [
    ...(tools.length > 0
      ? [
          "You can reach these systems directly, as the person asking, with their own access:",
        ]
      : []),
    ...[...bySystem.entries()].map(
      ([system, names]) =>
        `- ${system}${names.length > 1 ? ` (${names.length} actions)` : ""}`,
    ),
    ...(tools.length > 0
      ? [
          "The tools listed above are these systems' actions. If the part you need is not among them,",
          "composio_search_tools finds the rest by describing what you want to do, and multi_execute runs",
          "several at once. Use them for anything about those systems. Do NOT browse to one of their websites instead: your",
          "browser is signed in as nobody, so it sees less than these tools do and will meet a sign-in wall",
          "that connecting an account has already solved.",
          "If one of these systems is involved and no tool above covers the part you need, that is a",
          "missing grant and not something to work around. Say so plainly, name the capability you would",
          "need, and say it can be granted on that connector under Settings → App connections. Do not reach for the",
          "browser, do not ask the person to sign in, and do not ask them to fetch it for you: they already",
          "have the access, and the thing that is missing is yours, not theirs.",
        ]
      : []),
    ...[...bySystem.entries()].map(
      ([system, names]) => `- ${system}: ${names.join(", ")}`,
    ),
    ...(tools.length > 0
      ? [
          "Use them for anything about those systems. Do NOT browse to one of their websites instead: your",
          "browser is signed in as nobody, so it sees less than these tools do and will meet a sign-in wall",
          "that connecting an account has already solved.",
          "If one of these systems is involved and no tool above covers the part you need, that is a",
          "missing grant and not something to work around. Say so plainly, name the capability you would",
          "need, and say it can be granted on that connector under Settings \u2192 App connections. Do not reach for the",
          "browser, do not ask the person to sign in, and do not ask them to fetch it for you: they already",
          "have the access, and the thing that is missing is yours, not theirs.",
        ]
      : []),
    /*
     * The vendors this deployment connects to and this Bot does not hold.
     *
     * Named so the Bot can say which one, because "I have not been granted it" is only actionable if
     * the person is told what "it" is. The browser is refused for these by the same reasoning as
     * above and for a sharper reason: a connector exists precisely so the vendor is reached as the
     * person asking, and the container's browser is signed in as nobody, so browsing there abandons
     * the per-person path and lands on a login wall by construction.
     */
    ...(shownMissing.length > 0
      ? [
          ...(tools.length > 0 ? [""] : []),
          `This deployment also connects to: ${shownMissing.join(", ")}${hiddenMissing > 0 ? `, and ${hiddenMissing} more connected systems` : ""}. You hold none of their tools.`,
          "If a question needs one of them, say plainly that you have not been granted it and that it can be",
          "granted on that connector under Settings \u2192 App connections. Do NOT browse to its website: that is not",
          "the same thing, your browser is signed in as nobody, and it will meet a sign-in wall that the",
          "connector exists to avoid. Do not ask the person to sign in there either.",
        ]
      : []),
  ].join("\n");
}

/**
 * Every MCP tool granted to one Bot, ready to hand to the runtime.
 *
 * A refusal is returned as the tool's result rather than thrown. The model is mid-run and the person
 * is owed a sentence about what was blocked; an exception here ends the run with nothing said, and
 * the refusal is already in the audit trail either way.
 */
export async function grantedTools(options: {
  store: PluginStore;
  botId: string;
  actorId: string;
  initiator?: AuditInitiator;
}): Promise<GrantedTool[]> {
  const { store, botId, actorId, initiator } = options;
  const granted = await store.listForAgent(botId);
  if (store.workbench) {
    try {
      await store.workbench.prepare(actorId);
    } catch {}
  }
  const workbench = store.workbench
    ? workbenchTools(store.workbench, actorId)
    : [];

  return [
    ...workbench,
    ...granted.tools.map((tool) => ({
      name: tool.toolName,
      ref: tool.ref,
      description: tool.description,
      parameters: parametersForCached(tool.inputSchema),
      effect: tool.effect,
      /*
       * Every one of these is a vendor's answer, which is what the app bound is for. See
       * `result-budget.ts`: a Gmail action returns structured JSON carrying whole messages, and the
       * screen bound this replaces cut such a result to a couple of entries while being exactly right
       * for the tools it was written next to.
       */
      resultBudget: "app" as const,
      execute: async (args: unknown, signal?: AbortSignal) => {
        try {
          signal?.throwIfAborted();
          const result = await store.callTool({
            ref: tool.ref,
            // The runtime hands through whatever the model produced. Anything that is not an object
            // is not a set of arguments, and the vendor should be the one to say so.
            args:
              args && typeof args === "object" && !Array.isArray(args)
                ? (args as Record<string, unknown>)
                : {},
            botId,
            actorId,
            ...(initiator ? { initiator } : {}),
            ...(signal ? { signal } : {}),
          });
          signal?.throwIfAborted();
          return vendorAnswer(result);
        } catch (error) {
          if (error instanceof PluginInvalidArgumentsError) {
            return `The tool call had invalid arguments: ${error.message}`;
          }
          if (error instanceof PluginRefusedError) {
            return `${REFUSAL_MARKER} ${error.message}`;
          }
          /*
           * A contradiction in this deployment's own tables says nothing to a model.
           *
           * CRITERION. Nothing on the `isDeploymentFault` shelf may have its message relayed from
           * here, whatever it says.
           *
           * REASON. The branch below hands `error.message` to the model, which is right for a
           * vendor's own words — that is somebody else's software explaining itself, and the
           * diagnosis is worth having. These are not that. `ServerRowAmbiguousError` names two of
           * our columns and tells the reader to rename a row or correct its provenance: an
           * instruction only an operator can carry out, arriving in an end user's model context as
           * the reason their tool failed, from which the model can only invent something to tell
           * them. The operator who can act on it is served on the admin surface instead, where the
           * refresh route now answers with the sentence in full.
           */
          if (isDeploymentFault(error)) return "That tool could not be called.";
          // A vendor that failed is not a refusal, and the difference matters to the person reading
          // the answer: one means "not allowed", the other means "it broke".
          return error instanceof Error
            ? `That tool could not be called: ${error.message}`
            : "That tool could not be called.";
        }
      },
    })),
  ];
}

/**
 * The skills one Bot holds, as much of each as choosing between them needs.
 *
 * Read here rather than folded into `grantedTools` because the two answer different questions and
 * are wanted at different moments: the tools are what a Bot may call, asked once per request, and
 * the skills are the index a run is narrowed against. Both come from `listForAgent`, and both are
 * read fresh for the same reason: a grant added a minute ago has to count on the next run.
 */
export async function grantedSkills(options: {
  store: PluginStore;
  botId: string;
}): Promise<SelectableSkill[]> {
  const granted = await options.store.listForAgent(options.botId);
  return granted.skills.map((skill) => ({
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary,
    tools: skill.tools,
  }));
}
