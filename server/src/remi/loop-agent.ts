import { randomUUID } from "node:crypto";
import type {
  BaseEvent,
  Message,
  RunAgentInput,
  ToolCall,
} from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import type OpenAI from "openai";
import { Observable } from "rxjs";
import { z } from "zod";
import { NO_ANSWER_CAME } from "../../../shared/bot-prompt";
import { sanitizeSeededHistory } from "../agents/history-sanitize";
import type { LoadAttachment, MarkAttachmentsSent } from "../copilot";
import { inlineAttachments } from "../copilot";
import type { GrantedTool, ToolResult } from "../plugins/tools";
import { toolResultText } from "../plugins/tools";
import {
  buildModelChain,
  classifyProviderError,
  noModelError,
  ProviderRequestError,
} from "./model-router";

/**
 * The Remi agent loop, speaking AG-UI.
 *
 * remi.in runs a custom ReAct loop over OpenAI-compatible chat completions rather than a
 * framework agent runtime: up to 40 steps, parallel tool calls, per-step model fallback,
 * truncated tool results, a final text-only pass, and exact token accounting. This is that
 * loop, emitting the same AG-UI event family the CopilotKit `BuiltInAgent` it replaces
 * emitted (`RUN_STARTED`, `TEXT_MESSAGE_CHUNK`, `TOOL_CALL_START/ARGS/END/RESULT`,
 * `REASONING_*`, `RUN_FINISHED` with a usage array, `RUN_ERROR`), so everything downstream —
 * the transcript, the Postgres persistence that rebuilds rows from events, the metering that
 * reads usage off `RUN_FINISHED`, the stall guard, handoff delivery — keeps working
 * untouched. Only the brain changed; the body is the same.
 *
 * Tools come in two kinds, and the loop treats them differently:
 *
 * - Server tools (`GrantedTool[]`, executed here): model calls one, it runs inline with a
 *   timeout, its answer goes back into the conversation and the loop continues.
 * - Frontend tools (`input.tools`, browser-drawn gallery components, computer actions,
 *   decision cards): the loop emits the call events and ENDS THE TURN without a result. The
 *   browser executes the handler and the answer returns as history on the next run — the same
 *   turn-taking the old runtime had, which is why the history sanitizer still guards every
 *   run below.
 *
 * Interrupts (`input.resume`, human-in-the-loop answers) are synthesized into tool results
 * before the loop starts: resolved answers carry their payload, cancelled ones carry the
 * shared no-answer sentence, which is what stops the model waiting on a question nobody
 * answered.
 */

export type RemiLoopConfig = {
  /** The Bot this loop runs as: registry id, description seed and usage row. */
  botId: string;
  /** The composed system prompt: role, instructions, grants guidance, computer prose. */
  systemPrompt: string;
  /** Server-executed tools, resolved for this run's Bot and person. */
  tools: GrantedTool[];
  /** Which model answers, and which provider it belongs to. */
  model: { provider: "openai"; model: string };
  /**
   * The resolved key the primary link spends. Null means the deployment's model identity is
   * unconfigured and the chain is empty: fallbacks cover an outage, never a missing
   * configuration.
   */
  apiKey: string | null;
  /**
   * What a turn fails with when no model link exists at all. Names the Bot the way the old
   * runtime did, so an unconfigured deployment reads as misconfigured rather than broken.
   */
  missingKeyMessage?: string;
  environment?: Record<string, string | undefined>;
  /** Tool-loop steps per run. Forty, the Remi full-loop budget. */
  maxSteps?: number;
  /** Maximum wall-clock time for one continuous run. */
  maxDurationMs?: number;
  /**
   * Whether tools offered by the browser in the request are runnable.
   *
   * True unless a deployment says otherwise, which is every Bot except a
   * supervisor. Set false for one and the loop takes nothing from
   * `input.tools`: a browser is the one party in this that is not filtered by
   * the server, and it offers the computer tools to whichever Bot is in the
   * conversation. Without this, a supervisor that had every grant and every
   * built-in tool taken away would still be handed a browser by the client
   * asking, and would go and do the work itself.
   *
   * The tools are refused here rather than in the client, because the client
   * cannot be the thing that decides what a model may run.
   */
  acceptFrontendTools?: boolean;
  /**
   * Told how a run ended, once, with the reason when it did not end well.
   *
   * THE LOOP IS THE ONLY PLACE THAT KNOWS. A run can end three ways — the model finished, somebody
   * stopped it, or it broke — and each of those is emitted on a different path deep in here, so a
   * caller watching the outside sees a stream and has to infer the ending from it. `stopped` and
   * `failed` are the two that matter to a person: a run they stopped and a run that broke both look
   * like silence from the roster, and they are not the same event.
   *
   * Called at most once per run, and never awaited: the run is already over by the time it is
   * called, and nothing downstream may be able to slow that down.
   */
  onRunOutcome?: (input: {
    runId: string;
    threadId: string;
    outcome: "done" | "stopped" | "failed";
    /** What broke, for `failed`. Never the task, never the conversation. */
    reason?: string;
  }) => void;
  /** Per-tool execution timeout. Two minutes, the Remi tool budget. */
  toolTimeoutMs?: number;
  /**
   * How often a running tool emits something, so a deployment's stall watchdog does not end the
   * turn while a legitimate tool is still working. `HEARTBEAT_MS` unless a deployment configures
   * one — which it should, whenever its watchdog is set below the default.
   */
  heartbeatMs?: number;
  /** Approximate context window in characters; older blocks prune past it. */
  contextBudgetChars?: number;
  loadAttachment?: LoadAttachment;
  markAttachmentsSent?: MarkAttachmentsSent;
  /**
   * After a finished run, with everything the turn said and spent. Fire-and-forget by the
   * caller: memory extraction lives here, never in the loop's critical path.
   */
  onAfterRun?: (info: RemiAfterRun) => void;
  /**
   * Pre-turn memory recall: what this person needs remembered for this run,
   * as a system block, or null when nothing is needed. Resolved inside
   * `run()` beside the attachment inline, so every built-in run — chat,
   * routine, trigger, telegram — recalls the same way without each caller
   * repeating it. Absent means the model holds `memory_search` itself, which
   * is what every deployment did before this existed.
   */
  recallBeforeRun?: (input: RunAgentInput) => Promise<{
    block: string | null;
    memoryIds: string[];
    memories: Array<{ id: string; content: string }>;
  } | null>;
  /**
   * Which recalled memories the answer visibly used. Resolved beside the
   * recall above so citation events land on the same turn. Absent means no
   * citation tracking: recalls stay `recalled`, never `cited`.
   */
  recordCited?: (memoryIds: string[]) => Promise<void> | void;
};

