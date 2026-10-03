/**
 * The conversation AG-UI carries, as LangChain's message classes.
 *
 * Its own module so it can be tested without starting a server: `index.ts` calls `serve()` at module
 * scope, so importing it to reach one pure function binds a port. `agent-computer/src/control.ts`
 * was split out for the same reason, to keep state-machine tests away from a browser.
 */
import type { RunAgentInput } from "@ag-ui/core";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { COMPUTER_GUIDANCE, NO_ANSWER_CAME } from "../../shared/bot-prompt";
import { userContent } from "../../shared/user-content";

/*
 * Re-exported so this module's own tests and callers keep reading it from here, while the wording
 * itself lives in `shared` where the other Bot can reach it. Both have to say the same thing.
 */
export { NO_ANSWER_CAME };

/**
 * The providers that take one system prompt, and take it first.
 *
 * Anthropic's Messages API has the system prompt as a field of the request rather than as a turn,
 * and Gemini has it as `systemInstruction`, so neither integration has anywhere to put a second one:
 * `@langchain/anthropic` throws "System messages are only permitted as the first passed message."
 * and `@langchain/google-genai` throws "System message should be the first one", both before any
 * request is made. OpenAI takes a system turn anywhere in a conversation.
 */
const ONE_SYSTEM_PROMPT = new Set(["anthropic", "google"]);

/** Translate the conversation AG-UI carries into LangChain's message classes. */
export function toLangChainMessages(
  input: RunAgentInput,
  provider = "openai",
): BaseMessage[] {
  const messages: BaseMessage[] = [
    new SystemMessage(COMPUTER_GUIDANCE),
    // AG-UI carries application context separately from conversation history. CopilotKit puts
    // the A2UI catalog and tool instructions here; dropping it leaves the model guessing the
    // component schema and can strand the renderer on an invalid, never-painted surface.
    ...(input.context ?? []).map(
      ({ description, value }) => new SystemMessage(`${description}\n${value}`),
    ),
  ];

  /*
   * Which calls are still waiting for a result, walked in order rather than
   * collected up front.
   *
   * A tool call the surface owns ends the run without a result on purpose: the
   * surface draws it, or puts it to a person, and starts the next run carrying
   * the answer. When nobody answers — a Bot asks for the wheel to get past a
   * sign-in and the person decides they do not need it after all — no answer is
   * ever carried, and the call stays in the history with nothing following it.
   *
   * OpenAI rejects that outright on the NEXT turn: "an assistant message with
   * 'tool_calls' must be followed by tool messages responding to each
   * 'tool_call_id'". So the conversation was not merely stuck on that request, it
   * was finished. Every later message failed the same way, and the only escape
   * was starting a new one, which loses it.
   *
   * WHY THIS IS A WALK AND NOT A SET. The obvious implementation gathers every
   * `tool_call_id` that appears anywhere in the history and treats a call as
   * answered if its id is in that set. It is wrong, and wrong in the way that
   * produces the very error above: the set has no position, so a result that
   * sits BEFORE the assistant message declaring the call marks it answered, the
   * closing message is not written, and the assistant message goes to the
   * provider with nothing after it. A run that was cut short mid-tool-loop and
   * replayed does exactly that, which is why this arrived as a hard 400 on an
   * ordinary follow-up rather than as something visible in the transcript.
   */
  let pending: Array<{ id: string; name: string }> = [];

  /*
   * Answer whatever is still open, in the position the provider requires.
   *
   * Not cosmetic: a tool result has to follow the assistant message that made
   * the call, so these are written here rather than collected for the end. A
   * real answer arriving later in the history is matched and consumed in its own
   * turn instead.
   */
  const closePending = () => {
    for (const call of pending) {
      messages.push(
        new ToolMessage({
          tool_call_id: call.id,
          content: NO_ANSWER_CAME,
          name: call.name,
        }),
      );
    }
    pending = [];
  };

  for (const message of input.messages) {
    if (message.role === "user") {
      // A person speaking ends the previous turn's calls: whatever they are
      // still waiting for will never be answered now.
      closePending();
      messages.push(
        new HumanMessage({ content: userContent(message.content) }),
      );
      continue;
    }
    if (message.role === "system" || message.role === "developer") {
      closePending();
      messages.push(new SystemMessage(String(message.content ?? "")));
      continue;
    }
    if (message.role === "tool") {
      const id = (message as { toolCallId?: string }).toolCallId;
      /*
       * A result with nothing open to answer is dropped rather than written.
       *
       * Two shapes land here. A result whose call is missing altogether is an
       * orphan from a truncated history, and a duplicate id is a replayed
       * result. Neither can be placed, because a result that does not directly
       * follow its assistant message is itself a rejection — so carrying it
       * forward would trade one provider refusal for another.
       */
      const match = pending.findIndex((call) => call.id === id);
      if (match === -1) continue;
      const [call] = pending.splice(match, 1);
      messages.push(
        new ToolMessage({
          tool_call_id: id as string,
          content: String(message.content ?? ""),
          name: call?.name,
        }),
      );
      continue;
    }
    if (message.role === "assistant") {
      // A second assistant turn cannot answer the first one's calls.
      closePending();
      const calls = message.toolCalls ?? [];
      /*
       * Each call's id, resolved ONCE and used for both the message written to
       * the provider and the entry left open below.
       *
       * A call that arrives without an id cannot be closed by a matching result,
       * because there is nothing to match, so it would reach the provider
       * unanswered and take the whole run down. Naming it here means the closing
       * message can answer it. It has to be the same name in both places: derived
       * twice it is two names, and the message written to the model names a call
       * that the closing message does not answer — the original error, rebuilt.
       */
      const identified = calls.map((call) => ({
        id:
          call.id ||
          `unanswered_call_${messages.length}_${calls.indexOf(call)}`,
        name: callDetails(call).name,
        args: parseArguments(callDetails(call).arguments),
      }));
      messages.push(
        new AIMessage({
          content: message.content ?? "",
          tool_calls: identified,
        }),
      );
      pending = identified.map(({ id, name }) => ({ id, name }));
    }
  }
  // The history can end on an open call: a run that was cut off mid-loop.
  closePending();

  /*
   * A run that carries no human turn is answered by OpenAI and refused by the strict providers.
   *
   * OpenAI tolerates a history that opens on an assistant or tool message. Anthropic and the strict
   * OpenAI-compatible providers (z.ai GLM among them) require the first non-system message to be a
   * human one, and will not answer a history that is only deltas: an assistant turn and its tool
   * results with nothing a person said to respond to. A follow-up run continuing after a tool result
   * is exactly that shape, so on those providers it came back empty and the run ended in silence.
   *
   * A neutral continuation turn gives them one to answer. It is appended only when the history holds
   * no human turn at all, so a normal conversation is untouched, and OpenAI — which already answered
   * the same history — sees no change beyond one trailing line asking it to continue.
   */
  const hasHumanTurn = messages.some(
    (message): message is HumanMessage => message instanceof HumanMessage,
  );
  if (!hasHumanTurn) {
    messages.push(new HumanMessage(CONTINUE_TURN));
  }

  /*
   * Every run holds more than one system message, so on those providers every run failed.
   *
   * The computer guidance opens this list and the caller's context follows it, and the server puts a
   * coworker's standing role at the head of `input.messages` on every run it sends a remote Bot. A
   * skill somebody picks arrives as a system turn ahead of their message, too. So a Bot set to
   * `BOT_PROVIDER=anthropic` or `google` answered nothing at all: each run ended in the integration's
   * refusal, before the model was asked.
   *
   * Folded into one, in the order given, and only for those providers. On OpenAI a skill's
   * instruction stays beside the message it was picked for.
   */
  return ONE_SYSTEM_PROMPT.has(provider)
    ? withOneSystemPrompt(messages)
    : messages;
}

