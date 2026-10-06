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
import {
  type ResultBudgetClass,
  resultBudgetFor,
  shapeToolResultForContext,
} from "../plugins/result-budget";
import type { GrantedTool, ToolResult } from "../plugins/tools";
import { toolResultText } from "../plugins/tools";
import {
  buildModelChain,
  classifyProviderError,
  type ModelProvider,
  noModelError,
  ProviderRequestError,
} from "./model-router";

/**
 * The Remi agent loop, speaking AG-UI.
 *
 * remi.in runs a custom ReAct loop over OpenAI-compatible chat completions rather than a
 * framework agent runtime: up to 500 steps, parallel tool calls, per-step model fallback,
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
  model: { provider: ModelProvider; model: string };
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

const REMI_MAX_STEPS = 500;
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

/**
 * HOW MANY TIMES A RUN MAY ASK THE MODEL TO FINISH WHAT IT STARTED.
 *
 * The loop used to end the moment the model stopped asking for tools, which made a Bot that gave up
 * half way through a task indistinguishable from one that had finished it: same `RUN_FINISHED`, same
 * silence, no reason on the wire. Asking again is the fix, and this is the bound on how many times
 * it may ask — a model that has genuinely nothing left to say is asked this once more and then let
 * go, rather than narrated to indefinitely.
 */
const MAX_CONTINUATIONS = 3;

/**
 * THE WORDS A CONTINUATION IS ASKED WITH.
 *
 * Deliberately about the CONVERSATION and not about the loop. The model is told it has work in
 * progress and asked to finish it or say what stopped it; it is not told it is in a loop, how many
 * steps it has taken, or that anything is watching for the run to end. A nudge that describes its
 * own machinery is a nudge the model can satisfy by narrating instead of doing — the exact failure
 * this is here to prevent. Told what is outstanding rather than what to do about it, the same
 * weights either carry on or say honestly that they cannot.
 */
const CONTINUE_AFTER_WORK =
  "You have work in progress from this turn and have not finished it. If the task is complete, " +
  "give the person the result now. If it is not, take the next step. If you cannot continue, say " +
  "what is stopping you and what is left to do — do not stop silently.";

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

/**
 * Keep loop context small: full results are stored, the model gets what its budget allows.
 *
 * The bound is per TOOL, not per run, and that is the whole of the fix for app results losing their
 * contents. Gmail's answers parse as JSON, so they took the structured branch, where a 4,000-char
 * total sat behind a 1,500-char per-string and a 15-item per-array limit — a mailbox reduced to two
 * headers while the model was told only that the result was truncated. It could not tell a trimmed
 * mailbox from a short one, so it answered from what it had. See `./plugins/result-budget`, which
 * holds the bounds and is shared with the Composio transport so the callback path and this loop
 * cannot disagree about what a model is shown.
 *
 * A name is accepted as well as a tool because the exemption below is written against one, and a
 * tool that declares no class gets the screen bound — the one every desktop tool was written against
 * and the one unchanged here.
 */
export function truncateToolResultForContext(
  result: string,
  tool: string | { name: string; resultBudget?: ResultBudgetClass },
): string {
  if (
    typeof tool === "string"
      ? tool === "artifact_read"
      : tool.name === "artifact_read"
  ) {
    return result;
  }
  return shapeToolResultForContext(
    result,
    resultBudgetFor(
      typeof tool === "string" ? { resultBudget: budgetClassFor(tool) } : tool,
    ),
  );
}

/**
 * The bound a bare tool NAME gets, for the callers that hold nothing but one.
 *
 * This exists for one caller — a result arriving on its own, with no {@link GrantedTool} in reach —
 * and it is an INFERENCE, deliberately the only one in the tree: `mcp__` is what `toolNameFor` writes
 * for every granted vendor tool and `gog_` for the local Google CLI, and both return vendor data
 * rather than our own machine's screen. Everywhere a tool object exists the declaration on it is read
 * instead, so this cannot drift into being the authority.
 */