export type RemiAfterRun = {
  botId: string;
  threadId: string;
  userText: string;
  assistantText: string;
  calls: { name: string; args: string; result: string }[];
  promptTokens: number;
  completionTokens: number;
};

export type OpenAIMessage = OpenAI.ChatCompletionMessageParam;
type OpenAITool = OpenAI.ChatCompletionTool;

const REMI_MAX_STEPS = 40;
const REMI_MAX_DURATION_MS = 20 * 60 * 1000;
const REMI_TOOL_TIMEOUT_MS = 120_000;
/**
 * How often a running tool says something, so a watchdog does not end the turn underneath it.
 *
 * A quarter of the 60s this repository ships as `AGENT_STALL_TIMEOUT_MS`, so a deployment that
 * raises the watchdog still beats it, and one that lowers it to 30s is the only way to get a
 * heartbeat this slow would miss. See the note beside `heartbeat` in the tool loop for the failure
 * this exists to prevent.
 */
const HEARTBEAT_MS = 15_000;
/** ~200k tokens at four chars each, the Remi window. */
const REMI_CONTEXT_BUDGET_CHARS = 800_000;
/** Truncation budget per tool result, the Remi shape. */
const MAX_TOOL_STRING = 1500;
const MAX_TOOL_ITEMS = 15;
const MAX_TOOL_JSON = 4000;

/**
 * Why a run stopped, in the words of whatever stopped it.
 *
 * A run can be ended by the person at the keyboard, by the loop breaker that caps iterative tool
 * calls, or by this turn's own time budget. All three arrive as the same aborted signal, because
 * `abortRun()` has nothing to pass and the budgets are enforced by cancelling. That is why they
 * are told apart here rather than at the call site: this is the one place in the loop that knows
 * which of its own limits was reached.
 *
 * Deliberately a sentence rather than a code. The browser has one surface for "this turn ended
 * without an answer" and it prints whatever it is given; a code would need a lookup table to
 * become words, and a lookup table that has not learned a reason says nothing at all.
 */
export function abortReason(signal: AbortSignal): string {
  if (signal.reason instanceof Error && signal.reason.message) {
    return signal.reason.message;
  }
  if (typeof signal.reason === "string" && signal.reason) {
    return signal.reason;
  }
  return "This turn was stopped before the Bot finished answering.";
}

function textOfMessage(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part === "object" && part !== null && "text" in part
            ? String((part as { text?: unknown }).text ?? "")
            : "",
      )
      .join("\n");
  }
  return "";
}

function truncateToolText(value: string): string {
  if (value.length <= MAX_TOOL_JSON) return value;
  return `${value.slice(0, 2500)}\n... [Truncated ${value.length - 3500} characters] ...\n${value.slice(-1000)}`;
}

export function truncateToolValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[Object]";
  if (typeof value === "string") {
    return value.length > MAX_TOOL_STRING
      ? `${value.slice(0, MAX_TOOL_STRING)}... [Truncated ${value.length - MAX_TOOL_STRING} chars]`
      : value;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_TOOL_ITEMS)
      .map((item) => truncateToolValue(item, depth + 1));
    if (value.length > MAX_TOOL_ITEMS) {
      items.push(`[... ${value.length - MAX_TOOL_ITEMS} items truncated]`);
    }
    return items;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "imageDataUrl" || key === "base64") continue;
      out[key] = truncateToolValue(entry, depth + 1);
    }
    return out;
  }
  return value;
}

/** Keep loop context small: full results are stored, the model only needs the gist. */
export function truncateToolResultForContext(
  result: string,
  toolName: string,
): string {
  if (toolName === "artifact_read") return result;
  try {
    const parsed: unknown = JSON.parse(result);
    const pruned = truncateToolValue(parsed);
    const text = JSON.stringify(pruned);
    return text.length > MAX_TOOL_JSON ? truncateToolText(text) : text;
  } catch {
    return truncateToolText(result);
  }
}

/** The image mime types a provider will accept, and nothing else. */
const TOOL_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

/**
 * How many pictures one run may keep.
 *
 * Not a taste decision. A downscaled 1280-wide desktop JPEG is ~90KB of base64, and the Remi window
 * is `REMI_CONTEXT_BUDGET_CHARS` characters — so five careless screenshots consume more than half
 * the context and `pruneContext` starts dropping the tool CALLS whose results those pictures
 * answered, which is the one pairing a provider refuses and the whole turn dies on. Twelve is
 * roughly three screens' worth of looking at something, which is what a turn actually does.
 */
const MAX_TOOL_IMAGES_PER_RUN = 12;

/**
 * Keep the bytes if they are a picture, drop them if they are anything else.
 *
 * A tool's image goes into an outbound provider payload, so it gets the same treatment an
 * attachment does in `shared/user-content.ts`: an allowlisted mime type and base64 shape-checked.
 * Without the check a `text/html` or whitespace-smuggled value rides a field typed as an image and
 * becomes a provider error, or worse, a data URL the provider interprets.
 *
 * Dropping rather than throwing is deliberate: the text half of the answer is still a usable
 * answer, and a Bot told "screenshot unavailable" recovers far better than one whose turn died.
 */