/** The continuation a strict provider needs when a run carries only deltas. See toLangChainMessages. */
const CONTINUE_TURN = "Continue from where the conversation above left off.";

/** Every system message's text as one system message at the top, and the rest as they were. */
function withOneSystemPrompt(messages: BaseMessage[]): BaseMessage[] {
  const system = messages.filter((message) => message instanceof SystemMessage);
  return [
    new SystemMessage(
      system.map((message) => String(message.content)).join("\n\n"),
    ),
    ...messages.filter((message) => !(message instanceof SystemMessage)),
  ];
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * A tool call's name and arguments, in whichever dialect it arrived in.
 *
 * TWO SPELLINGS, ONE CALL. AG-UI describes `{id, type: "function", function: {name, arguments}}` and
 * the history store writes `{id, name, args}`. Read back from a thread, every call arrives in the
 * second, so `call.function.name` here did not merely degrade: it threw, and took the run with it.
 */
function callDetails(call: {
  function?: { name?: unknown; arguments?: unknown };
  name?: unknown;
  args?: unknown;
}): { name: string; arguments: string } {
  const name = call.function?.name ?? call.name;
  const args = call.function?.arguments ?? call.args;
  return {
    name: typeof name === "string" && name ? name : "tool",
    arguments:
      typeof args === "string"
        ? args
        : args === undefined || args === null
          ? "{}"
          : JSON.stringify(args),
  };
}