function budgetClassFor(toolName: string): ResultBudgetClass {
  return toolName.startsWith("mcp__") || toolName.startsWith("gog_")
    ? "app"
    : "screen";
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
  tool: string | { name: string; resultBudget?: ResultBudgetClass },
): OpenAIMessage["content"] {
  const text = truncateToolResultForContext(toolResultText(result), tool);
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

/**
 * The model said a call produced no answer before the history ended, so that gets one: a tool
 * message, straight after the call. No call ever ships unpaired — an assistant with an open call
 * is the one shape every provider refuses.
 */
export const UNANSWERED_CALL =
  "This call produced no result: the surface was interrupted before it could answer. Do not assume it succeeded.";

/**
 * Message history, in the shape the wire APIs require — not the row order in which the conversation
 * happens to be stored.
 *
 * The conversation is persisted one row per message, so an assistant message carrying one call and
 * an assistant message carrying the next call land side by side, and the two results land *after*
 * both, or even across a later exchange. Providers do not accept that, and DeepSeek rejects it
 * twice over with `400 An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'.`, which failed whole conversations server-side, the same way
 * `AI_MissingToolResultsError` did on routines:
 *
 * 1. assistant(tool_calls=[A]), assistant(tool_calls=[B]), tool(A), tool(B) — each call IS
 *    answered, so `sanitizeSeededHistory` keeps both, and a row-order conversion hands the pair
 *    off the way it was written. The wire format requires every assistant message with calls to be
 *    answered by ITS tool messages immediately after it, so the order in the rows is never right.
 * 2. tool(A), ..., assistant(tool_calls=[A]) — a result buried before its own call. The browser
 *    repairs that shape in `repair-history.ts`; history must not depend on the sender having
 *    remembered to call its own repair, so this pass does it too.
 *
 * Same for an assistant call with no result anywhere: `sanitizeSeededHistory` strips the call from
 * history, but a resume answer or a different surface may supply a result at the last moment, or
 * not at all — hence it ships with the caller entirely possible without an answer, it does not
 * exist here, and a little stub companion:
 *
 *   assistant(tool_calls=[A]), tool(A, UNANSWERED_CALL).
 *
 * WHAT IS DROPPED, unchanged from before: a tool row that answers nothing a kept call asked for —
 * it answers nothing, and a provider refuses it for the mirror-image reason.
 */
export function historyToOpenAI(history: Message[]): OpenAIMessage[] {
  /*
   * Pass 1: call ids of every assistant-made call, and every tool row available as an answer, by
   * location. Results may sit before, between, or after their call; they answer by id, wherever
   * they sat. First unconsumed result for a call id is the one the call gets — the later one is
   * a stored echo and answers nothing this conversion will reach for.
   */
  const toolRows: { index: number; toolCallId: string; message: Message }[] =
    [];
  for (const [index, message] of history.entries()) {
    if ((message as { role?: string }).role !== "tool") continue;
    const { toolCallId } = message as { toolCallId?: string };
    if (typeof toolCallId === "string")
      toolRows.push({ index, toolCallId, message });
  }
  /** Results this pass still owes a call. */
  const unclaimedByCallId = new Map<string, (typeof toolRows)[number][]>();
  for (const row of toolRows) {
    const list = unclaimedByCallId.get(row.toolCallId);
    if (list) list.push(row);
    else unclaimedByCallId.set(row.toolCallId, [row]);
  }

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
      // The contract above: whatever the stored order was, this call's answers FLANKED it in
      // history; they answer by id and land here, followed by a stub for what the interrupted
      // turn never supplied.
      for (const call of toolCalls ?? []) {
        const candidates = unclaimedByCallId.get(call.id) ?? [];
        const found = candidates.shift() ?? null;
        if (candidates.length === 0) unclaimedByCallId.delete(call.id);
        if (found) {
          out.push({
            role: "tool",
            tool_call_id: call.id,
            content: textOfMessage(found.message),
          });
        } else {
          out.push({
            role: "tool",
            tool_call_id: call.id,
            content: UNANSWERED_CALL,
          });
        }
      }
    } else if (role === "tool") {
    } else if (role === "system" || role === "developer") {
      const text = textOfMessage(message);
      if (text) out.push({ role: "system", content: text });
    }
  }
  return out;
}

/*
 * MEMOISED ON THE ZOD OBJECT. Built fresh per run from the tools list, but the schema is the same
 * one the grant produced, and `z.toJSONSchema` over an app catalogue is exactly the cost the
 * fromJSONSchema cache next door already pays. WeakMap so the entry dies with the grant cache's next
 * refresh rather than pinning a schema the deployment has since replaced.
 */
const jsonSchemaByZod = new WeakMap<z.ZodType, Record<string, unknown>>();