function usableToolImages(
  images: readonly { data?: unknown; mimeType?: unknown }[] | undefined,
): { type: "image_url"; image_url: { url: string } }[] {
  if (!Array.isArray(images)) return [];
  const out: { type: "image_url"; image_url: { url: string } }[] = [];
  for (const image of images) {
    const mime =
      typeof image?.mimeType === "string"
        ? image.mimeType.trim().toLowerCase()
        : "";
    const data = typeof image?.data === "string" ? image.data : "";
    if (
      !mime ||
      !(TOOL_IMAGE_TYPES as readonly string[]).includes(mime) ||
      !data.trim() ||
      data.length > 20_000_000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data.replace(/\s/g, ""))
    ) {
      continue;
    }
    out.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${data}` },
    });
  }
  return out;
}

/**
 * Turn a tool answer into what the model is sent.
 *
 * A string result is truncated exactly as it always was — the string arm is the overwhelmingly
 * common case and must keep behaving identically. Only the object arm builds a part list, and it
 * only does so when it has at least one picture that survived {@link usableToolImages}; an object
 * whose images were all dropped comes back as its plain text, so a malformed image degrades to the
 * same single string it would have been before this type existed.
 *
 * The `data:` prefix is built HERE and nowhere else, which is the single place a screenshot's
 * base64 becomes a URL. Everywhere else in the tree carries bytes.
 */
export function toolResultContent(
  result: ToolResult,
  toolName: string,
): OpenAIMessage["content"] {
  const text = truncateToolResultForContext(toolResultText(result), toolName);
  if (typeof result === "string") return text;
  const images = usableToolImages(result.images);
  if (images.length === 0) return text;
  return [{ type: "text", text }, ...images] as OpenAIMessage["content"];
}

/**
 * Keep this turn's pictures and demote every earlier turn's to their text.
 *
 * THE REASON PICTURES ARE PER-TURN. The model's most recent screenshot is what it is reasoning
 * about right now. A screenshot from three steps ago is a picture of a window that has since
 * changed, and it is ~90KB of the window — so keeping it trades a large, stale cost for a small,
 * current one, and the provider bills both. Demoting to the sentence ("Taken at 14:02, 1280x720")
 * loses nothing the model still needs, because the CURRENT screen is in the context either way.
 *
 * The cut is at the last user message, which is also where `inlineAttachments` puts the person's own
 * attachments, so a turn's pictures and the turn's question survive together and drop together.
 */
export function demoteStaleToolImages(
  messages: OpenAIMessage[],
): OpenAIMessage[] {
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      boundary = index;
      break;
    }
  }
  if (boundary < 0) return messages;
  /*
   * Walk BACKWARDS so the budget spends itself on the newest pictures. Forward, the cap would keep
   * the first twelve screenshots of a turn and demote the one the model is looking at now, which is
   * the exact opposite of what a cap is for.
   */
  let budget = MAX_TOOL_IMAGES_PER_RUN;
  const demoted = new Array<OpenAIMessage>(messages.length);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const content = (message as unknown as { content?: unknown }).content;
    const isToolPicture =
      message?.role === "tool" &&
      Array.isArray(content) &&
      content.some((part) => (part as { type?: string })?.type === "image_url");
    if (!isToolPicture) {
      demoted[index] = message;
      continue;
    }
    const parts = content as { type?: string; text?: string }[];
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    const pictures = parts.filter((part) => part.type === "image_url");
    /*
     * Two reasons to demote, and they are different reasons.
     *
     * This turn has ended (the cut is at the last user message), so this picture is of a window that
     * has since changed. Or this turn has not run out of budget, in which case the newer pictures
     * are worth more. Both land on the same fallback — the sentence — which is why they share a
     * branch, but they are checked in that order because "an old picture" is the stronger claim.
     */
    if (index <= boundary || budget <= 0) {
      demoted[index] = { ...message, content: text } as OpenAIMessage;
      continue;
    }
    const kept = pictures.slice(0, budget);
    budget -= kept.length;
    // Nothing was dropped, so the message is left exactly as it was. Assigning `message` here would
    // put the whole message object where the content belongs — which the provider reads as a tool
    // result that is an object with no text and no picture.
    if (kept.length === pictures.length) {
      demoted[index] = message;
      continue;
    }
    const textParts = parts.filter((part) => part.type === "text");
    demoted[index] = {
      ...message,
      content: [...textParts, ...kept],
    } as OpenAIMessage;
  }
  return demoted;
}

function estimateChars(messages: OpenAIMessage[]): number {
  let total = 0;
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    const content = record.content;
    if (typeof content === "string") total += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) {
        total += JSON.stringify(part)?.length ?? 0;
      }
    }
    const calls = record.tool_calls;
    if (Array.isArray(calls)) {
      for (const call of calls) total += JSON.stringify(call)?.length ?? 0;
    }
  }
  return total;
}

/**
 * Slide the window: drop oldest assistant/tool blocks past the budget, never the trailing
 * exchange. Calls and their results go together — pruning one half of a pair is the shape
 * the provider refuses — and the system prompt plus the latest user message always survive.
 */
export function pruneContext(
  messages: OpenAIMessage[],
  budget: number,
): OpenAIMessage[] {
  if (estimateChars(messages) <= budget) return messages;
  const kept = [...messages];
  const lastUser = kept.map((message) => message.role).lastIndexOf("user");
  let index = 1;
  while (estimateChars(kept) > budget && index < kept.length) {
    if (index >= lastUser && lastUser !== -1) break;
    const message = kept[index];
    if (message?.role === "assistant" && message.tool_calls?.length) {
      // The block: this call plus every tool answer up to the next non-tool message.
      let end = index + 1;
      while (end < kept.length && kept[end]?.role === "tool") end += 1;
      if (end <= lastUser || lastUser === -1) {
        kept.splice(index, end - index);
        continue;
      }
      break;
    }
    if (message?.role === "tool") {
      kept.splice(index, 1);
      continue;
    }
    index += 1;
  }
  return kept;
}

export function historyToOpenAI(history: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const message of history) {
    const role = (message as { role?: string }).role;
    if (role === "user") {
      const text = textOfMessage(message);
      out.push({ role: "user", content: text });
    } else if (role === "assistant") {
      const { toolCalls } = message as { toolCalls?: ToolCall[] };
      const text = textOfMessage(message);
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls?.length
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: {
                  name: String(call.function?.name ?? ""),
                  arguments: String(call.function?.arguments ?? "{}"),
                },
              })),
            }
          : {}),
      } as OpenAIMessage);
    } else if (role === "tool") {
      const { toolCallId } = message as { toolCallId?: string };
      if (!toolCallId) continue;
      out.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: textOfMessage(message),
      });
    } else if (role === "system" || role === "developer") {
      // Kept, unlike the old runtime which dropped these: skill instructions arrive as
      // system rows, and dropping them silently un-teaches every skill.
      const text = textOfMessage(message);
      if (text) out.push({ role: "system", content: text });
    }
  }
  return out;
}

function grantedToolToOpenAI(tool: GrantedTool): OpenAITool {
  let parameters: Record<string, unknown> = {
    type: "object",
    properties: {},
  };
  try {
    const schema = z.toJSONSchema(tool.parameters) as Record<string, unknown>;
    if (schema && typeof schema === "object") parameters = schema;
  } catch {
    // An unreadable schema must not stop the tool being offered: an open object lets the
    // model call it and the execution end validate the arguments instead.
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters,
    },
  };
}

type FrontendTool = {
  name: string;
  description?: string;
  parameters?: unknown;
};

function frontendToolToOpenAI(tool: FrontendTool): OpenAITool {
  const parameters =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : { type: "object", properties: {} };
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters,
    },
  };
}

type StreamedCall = { id: string; name: string; argsJson: string };
type StepUsage = {
  promptTokens: number;
  completionTokens: number;
};

async function* streamStep(
  link: { client: OpenAI; model: string; extraBody?: Record<string, unknown> },
  messages: OpenAIMessage[],
  tools: OpenAITool[],
  signal?: AbortSignal,
): AsyncGenerator<
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "call"; call: StreamedCall }
  | { type: "usage"; usage: StepUsage }
> {
  const stream = await link.client.chat.completions.create(
    {
      model: link.model,
      messages,
      ...(tools.length > 0
        ? { tools, tool_choice: "auto" as const, parallel_tool_calls: true }
        : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...(link.extraBody ?? {}),
    },
    { signal },
  );

  const calls = new Map<number, { id: string; name: string; args: string }>();
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta as
      | {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: {
            index: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }[];
        }
      | undefined;
    if (typeof delta?.content === "string" && delta.content) {
      yield { type: "text", delta: delta.content };
    }
    if (
      typeof delta?.reasoning_content === "string" &&
      delta.reasoning_content
    ) {
      yield { type: "reasoning", delta: delta.reasoning_content };
    }
    for (const part of delta?.tool_calls ?? []) {
      const slot = calls.get(part.index) ?? { id: "", name: "", args: "" };
      if (part.id) slot.id = part.id;
      if (part.function?.name) slot.name += part.function.name;
      if (typeof part.function?.arguments === "string") {
        slot.args += part.function.arguments;
      }
      calls.set(part.index, slot);
    }
    const usage = (chunk as { usage?: unknown }).usage as
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_cache_hit_tokens?: number;
          prompt_cache_miss_tokens?: number;
        }
      | undefined;
    if (usage && typeof usage === "object") {
      yield {
        type: "usage",
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
        },
      };
    }
  }
  for (const call of calls.values()) {
    if (!call.id || !call.name) continue;
    yield {
      type: "call",
      call: { id: call.id, name: call.name, argsJson: call.args || "{}" },
    };
  }
}

/**
 * One line per provider link that failed, on every step.
 *
 * This is the record that was missing: a step that failed on one link and succeeded on the next
 * said nothing at all, and a step that failed on every link logged only the last error, so the
 * link that actually broke the turn was invisible and the reason had to be guessed from the
 * vendor's envelope. `detail` carries the vendor's own message so the log keeps everything the
 * chat no longer shows.
 *
 * A classified failure logs its `kind`; an unclassifiable one logs the status and message as they
 * came, because a refusal this code has never seen is exactly the case where the raw text is the
 * only clue.
 */
function logProviderLinkFailure(
  link: { provider: string; model: string },
  error: unknown,
): void {
  const classified = error instanceof ProviderRequestError ? error : null;
  console.error(
    JSON.stringify({
      type: "model-link-failed",
      provider: link.provider,
      model: link.model,
      ...(classified
        ? {
            kind: classified.kind,
            status: classified.status,
            code: classified.code,
          }
        : {}),
      detail:
        classified?.detail ??
        (error instanceof Error ? error.message : String(error)),
    }),
  );
}

export class RemiLoopAgent extends AbstractAgent {
  private readonly configuration: RemiLoopConfig;
  private readonly loadAttachment: LoadAttachment | undefined;
  private readonly markAttachmentsSent: MarkAttachmentsSent | undefined;
  private activeController?: AbortController;

  constructor(
    configuration: RemiLoopConfig,
    loadAttachment?: LoadAttachment,
    markAttachmentsSent?: MarkAttachmentsSent,
  ) {
    super({ agentId: configuration.botId, description: configuration.botId });
    this.configuration = configuration;
    this.loadAttachment = loadAttachment;
    this.markAttachmentsSent = markAttachmentsSent;
  }

  /*
   * Stopping a run is a message, not a shrug.
   *
   * `AbortController.abort()` takes an optional reason and the loop reads it back when it has to
   * explain itself (`abortReason`). Without one every abort arrives anonymous, so the three things
   * that can end a turn are indistinguishable at the only place that could have told them apart.
   *
   * Its own method rather than a parameter on `abortRun`, because the base signature takes none:
   * `AbstractAgent.abortRun(): void` is what `EnforcedAgent` holds and calls, so a reason passed
   * there would not type-check and could not reach the loop through the wrapper. A caller that wants
   * the transcript to say something calls this.
   */
  abortRunWithReason(reason: string): void {
    try {
      this.activeController?.abort(new Error(reason));
    } catch {
      // Aborting twice is not an error worth reporting.
    }
    this.abortRun();
  }

  override abortRun(): void {
    try {
      this.activeController?.abort();
    } catch {
      // Aborting twice is not an error worth reporting.
    }
    super.abortRun();
  }

  override clone(): RemiLoopAgent {
    const cloned = new RemiLoopAgent(
      this.configuration,
      this.loadAttachment,
      this.markAttachmentsSent,
    );
    type WithMiddlewares = { middlewares: unknown[] };
    (cloned as unknown as WithMiddlewares).middlewares = [
      ...(this as unknown as WithMiddlewares).middlewares,
    ];
    return cloned;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    // Guarded synchronously, modelled asynchronously: sanitize and resume synthesis happen
    // here so a caller holding the run off the model still exercises the guard, and the
    // model loop below is the seam tests replace with an empty stream.
    const answeredByResume = new Set(
      (input.resume ?? []).map((entry) => entry.interruptId),
    );
    const history = sanitizeSeededHistory(input.messages, answeredByResume);
    // Interrupts answered elsewhere arrive as tool results, the way the old runtime appended
    // them after conversion: resolved answers carry their payload, cancelled ones carry the
    // shared sentence so the model stops waiting on a question nobody answered.
    const resumed: Message[] = (input.resume ?? []).map(
      (entry) =>
        ({
          id: `resume:${entry.interruptId}`,
          role: "tool",
          toolCallId: entry.interruptId,
          content:
            entry.status === "cancelled"
              ? NO_ANSWER_CAME
              : typeof entry.payload === "string"
                ? entry.payload
                : JSON.stringify(entry.payload ?? ""),
        }) as Message,
    );
    const guarded: RunAgentInput = {
      ...input,
      messages: resumed.length > 0 ? [...history, ...resumed] : history,
    };

    return new Observable<BaseEvent>((observer) => {
      const controller = new AbortController();
      this.activeController = controller;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (this.activeController === controller) {
          this.activeController = undefined;
        }
        fn();
      };

      /*
       * How this run ended, reported once and apart from `settle`.
       *
       * Separate because `settle` is about the OBSERVER — it guarantees the
       * stream completes or errors exactly once — while this is about the run,
       * and the two do not always agree on the order: an abort completes the
       * stream first and is only known afterwards, and a run that is stopped
       * mid-tool has already emitted a normal finish by the time anybody asks.
       */
      let outcomeReported = false;
      const reportOutcome = (
        outcome: "done" | "stopped" | "failed",
        reason?: string,
      ) => {
        if (outcomeReported) return;
        outcomeReported = true;
        try {
          this.configuration.onRunOutcome?.({
            runId: input.runId,
            threadId: input.threadId,
            outcome,
            ...(reason ? { reason } : {}),
          });
        } catch {
          // A side effect on a path that has already ended.
        }
      };

      void (async () => {
        let prepared = guarded;
        if (this.loadAttachment) {
          const inlined = await inlineAttachments(
            guarded.messages,
            this.loadAttachment,
            guarded.threadId,
            this.markAttachmentsSent,
          );
          prepared = { ...guarded, messages: inlined };
        }
        // Pre-turn recall, beside the attachment inline: the run carries what
        // this person needs remembered as a second system message, so recall
        // happens whether or not the model thinks to call `memory_search`.
        // A failure recalls nothing rather than failing the turn: the model
        // still holds its own search tool.
        try {
          const recalled = await this.configuration.recallBeforeRun?.(guarded);
          if (recalled?.block) {
            prepared = {
              ...prepared,
              messages: [
                { role: "system", content: recalled.block } as Message,
                ...prepared.messages,
              ],
            };
          }
          if (recalled && recalled.memoryIds.length > 0) {
            (prepared as { recalledMemories?: unknown }).recalledMemories =
              recalled.memories;
          }
        } catch {
          // Recall must never fail a turn.
        }
        return prepared;
      })().then(
        (prepared) => {
          const inner = this.runLoop(prepared, controller.signal);
          inner.subscribe({
            next: (event) => observer.next(event),
            complete: () => {
              // The loop's own signal, not a local: an abort is a stop whether it
              // came from `abortRun` or from the run being detached underneath it.
              reportOutcome(controller.signal.aborted ? "stopped" : "done");
              settle(() => observer.complete());
            },
            error: (error: unknown) => {
              const message =
                error instanceof Error
                  ? error.message
                  : String(error ?? "The run failed.");
              reportOutcome("failed", message);
              settle(() => {
                observer.next({
                  type: EventType.RUN_ERROR,
                  message,
                  threadId: input.threadId,
                  runId: input.runId,
                } as BaseEvent);
                observer.error(
                  error instanceof Error ? error : new Error(message),
                );
              });
            },
          });
        },
        (error: unknown) => {
          const message =
            error instanceof Error
              ? error.message
              : String(error ?? "The run failed.");
          reportOutcome("failed", message);
          settle(() => {
            observer.next({
              type: EventType.RUN_ERROR,
              message,
              threadId: input.threadId,
              runId: input.runId,
            } as BaseEvent);
            observer.error(error instanceof Error ? error : new Error(message));
          });
        },
      );

      return () => {
        controller.abort();
      };
    });
  }

  /**
   * The model loop, as an Observable the caller subscribes: the seam a test replaces with an
   * empty stream to hold the model off while the guard above runs for real.
   */
  runLoop(input: RunAgentInput, signal: AbortSignal): Observable<BaseEvent> {
    return new Observable<BaseEvent>((observer) => {
      const emit = (event: unknown) => observer.next(event as BaseEvent);
      void this.execute(input, signal, emit).then(
        () => observer.complete(),
        (error: unknown) => observer.error(error),
      );
      return () => {
        // The signal belongs to the run, not to this subscription: aborting it here would
        // end the turn when a second subscriber merely walks away.
      };
    });
  }

  private async execute(
    input: RunAgentInput,
    signal: AbortSignal,
    emit: (event: unknown) => void,
  ): Promise<void> {
    const config = this.configuration;
    const maxSteps = config.maxSteps ?? REMI_MAX_STEPS;
    const maxDurationMs = config.maxDurationMs ?? REMI_MAX_DURATION_MS;
    const startedAt = Date.now();
    const toolTimeoutMs = config.toolTimeoutMs ?? REMI_TOOL_TIMEOUT_MS;
    const heartbeatMs = config.heartbeatMs ?? HEARTBEAT_MS;
    const budget = config.contextBudgetChars ?? REMI_CONTEXT_BUDGET_CHARS;

    emit({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    });

    const chain = buildModelChain(
      config.model,
      config.environment ?? process.env,
      config.apiKey,
    );
    if (chain.length === 0) {
      throw new Error(
        config.missingKeyMessage ?? noModelError(config.model.provider).message,
      );
    }

    const history = input.messages;

    const serverTools = new Map(config.tools.map((tool) => [tool.name, tool]));
    const frontendTools = new Map<string, FrontendTool>();
    // Absent means yes, so a Bot nobody has an opinion about is unaffected.
    for (const tool of config.acceptFrontendTools === false
      ? []
      : ((input.tools ?? []) as FrontendTool[])) {
      if (
        tool &&
        typeof tool.name === "string" &&
        !serverTools.has(tool.name)
      ) {
        frontendTools.set(tool.name, tool);
      }
    }
    const modelTools: OpenAITool[] = [
      ...config.tools.map(grantedToolToOpenAI),
      ...[...frontendTools.values()].map(frontendToolToOpenAI),
    ];

    const messages: OpenAIMessage[] = [
      { role: "system", content: config.systemPrompt },
      ...historyToOpenAI(history),
    ];

    let promptTokens = 0;
    let completionTokens = 0;
    let usedProvider = chain[0]?.provider ?? "openai";
    let usedModel = chain[0]?.model ?? config.model.model;
    const calls: { name: string; args: string; result: string }[] = [];
    let assistantText = "";
    let reasoningId: string | null = null;

    const checkAbort = () => {
      if (signal.aborted) {
        const error = new Error("The run was stopped.");
        error.name = "AbortError";
        throw error;
      }
    };

    const emitReasoning = (delta: string) => {
      if (!reasoningId) {
        reasoningId = randomUUID();
        emit({ type: EventType.REASONING_START, messageId: reasoningId });
        emit({
          type: EventType.REASONING_MESSAGE_START,
          messageId: reasoningId,
          role: "reasoning",
        });
      }
      emit({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: reasoningId,
        delta,
      });
    };

    const runStep = async (
      stepTools: OpenAITool[],
      onText: (delta: string) => void,
      onReasoning: (delta: string) => void,
      onCall: (call: StreamedCall) => void,
    ): Promise<{ calls: StreamedCall[]; finished: boolean }> => {
      const stepCalls: StreamedCall[] = [];
      let lastError: unknown = null;
      for (const link of chain) {
        checkAbort();
        try {
          for await (const chunk of streamStep(
            link,
            messages,
            stepTools,
            signal,
          )) {
            checkAbort();
            if (chunk.type === "text") onText(chunk.delta);
            else if (chunk.type === "reasoning") onReasoning(chunk.delta);
            else if (chunk.type === "call") {
              stepCalls.push(chunk.call);
              onCall(chunk.call);
            } else if (chunk.type === "usage") {
              promptTokens += chunk.usage.promptTokens;
              completionTokens += chunk.usage.completionTokens;
            }
          }
          usedProvider = link.provider;
          usedModel = link.model;
          return { calls: stepCalls, finished: true };
        } catch (rawError) {
          if (signal.aborted) throw rawError;
          /*
           * Named before it is stored, because the raw vendor error is what reached the chat
           * composer and it named neither the provider nor the problem: a turn where DeepSeek
           * refused a request and a fallback account happened to be empty failed with the
           * fallback's `403 NOT_ENOUGH_BALANCE`, so the one message an operator saw pointed at
           * a vendor the deployment never chose and said nothing about the request that actually
           * broke. A classified error carries `provider` and `kind`, logs in one line, and shows
           * a sentence.
           */
          const error = classifyProviderError(link, rawError);
          logProviderLinkFailure(link, error);
          lastError = error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error("The model call failed.");
    };

    /*
     * `ToolResult` and not `string`: a desktop screenshot answer carries the picture as well as the
     * sentence, and narrowing it to a string here is what made the model blind — it received
     * "Screenshot taken (412 KB)" and no image, every single time.
     */
    const executeServerTool = async (
      name: string,
      argsJson: string,
    ): Promise<ToolResult> => {
      const tool = serverTools.get(name);
      if (!tool) return `Tool "${name}" has no execute function`;
      signal.throwIfAborted();
      let args: unknown;
      try {
        args = JSON.parse(argsJson);
      } catch {
        return `Tool "${name}" received invalid JSON arguments.`;
      }
      const parsed = tool.parameters.safeParse(args);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
        return `Tool "${name}" received invalid arguments${path}: ${issue?.message ?? "the schema was not satisfied"}.`;
      }
      const remainingRunMs = maxDurationMs - (Date.now() - startedAt);
      if (remainingRunMs <= 0) {
        return `Tool "${name}" was not started because this run reached its time budget.`;
      }
      const effectiveTimeoutMs = Math.min(toolTimeoutMs, remainingRunMs);
      const timeout = new Promise<string>((resolve) =>
        setTimeout(
          () =>
            resolve(
              `Tool "${name}" timed out after ${Math.round(effectiveTimeoutMs / 1000)} seconds.`,
            ),
          effectiveTimeoutMs,
        ),
      );
      /*
       * STOP DOES NOT WAIT FOR THE TOOL.
       *
       * `Promise.race` only ends when one of its arms settles, and a tool that has been handed the
       * run's signal is free to ignore it — an MCP call, a fetch with no abort handling, or
       * anything simply slow. So aborting the run used to leave this awaiting a promise that could
       * take the full `toolTimeoutMs` to resolve: up to two minutes of a Stop button that does
       * nothing, and a transcript frozen on a half-finished tool line.
       *
       * Racing the signal makes the stop immediate, which is the entire point of a stop. The tool's
       * own work is not cancelled by this — that is whatever holds the signal will do — but the run
       * stops waiting for it, which is the part a person is watching.
       *
       * The listener is detached in `finally`. Left attached it would pin this closure, the tool and
       * its arguments for as long as the controller lives, which outlives this run by however long
       * the Bot's next turn takes. `rejectStopped` is declared first because the abort can fire
       * before the promise executor below has run — a signal already aborted at entry.
       */
      let rejectStopped: (reason: Error) => void = () => undefined;
      const stopped = new Promise<string>((_, reject) => {
        rejectStopped = reject;
      });
      const onAbort = () => {
        const aborted = new Error("The run was stopped.");
        aborted.name = "AbortError";
        rejectStopped(aborted);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await Promise.race([
          tool.execute(parsed.data, signal),
          timeout,
          stopped,
        ]);
        signal.throwIfAborted();
        return result;
      } catch (error) {
        /*
         * AN ABORT IS NOT A TOOL FAILURE.
         *
         * Every other throw here is answered to the model as its own error so it can work around
         * it — which is right, and the whole reason this is a `catch` rather than a rethrow. An
         * abort is different: the run is over, there is no model left to read a workaround, and
         * swallowing it meant a stopped run kept going. Rethrown so the run's own abort handler
         * sees it, which is what reports the stop and closes the stream.
         */
        if (signal.aborted || (error as Error)?.name === "AbortError") {
          throw error;
        }
        // A throwing tool answers with its failure, the Remi way: the model reads the error
        // and works around it rather than the run ending with nothing said.
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    };

    try {
      /*
       * A MESSAGE ID PER STEP, which used to be one for the whole run.
       *
       * Each step is a separate assistant turn: step 1's tool call and step 2's answer are two
       * messages, and they must be two ids. Sharing one id made step 2's text chunk land on step 1's
       * message — so the assistant message that recorded the tool call was overwritten with the answer
       * and the tool result was left pointing at a call that no longer existed in the transcript.
       *
       * That is not only cosmetic. A tool result with no call before it is the shape a model API
       * refuses on the NEXT turn, and a caller reading the finished transcript cannot see which call
       * the answer was answering. The second turn survived here only because the history is sanitised
       * on the way in, which is a safety net doing the work the transcript should have done itself.
       *
       * So the id is minted where the step begins: one assistant message per step, carrying that
       * step's text and that step's calls, with the results following it.
       */
      /*
       * BOTH BUDGETS, AND `&&` — the loop stops at whichever runs out first.
       *
       * This read `||`, which meant the loop only stopped once BOTH were exhausted: at least
       * `maxSteps` steps AND at least `maxDurationMs` of wall clock. The step cap therefore never
       * protected anything, and every conversational turn that ended on a tool call ran the full
       * budget. A turn is meant to stop when the model stops asking for tools (line 920), and both
       * caps exist for the turn where it does not: `maxSteps` bounds how many times a model can
       * ask, `maxDurationMs` bounds how long one turn can occupy a channel.
       */
      let step = 0;
      for (
        ;
        step < maxSteps && Date.now() - startedAt < maxDurationMs;
        step += 1
      ) {
        checkAbort();
        /*
         * Minted INSIDE the loop, which is the whole point: one assistant message per step.
         *
         * Declared one line above the loop it was still one message for the whole run, and that is
         * exactly the bug — the second attempt put a second id there and changed nothing, which is
         * worth saying because "a fresh id" and "a fresh id per step" look identical until you check
         * where the braces are.
         */
        const messageId = randomUUID();
        const pruned = pruneContext(messages, budget);
        if (pruned !== messages) messages.splice(0, messages.length, ...pruned);

        let stepText = "";
        const { calls: found } = await runStep(
          modelTools,
          (delta) => {
            stepText += delta;
            assistantText += delta;
            emit({
              type: EventType.TEXT_MESSAGE_CHUNK,
              role: "assistant",
              messageId,
              delta,
            });
          },
          (delta) => {
            emitReasoning(delta);
          },
          (call) => {
            emit({
              type: EventType.TOOL_CALL_START,
              parentMessageId: messageId,
              toolCallId: call.id,
              toolCallName: call.name,
            });
            if (call.argsJson && call.argsJson !== "{}") {
              emit({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: call.id,
                delta: call.argsJson,
              });
            }
            emit({ type: EventType.TOOL_CALL_END, toolCallId: call.id });
          },
        );

        if (found.length === 0) break;

        // The turn the model spoke, for the next request: text plus every call it made.
        messages.push({
          role: "assistant",
          content: stepText || null,
          tool_calls: found.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.argsJson },
          })),
        });

        // Server tools run here, in parallel; frontend tools end the turn for the browser.
        const serverCalls = found.filter((call) => serverTools.has(call.name));
        const browserCalls = found.filter(
          (call) => !serverTools.has(call.name),
        );
        const unknownCalls = browserCalls.filter(
          (call) => !frontendTools.has(call.name),
        );

        /*
         * HEARTBEAT, BECAUSE A TOOL RUNS SILENTLY AND SOMETHING IS COUNTING THE SILENCE.
         *
         * Between `TOOL_CALL_END` and `TOOL_CALL_RESULT` this loop emits nothing at all for the whole
         * time the tool takes — up to `REMI_TOOL_TIMEOUT_MS`, two minutes. A deployment runs a stall
         * watchdog over this stream (`server/src/channels/stall-guard.ts`) that ends any run silent for
         * `AGENT_STALL_TIMEOUT_MS`, shipped at 60s. A tool that took between one and two minutes was
         * therefore killed by the watchdog, mid-task, at about the 60-second mark: the tool finished,
         * its result was pushed into `messages`, and the turn had already been cancelled by the caller.
         * That is the single most common way this agent stops partway through work, and it is invisible
         * because the watchdog's own recovery writes a sentence blaming the Bot for going quiet.
         *
         * `REASONING_MESSAGE_CONTENT` is the right vehicle: the watchdog only counts time between
         * chunks and does not parse them, so nothing is displayed. Emitted at a quarter of the silence
         * the deployment is most likely to be configured with, so the gap between heartbeats stays well
         * inside even a 60s watchdog rather than merely inside a two-minute one.
         *
         * A no-op when reasoning is already streaming (`emitReasoning` owns `reasoningId`), because a
         * second interleaved reasoning stream would be a different thing to render. Text still arrives
         * on every step from the model's own chunks, so this only ever covers tool waits.
         */
        const heartbeat = () => {
          if (reasoningId) return;
          const heartbeatId = randomUUID();
          emit({ type: EventType.REASONING_START, messageId: heartbeatId });
          emit({
            type: EventType.REASONING_MESSAGE_START,
            messageId: heartbeatId,
            role: "reasoning",
          });
          emit({
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: heartbeatId,
            delta: "",
          });
          emit({
            type: EventType.REASONING_MESSAGE_END,
            messageId: heartbeatId,
            role: "reasoning",
          });
          emit({ type: EventType.REASONING_END, messageId: heartbeatId });
        };

        const results = await Promise.all(
          serverCalls.map(async (call) => {
            // Started for every call and torn down in the `finally`, so a tool that returns instantly
            // costs one `clearInterval` and a tool that hangs keeps beating until it settles.
            const beat = setInterval(heartbeat, heartbeatMs);
            beat.unref?.();
            let result: ToolResult;
            try {
              result = await executeServerTool(call.name, call.argsJson);
            } finally {
              clearInterval(beat);
            }
            /*
             * THE EVENT CARRIES TEXT, NEVER THE PICTURE.
             *
             * This is the transcript, the SSE stream and what persistence rebuilds rows from — every
             * observer of the run. A screenshot is ~90KB of base64, so putting one here means the
             * picture travels to every watcher of a turn to be drawn by none of them: the transcript
             * shows a sentence. The model gets the pixels one line below, in the context that is
             * the only place they are ever needed.
             */
            const said = toolResultText(result);
            calls.push({ name: call.name, args: call.argsJson, result: said });
            emit({
              type: EventType.TOOL_CALL_RESULT,
              role: "tool",
              messageId: randomUUID(),
              toolCallId: call.id,
              content: JSON.stringify(said),
            });
            return { id: call.id, name: call.name, result };
          }),
        );
        for (const { id, name, result } of results) {
          messages.push({
            role: "tool",
            tool_call_id: id,
            /*
             * The cast is because the OpenAI SDK types `tool` content as text-only parts while the
             * wire format has accepted an `image_url` part on a tool message since vision went
             * mainstream, and this loop already sends `image_url` parts on user messages through the
             * very same `ChatCompletionMessageParam`. Without the cast the type forbids sending a
             * screenshot back to a model that just asked for one, which is the bug being fixed.
             */
            content: toolResultContent(result, name),
          } as OpenAIMessage);
        }
        /*
         * Applied after the whole batch is pushed rather than inside it, because the cut is at the
         * last user message and every result in a batch shares that boundary. Applying it per result
         * would re-scan the entire conversation once per tool call, on a message list that reaches
         * 800k characters.
         */
        const demoted = demoteStaleToolImages(messages);
        if (demoted !== messages)
          messages.splice(0, messages.length, ...demoted);
        for (const call of unknownCalls) {
          const result = `Tool "${call.name}" is not available`;
          calls.push({ name: call.name, args: call.argsJson, result });
          emit({
            type: EventType.TOOL_CALL_RESULT,
            role: "tool",
            messageId: randomUUID(),
            toolCallId: call.id,
            content: JSON.stringify(result),
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result,
          });
        }

        const answered = browserCalls.filter((call) =>
          frontendTools.has(call.name),
        );
        if (answered.length > 0) {
          // Handed to the browser: the call events above are already on their way, and the
          // answers return as history on the next run. Ending here rather than synthesising
          // results is what keeps a gallery tap, a computer action and a human decision real.
          break;
        }
      }

      // Max steps reached mid-work: one final text-only pass so the turn ends on an answer,
      // not on a raw tool result. Pure Remi.
      const lastIsToolCall =
        messages.length > 0 &&
        messages[messages.length - 1]?.role === "assistant" &&
        ((messages[messages.length - 1] as { tool_calls?: unknown[] })
          .tool_calls?.length ?? 0) > 0;
      if (step >= maxSteps && lastIsToolCall) {
        // Its own message: this is a turn of its own, and reusing the loop's last id would merge
        // this closing answer into whichever step happened to be last.
        const summaryMessageId = randomUUID();
        try {
          await runStep(
            [],
            (delta) => {
              assistantText += delta;
              emit({
                type: EventType.TEXT_MESSAGE_CHUNK,
                role: "assistant",
                messageId: summaryMessageId,
                delta,
              });
            },
            (delta) => {
              emitReasoning(delta);
            },
            () => {},
          );
        } catch {
          // A failed summary pass must not fail a turn that already did its work.
        }
      }

      emit({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        finishReason: "stop",
        usage: [
          {
            provider: usedProvider,
            model: usedModel,
            inputTokens: promptTokens,
            outputTokens: completionTokens,
          },
        ],
      });

      const lastUser = [...history]
        .reverse()
        .find((message) => message.role === "user");
      try {
        const recalled = (input as { recalledMemories?: unknown })
          .recalledMemories;
        if (
          Array.isArray(recalled) &&
          recalled.length > 0 &&
          config.recordCited
        ) {
          const { citedMemoryIds } = await import("./memory-router");
          const cited = citedMemoryIds(
            recalled as Array<{ id: string; content: string }>,
            assistantText,
          );
          if (cited.length > 0) {
            await config.recordCited(cited);
          }
        }
      } catch {
        // Citation tracking must never fail a turn that already did its work.
      }
      try {
        config.onAfterRun?.({
          botId: config.botId,
          threadId: input.threadId,
          userText: lastUser ? textOfMessage(lastUser) : "",
          assistantText,
          calls,
          promptTokens,
          completionTokens,
        });
      } catch {
        // Housekeeping must never fail the turn it follows.
      }
    } catch (error) {
      if (signal.aborted || (error as Error)?.name === "AbortError") {
        /*
         * `RUN_ERROR`, NOT A BARE `RUN_FINISHED`.
         *
         * This path carries every abort a run can suffer: the person pressing Stop, the
         * `EnforcedAgent` loop breaker, and the channel's own deadline. It used to emit
         * `RUN_FINISHED` with no reason at all, and `RUN_FINISHED` is what the browser reads as
         * "the Bot finished and said nothing was wrong" — `channel-chat.tsx` clears its
         * `awaitingReply` flag on it and reports success, and `useStoppedTurn` does not even
         * subscribe to it. So a run killed halfway through a task put the composer back, dropped
         * the Working indicator, and told nobody. The transcript just stopped.
         *
         * A person stopping their own turn is the one case that should not be announced as a
         * failure, and the caller still has that: `onStop` clears its own `awaitingReply` before
         * aborting, and `fail()` ignores a run whose turn it is no longer awaiting. The message is
         * therefore a fact about the run, and each surface decides what to do with it.
         */
        emit({
          type: EventType.RUN_ERROR,
          message: abortReason(signal),
          threadId: input.threadId,
          runId: input.runId,
        });
        return;
      }
      throw error;
    }
  }
}