function grantedToolToOpenAI(tool: GrantedTool): OpenAITool {
  const held = jsonSchemaByZod.get(tool.parameters);
  let parameters: Record<string, unknown> = held ?? {
    type: "object",
    properties: {},
  };
  if (!held) {
    try {
      const schema = z.toJSONSchema(tool.parameters) as Record<string, unknown>;
      if (schema && typeof schema === "object") parameters = schema;
      jsonSchemaByZod.set(tool.parameters, parameters);
    } catch {
      // An unreadable schema must not stop the tool being offered: an open object lets the
      // model call it and the execution end validate the arguments instead.
    }
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

      /*
       * THE RUN'S OWN SIGNAL IS NOT THIS SUBSCRIPTION'S TO ABORT, and it used to be.
       *
       * This teardown fired on unsubscribe, which made "nobody is watching any more" and "stop
       * working" the same event. Everything that walks away from a run walks away from a
       * subscription first: a browser closing a tab, the SSE connection dropping, a component
       * unmounting, the metering wrapper detaching once it has read the usage it wanted. A person
       * who closes a tab has not asked for their work to stop, and the run had already been
       * designed to survive it — `threads/local.ts` says so in as many words, and the channel
       * deliberately keeps executing for up to the run budget after the browser is gone. That
       * promise was not true here.
       *
       * What a run ends on is now only what actually means it: `abortRun` and `abortRunWithReason`
       * from a caller that means to stop it — the person at the keyboard, the loop breaker, the
       * continuous-execution deadline. Those arrive as an abort on this same signal, because the
       * budgets are enforced by cancelling, so the two paths that matter are untouched by this.
       *
       * THE SIGNAL IS NOT ABANDONED, which is the obvious wrong turn. A run with no subscriber
       * still has to notice a stop, and it does: `emit` writes into an unsubscribed observer, which
       * is a no-op, and the abort lands on the same `controller.signal` the loop is watching. So
       * the run keeps working, keeps listening for a stop, and simply has nowhere to report to.
       */
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

    const checkAbort = () => {
      if (signal.aborted) {
        const error = new Error("The run was stopped.");
        error.name = "AbortError";
        throw error;
      }
    };

    /*
     * ONE REASONING LANE PER STEP, opened on the first delta and closed when the step's stream ends.
     *
     * This used to be a single `reasoningId` for the whole run, which was the same defect
     * `messageId` carried above and had the same fix: one id per step, not one per run. Three
     * things were wrong with sharing it, and only the first was visible.
     *
     * THE TRANSCRIPT: every step's thinking appended to one `{role: "reasoning"}` message, so a
     * ten-step turn drew a single thinking row holding all ten steps. The projection maps one
     * reasoning message to one row (`chat-messages.ts`), so per-step rows need per-step ids.
     *
     * NEVER CLOSED: no `REASONING_MESSAGE_END` or `REASONING_END` was ever emitted for real
     * reasoning, leaving the SDK's lane bookkeeping holding an open stream for the whole run.
     *
     * AND IT DISABLED THE HEARTBEAT, which is the one that ended turns. `heartbeat` below stands
     * down whenever reasoning is streaming, and "this run has reasoned" is not "reasoning is
     * streaming" — step 1 reasons, so from then on the guard was permanently true and no heartbeat
     * beat for the rest of the turn. A tool that took over a minute was then silent long enough for
     * the stall watchdog to end the turn and write `AGENT_STREAM_STALLED` over it, which is the
     * "stuck mid-work" report. The guard now reads the lanes that are open RIGHT NOW, and a step's
     * lane is closed before its tools run, which is exactly when the heartbeat is needed.
     *
     * A model that never reasons opens no lane and therefore emits no reasoning events at all,
     * which is what happened before any of this and is what should still happen.
     */
    type ReasoningLane = {
      /** Whether this lane has been opened and not yet closed. */
      readonly open: boolean;
      /** Append a delta, opening the lane on the first one. */
      push: (delta: string) => void;
      /** Emit the closing pair. A no-op on a lane that never opened. */
      close: () => void;
    };

    /** Every lane currently mid-stream, so a leak can be closed and a heartbeat can ask. */
    const openLanes = new Set<ReasoningLane>();

    const openReasoning = (): ReasoningLane => {
      let id: string | null = null;
      const lane: ReasoningLane = {
        get open() {
          return id !== null;
        },
        push: (delta: string) => {
          if (id === null) {
            id = randomUUID();
            openLanes.add(lane);
            emit({ type: EventType.REASONING_START, messageId: id });
            emit({
              type: EventType.REASONING_MESSAGE_START,
              messageId: id,
              role: "reasoning",
            });
          }
          emit({
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: id,
            delta,
          });
        },
        close: () => {
          if (id === null) return;
          const messageId = id;
          id = null;
          openLanes.delete(lane);
          emit({
            type: EventType.REASONING_MESSAGE_END,
            messageId,
            role: "reasoning",
          });
          emit({ type: EventType.REASONING_END, messageId });
        },
      };
      return lane;
    };

    /**
     * Close anything still open, for the paths that leave the loop without closing their own lane.
     *
     * The step body closes its lane in a `finally`, so this is the backstop rather than the
     * mechanism — an exception thrown between opening a lane and the `finally` that closes it would
     * otherwise reach the SDK as an unterminated stream. Cheap and idempotent, because `close` on a
     * closed lane does nothing.
     */
    const closeEveryReasoningLane = () => {
      for (const lane of [...openLanes]) lane.close();
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
      /*
       * A TOOL THAT TIMED OUT IS TOLD TO STOP, not merely walked away from.
       *
       * The run's own abort already reaches the tool through `signal`, but the timeout did not: the
       * race below resolved with a sentence, the model read it, and the tool carried on regardless. On
       * a computer that is the worst of the three outcomes. A `computer_click` that timed out had very
       * probably already been sent — the timeout is the RESPONSE being late, not the action — so the
       * click landed after the model had read "timed out", read the screen, seen no change, and clicked
       * again. That is a double press caused by our own bookkeeping, and it is the same shape as the
       * duplicate retries this file already had to reason about elsewhere.
       *
       * So a per-tool controller is derived from the run's signal and aborted when the deadline passes,
       * which is the only signal the tool has to distinguish "the run is over" from "you took too long
       * and must not act". It is a real cancellation for anything that honours a signal, and a no-op
       * for anything that does not — the same bargain the run's own abort makes, so nothing new is
       * being promised of a tool here.
       */
      const toolController = new AbortController();
      const onRunAbort = () => toolController.abort();
      if (signal.aborted) toolController.abort();
      else signal.addEventListener("abort", onRunAbort, { once: true });
      const toolSignal = toolController.signal;
      let timedOut = false;
      const timeout = new Promise<string>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          toolController.abort();
          resolve(
            `Tool "${name}" timed out after ${Math.round(effectiveTimeoutMs / 1000)} seconds. It may have partly run, so look at the screen before trying again rather than repeating the same action.`,
          );
        }, effectiveTimeoutMs);
      });
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
          tool.execute(parsed.data, toolSignal),
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
         *
         * A TIMEOUT is the third case, and it is not an abort of the RUN: `timedOut` says our own
         * deadline fired rather than a person pressing Stop, so the run carries on and the model is
         * waiting for an answer. The tool's abort surfaces here as a rejection, and answering it as
         * "Error: The operation was aborted" would describe our bookkeeping rather than what
         * happened — so the timeout sentence is returned instead, which is the one that tells the
         * model to look before acting again.
         */
        if (timedOut) {
          return `Tool "${name}" timed out after ${Math.round(effectiveTimeoutMs / 1000)} seconds. It may have partly run, so look at the screen before trying again rather than repeating the same action.`;
        }
        if (signal.aborted || (error as Error)?.name === "AbortError") {
          throw error;
        }
        // A throwing tool answers with its failure, the Remi way: the model reads the error
        // and works around it rather than the run ending with nothing said.
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        signal.removeEventListener("abort", onAbort);
        signal.removeEventListener("abort", onRunAbort);
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
      /*
       * WHAT THE LOOP KNOWS ABOUT THE TASK, WHICH IS NOT THE SAME AS WHAT THE MODEL SAYS.
       *
       * `workedThisTurn` is the fact the whole continuation rule turns on: this run has actually
       * done something, rather than answered in one step. It is set when a tool runs, which is a
       * fact about the wire and not a judgement about the model — a model that called a tool and
       * then said nothing has left something unfinished by definition, because the tool's result is
       * sitting in its context unanswered.
       *
       * `continuations` is how many times this run has been asked to finish, and it is bounded
       * because the alternative to a bound is a Bot that narrates "let me continue" until its time
       * budget expires, which is a worse thing to watch than an honest early stop.
       */
      let workedThisTurn = false;
      let continuations = 0;
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
        /*
         * THIS STEP'S REASONING LANE, closed in the `finally` below rather than at each exit.
         *
         * Closing on the way out of `runStep` is what makes the heartbeat work again: the tools that
         * follow run with no lane open, so `heartbeat` beats through exactly the window where a slow
         * tool used to be mistaken for a dead Bot. A `finally` rather than a statement after the call
         * because an abort mid-stream throws out of `runStep` with the lane open, and that is the
         * case that must not leak one.
         */
        const reasoning = openReasoning();
        let found: StreamedCall[];
        try {
          ({ calls: found } = await runStep(
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
              reasoning.push(delta);
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
          ));
        } finally {
          reasoning.close();
        }

        /*
         * THE MODEL STOPPED ASKING FOR TOOLS, which is where a run used to end — silently, on the
         * model's own judgement, with nothing on the wire to say whether the task was finished.
         *
         * THAT IS FINE FOR A CONVERSATION and wrong for a job. "Hi" produces no tool calls and
         * nothing is outstanding; a model that has just read four files and then said no more has
         * left its own work unanswered, and the browser cannot tell the two apart: both arrive as
         * `RUN_FINISHED` with the same silence. So the distinction made here is whether this run has
         * DONE anything, which is on the wire, rather than whether the answer looks finished, which
         * is not something this loop can see.
         *
         * ASKED AT MOST `MAX_CONTINUATIONS` TIMES, and the continuation is a turn in the
         * conversation rather than a message to the machinery — see `CONTINUE_AFTER_WORK` for why
         * that wording is the load-bearing part. A model that cannot get further says so in the
         * next step, which is the answer this whole change is after: a Bot that is stuck now says
         * it is stuck, rather than going quiet and being read as finished.
         */
        if (found.length === 0) {
          if (
            !workedThisTurn ||
            stepText.trim() !== "" ||
            continuations >= MAX_CONTINUATIONS ||
            step + 1 >= maxSteps ||
            Date.now() - startedAt >= maxDurationMs
          ) {
            break;
          }
          continuations += 1;
          /*
           * AS A USER TURN, which is what it is: something the person has not said, standing in for
           * the "and?" they are not there to type. A system turn would put machinery into the
           * conversation and a model is far more likely to comply with a system instruction than
           * with one wearing a person's clothes — so the words ask rather than instruct, and the
           * rest of the message says what a person would have said, which is the question.
           */
          messages.push({
            role: "user",
            content: CONTINUE_AFTER_WORK,
          });
          continue;
        }

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
         * A no-op only while a reasoning lane is ACTUALLY mid-stream, because a second interleaved
         * reasoning stream would be a different thing to render. Text still arrives on every step
         * from the model's own chunks, so this only ever covers tool waits.
         *
         * `openLanes.size`, and not a flag saying this run has ever reasoned. That flag is what
         * disabled this heartbeat: step 1 reasons, the flag latches, and every tool call after it
         * ran unannounced — so a tool that took over a minute was ended by the watchdog at 60s with
         * a sentence blaming the Bot. A step's lane is closed before its tools run (see the `finally`
         * by `runStep`), so the window this needs to cover is exactly the one with no lane open.
         */
        const heartbeat = () => {
          if (openLanes.size > 0) return;
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

        /*
         * THE FACT THE CONTINUATION RULE TURNS ON, recorded here because this is where "this run
         * did something" becomes true. It is set the moment a tool is dispatched rather than when
         * it returns, so a tool that throws — which is a result too, the Remi way — still counts as
         * work and the run is still asked to finish what it started.
         */
        if (serverCalls.length > 0) workedThisTurn = true;

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
            /*
             * The TOOL, not its name, so the result is cut with the budget that tool declared. A name
             * would have to be guessed back into a class, and a guess is what put a 4,000-character
             * bound on a mailbox in the first place.
             */
            return {
              id: call.id,
              name: call.name,
              result,
              tool: serverTools.get(call.name),
            };
          }),
        );
        for (const { id, result, tool } of results) {
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
            content: toolResultContent(
              result,
              /*
               * An unknown tool answers with one sentence about itself having no execute function, so
               * there is nothing here worth a budget of its own. An empty name takes the screen
               * bound, which is the one that was always applied to it.
               */
              tool ?? { name: "" },
            ),
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

      /*
       * WHY THE RUN ENDED, in the words of whatever ended it.
       *
       * Every terminal path used to emit the same bare `RUN_FINISHED` with `finishReason: "stop"`,
       * so a turn that ran out of steps, one that ran out of time, and one the model simply ended
       * were the same event on the wire. The browser has one surface for "this turn ended without
       * an answer" and prints whatever it is given, so a run cut short at a limit was drawn as a run
       * that finished — which is the whole reason the client now treats a stated reason as something
       * to show even when text came back.
       *
       * The step and time budgets are checked in this order because they are also the order a
       * person can act on: "you ran out of room" is a different fact from "you ran out of time", and
       * a run that ended because the model stopped asking for tools says neither.
       */
      const outOfSteps = step >= maxSteps;
      const outOfTime = Date.now() - startedAt >= maxDurationMs;
      /*
       * A SUMMARY PASS THAT FAILED IS A RUN THAT ENDED WITHOUT SAYING, and it used to be a
       * `RUN_FINISHED` with no text on it at all: the `catch` below swallowed the failure and the
       * turn fell through to the finish event having produced nothing a person could read. That is
       * the one terminal path that was genuinely silent rather than merely unexplained, and it is
       * what a person meets when a provider refuses the closing request after a long job.
       */
      let summaryFailed = false;

      // Max steps reached mid-work: one final text-only pass so the turn ends on an answer,
      // not on a raw tool result. Pure Remi.
      const lastIsToolCall =
        messages.length > 0 &&
        messages[messages.length - 1]?.role === "assistant" &&
        ((messages[messages.length - 1] as { tool_calls?: unknown[] })
          .tool_calls?.length ?? 0) > 0;
      if (outOfSteps && lastIsToolCall) {
        // Its own message: this is a turn of its own, and reusing the loop's last id would merge
        // this closing answer into whichever step happened to be last.
        const summaryMessageId = randomUUID();
        /*
         * Its own lane, on the same terms as a step's: this pass is a turn of its own, so it gets its
         * own reasoning message rather than appending to whichever step the budget ran out on.
         */
        const summaryReasoning = openReasoning();
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
              summaryReasoning.push(delta);
            },
            () => {},
          );
        } catch {
          /*
           * The turn's WORK must not be failed by its closing sentence — everything above stands.
           * But the run did end without an answer, and this is the place that says so, because after
           * this catch the finish event below is the only thing left the browser will see.
           */
          summaryFailed = true;
        } finally {
          summaryReasoning.close();
        }
      }

      /*
       * Nothing above leaves a lane open — each step and the summary pass close their own in a
       * `finally` — so this is the assertion rather than the mechanism, and it runs once per run
       * rather than once per step. A lane still open here would reach the SDK as a reasoning stream
       * that never terminates, which is the shape that leaves it holding lane bookkeeping for a run
       * that has already finished.
       */
      closeEveryReasoningLane();

      const finishReason = summaryFailed
        ? "The work is done, but the Bot could not summarize it: its closing request failed. " +
          "What it did is above."
        : outOfSteps
          ? `This turn used all ${maxSteps} steps of its budget and was ended. What it did is above, ` +
            `and there may be more to do.`
          : outOfTime
            ? `This turn ran out of time (${Math.round(maxDurationMs / 60_000)} minutes) and was ` +
              `ended. What it did is above, and there may be more to do.`
            : `This turn ended before the Bot finished answering.`;

      emit({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        finishReason: "stop",
        /*
         * The sentence the browser prints under the transcript when a turn ends without an answer.
         * Emitted only when the run genuinely has nothing to show: a turn that answered normally
         * carries no message here, because a notice under every successful answer would be noise
         * rather than information.
         */
        ...(assistantText.trim() === "" ||
        summaryFailed ||
        outOfSteps ||
        outOfTime
          ? { message: finishReason }
          : {}),
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
      /*
       * The abort path, where a lane can still be open: every step closes its own in a `finally`,
       * but an abort thrown between opening a lane and reaching it — or out of the `results` wait,
       * which no step owns — would otherwise leave the SDK holding a reasoning stream that never
       * terminates. Closed before the run announces its own ending, so the last thing on the wire is
       * a terminated lane rather than an open one.
       */
      closeEveryReasoningLane();
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
