import { describe, expect, test } from "bun:test";
import { RESULT_BUDGETS } from "../src/plugins/result-budget";
import {
  buildModelChain,
  classifyProviderError,
  ProviderRequestError,
} from "../src/remi/model-router";
import {
  demoteStaleToolImages,
  historyToOpenAI,
  type OpenAIMessage,
  pruneContext,
  toolResultContent,
  truncateToolResultForContext,
} from "../src/remi/loop-agent";

/**
 * The Remi loop's pure parts: history conversion, context pruning, result truncation, and
 * model chain building. The live loop itself is exercised against LLMock in
 * copilot.test.ts and run-built-agent-cancellation.test.ts; what pins the contract here is
 * the pairing discipline (calls and results prune together, or the provider refuses the
 * turn) and the chain precedence (explicit choice first, null key fails fast).
 */

describe("historyToOpenAI", () => {
  test("carries text, calls and results across", () => {
    const messages = historyToOpenAI([
      { id: "u1", role: "user", content: "hi" },
      {
        id: "a1",
        role: "assistant",
        content: "calling",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "x", arguments: '{"a":1}' },
          },
        ],
      },
      { id: "t1", role: "tool", content: "done", toolCallId: "c1" },
    ] as never[]);

    expect(messages).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "calling",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "x", arguments: '{"a":1}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "done" },
    ]);
  });

  test("keeps skill instruction system rows instead of dropping them", () => {
    const messages = historyToOpenAI([
      { id: "s1", role: "system", content: "Use the audit skill." },
      { id: "u1", role: "user", content: "go" },
    ] as never[]);

    expect(messages).toEqual([
      { role: "system", content: "Use the audit skill." },
      { role: "user", content: "go" },
    ]);
  });

  test("drops a tool result with no call to answer", () => {
    const messages = historyToOpenAI([
      { id: "t1", role: "tool", content: "orphan" },
    ] as never[]);

    expect(messages).toEqual([]);
  });
});

describe("pruneContext", () => {
  const assistantWithCall = (id: string): OpenAIMessage => ({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: { name: "x", arguments: "{}" },
      },
    ],
  });

  test("leaves a small history alone, same array", () => {
    const messages: OpenAIMessage[] = [
      { role: "system", content: "role" },
      { role: "user", content: "hi" },
    ];
    expect(pruneContext(messages, 800_000)).toBe(messages);
  });

  test("prunes oldest call blocks first, calls with their results", () => {
    const big = "x".repeat(10_000);
    const messages: OpenAIMessage[] = [
      { role: "system", content: "role" },
      { role: "user", content: "first" },
      assistantWithCall("c1"),
      { role: "tool", tool_call_id: "c1", content: big },
      { role: "user", content: "second" },
      assistantWithCall("c2"),
      { role: "tool", tool_call_id: "c2", content: big },
      { role: "user", content: "latest" },
    ];
    const pruned = pruneContext(messages, 15_000);

    // The latest exchange survives; the oldest block went as a pair.
    expect(pruned[pruned.length - 1]).toMatchObject({
      role: "user",
      content: "latest",
    });
    const calls = pruned.flatMap((message) =>
      message.role === "assistant" ? (message.tool_calls ?? []) : [],
    );
    const results = pruned
      .filter((message) => message.role === "tool")
      .map((message) => (message as { tool_call_id: string }).tool_call_id);
    expect(new Set(calls.map((call) => call.id))).toEqual(new Set(results));
    expect(pruned.length).toBeLessThan(messages.length);
  });
});

describe("truncateToolResultForContext", () => {
  test("short results pass through", () => {
    expect(truncateToolResultForContext('{"ok":true}', "x")).toBe(
      '{"ok":true}',
    );
  });

  test("a long plain answer is cut to the bound and says how much was dropped", () => {
    const result = truncateToolResultForContext("y".repeat(10_000), "x");
    expect(result.length).toBeLessThan(10_000);
    /*
     * The note names what was left out, in characters out of characters, plus the remedy. The old
     * marker said only "Truncated", which told a model that something had been cut and nothing about
     * what — so a cut from 10,000 characters and a cut from 4,001 were the same text, and neither was
     * distinguishable from a short answer. The numbers are what the model acts on.
     */
    expect(result).toContain("This is not everything the action returned");
    expect(result).toContain("of 10000 characters are shown");
    expect(result).toContain("fetch the next page");
  });

  test("a cut never exceeds the bound it was cut to", () => {
    /*
     * THE BUG THIS PINS. The cut reserved a fixed 200 characters for a note that is longer than 200
     * characters whenever the remainder is large, so the answer came out OVER the ceiling it was cut
     * to — the bound promised a number and the result did not honour it, which is the one thing a
     * bound is for.
     */
    for (const length of [4_001, 60_000, 200_000]) {
      const result = truncateToolResultForContext("y".repeat(length), "x");
      expect(`${length}: ${result.length <= 4_000}`).toBe(`${length}: true`);
    }
  });

  test("artifact reads are exempt", () => {
    const content = "z".repeat(10_000);
    expect(truncateToolResultForContext(content, "artifact_read")).toBe(
      content,
    );
  });

  test("a screen tool keeps the bound it was always held to", () => {
    expect(RESULT_BUDGETS.screen.total).toBe(4_000);
    expect(
      truncateToolResultForContext("y".repeat(10_000), "computer_read").length,
    ).toBeLessThanOrEqual(4_000);
  });

  test("an app tool keeps what a screen bound would have cut", () => {
    /*
     * THE GMAIL CASE, as a unit test rather than as a bug report. A list of messages is JSON, so it
     * took the structured branch, where 1,500 characters per string and 15 items per array sat
     * behind a 4,000-character total. Sixty messages were four entries, and the model was told only
     * that the result was truncated — so it could not tell a trimmed mailbox from a short one and
     * answered from what it had.
     *
     * THE SHAPE IS GMAIL'S, not a caricature: a short snippet, and headers of the length Gmail sends.
     * A fixture of 2,800-character snippets would prove the budget still truncates, which it does and
     * must — twenty thousand characters is twenty thousand characters. What it must not do is cut a
     * page the vendor was asked for in half, and that is what a realistic page plus a sane default
     * page size buys.
     */
    const page = Array.from({ length: 25 }, (_, index) => ({
      id: `m${index}`,
      threadId: `t${index}`,
      snippet: `Invoice ${index} is attached, please review before Friday.`,
      internalDate: `1${index}7000000000`,
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "Subject", value: `Invoice ${index}` },
          { name: "From", value: "billing@example.com" },
          { name: "Date", value: "Mon, 5 Oct 2026 09:00:00 +0000" },
          { name: "Message-Id", value: `<${index}.abc@example.com>` },
        ],
      },
    }));
    const result = JSON.stringify({ messages: page });

    const asApp = truncateToolResultForContext(result, {
      name: "mcp__composio-gmail__GMAIL_FETCH_EMAILS",
      resultBudget: "app",
    });
    const asScreen = truncateToolResultForContext(result, "computer_read");

    expect(asApp.length).toBeLessThanOrEqual(RESULT_BUDGETS.app.total);
    expect(asScreen.length).toBeLessThanOrEqual(RESULT_BUDGETS.screen.total);
    // The screen bound stops at the fifteenth item; the app bound reaches the whole page.
    expect(asScreen).not.toContain('"id":"m20"');
    expect(asApp).toContain('"id":"m24"');
    // And whatever the shortfall is, it is stated with a remedy rather than as "truncated", which is
    // the marker that made a trimmed mailbox indistinguishable from a short one.
    expect(asScreen).toContain("This is not everything the action returned");
    expect(asScreen).toContain("10 array items were omitted from it");
    expect(asScreen).toContain("fetch the next page");
  });

  test("a declared class beats the name it arrived with", () => {
    /*
     * The declaration is the authority and the name is the fallback, which is the other way round
     * from what a name-based rule would do. A granted tool is named `mcp__…` and declared `app`; a
     * local one is named `gog_gmail_search` and declared `app`; a desktop one is named `computer_…`
     * and declared nothing. Reading the declaration first means renaming a tool cannot silently
     * change how much of its answer a model is shown.
     */
    const long = "y".repeat(10_000);
    expect(
      truncateToolResultForContext(long, {
        name: "computer_read",
        resultBudget: "app",
      }).length,
    ).toBeLessThanOrEqual(RESULT_BUDGETS.app.total);
    expect(
      truncateToolResultForContext(long, "gog_gmail_read").length,
    ).toBeLessThanOrEqual(RESULT_BUDGETS.app.total);
    expect(
      truncateToolResultForContext(long, "computer_read").length,
    ).toBeLessThanOrEqual(RESULT_BUDGETS.screen.total);
  });

  test("shaping is idempotent, which is what lets two paths both do it", () => {
    /*
     * The transport shapes a Composio result and the loop shapes it again on its way into the
     * context. If the second pass could change anything, the answer a model receives would depend on
     * which of the two topologies the deployment runs — which is precisely the disagreement that
     * made this a shared module rather than a rule in one of them.
     */
    const messages = Array.from({ length: 40 }, (_, index) => ({
      id: `m${index}`,
      body: { mimeType: "text/plain", data: "QUJDREVGRw".repeat(900) },
      snippet: `Message ${index}: ${"detail ".repeat(300)}`,
    }));
    const once = truncateToolResultForContext(
      JSON.stringify({ messages }),
      "mcp__composio-gmail__GMAIL_FETCH_EMAILS",
    );
    const twice = truncateToolResultForContext(
      once,
      "mcp__composio-gmail__GMAIL_FETCH_EMAILS",
    );
    expect(twice).toBe(once);
  });
});

/**
 * DeepSeek-only.
 *
 * The chain used to be every provider holding a key, which made the LAST one the error a turn
 * failed with: an unfunded Novita account sat at the end, so a turn where DeepSeek or OpenRouter
 * refused the request surfaced as `403 NOT_ENOUGH_BALANCE` from a vendor the deployment never
 * chose, and the real failure was discarded upstream. These cases pin the shape that replaced it —
 * one provider, one model, and a refusal that names DeepSeek.
 */
describe("buildModelChain", () => {
  const env = {
    DEEPSEEK_API_KEY: "deepseek-key",
    OPENAI_API_KEY: "openai-key",
    OPENAI_BASE_URL: "https://gateway.internal/v1",
    OPENROUTER_API_KEY: "openrouter-key",
    NOVITA_API_KEY: "novita-key",
  };

  test("one link: deepseek on deepseek-flash", () => {
    const chain = buildModelChain(
      { provider: "openai", model: "gpt-5.6-terra" },
      env,
      "resolved-key",
    );

    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-flash",
    });
  });

  test("a base URL may move the endpoint but never the provider or the model", () => {
    // A proxy or gateway in front of DeepSeek is a supported shape, and the four cases in
    // `model-providers.test.ts` exist for it. What a base URL may no longer do is pick a vendor:
    // that coupling is how a chain ever reached Novita.
    const chain = buildModelChain(
      { provider: "openai", model: "gpt-5.6-terra" },
      { ...env, OPENAI_BASE_URL: "http://127.0.0.1:9999/proxy/v1" },
      "resolved-key",
    );

    expect(chain[0]?.client.baseURL).toBe("http://127.0.0.1:9999/proxy/v1");
    expect(chain[0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-flash",
    });
  });

  test("a blank base URL falls back to DeepSeek's own endpoint", () => {
    const chain = buildModelChain(
      { provider: "openai", model: "deepseek-flash" },
      { DEEPSEEK_API_KEY: "k", OPENAI_BASE_URL: "" },
      "resolved-key",
    );

    expect(chain[0]?.client.baseURL).toBe("https://api.deepseek.com/v1");
  });

  test("other providers' keys never become links", () => {
    const chain = buildModelChain(
      { provider: "openai", model: "m" },
      { OPENROUTER_API_KEY: "k", NOVITA_API_KEY: "k" },
      "k",
    );

    for (const link of chain) expect(link.provider).toBe("deepseek");
  });

  test("a null key fails fast with an empty chain", () => {
    expect(
      buildModelChain(
        { provider: "openai", model: "x" },
        { OPENAI_API_KEY: "k" },
        null,
      ),
    ).toEqual([]);
    expect(
      buildModelChain({ provider: "openai", model: "x" }, {}, undefined),
    ).toEqual([]);
  });

  test("a key in the environment is not the caller's to spend", () => {
    // Several callers pass a null key MEANING IT — `copilot.buildAgents` refuses an unconfigured
    // deployment with one sentence, `memory-extract` returns early. A key read from the environment
    // behind their back would turn that named failure into a real request dialed with a key nobody
    // chose, so resolution belongs to `resolveModelApiKey` and nowhere else.
    expect(
      buildModelChain({ provider: "openai", model: "x" }, env, null),
    ).toEqual([]);
  });

  test("REMI_FLASH_MODEL renames the one model", () => {
    const chain = buildModelChain(
      { provider: "openai", model: "x" },
      { ...env, REMI_FLASH_MODEL: "deepseek-v4-pro" },
      "k",
    );

    expect(chain[0]?.model).toBe("deepseek-v4-pro");
  });
});

/**
 * A provider refusal, named.
 *
 * The point of every case here is the sentence a person reads. The vendor envelope that reached
 * the chat composer — `{"code":403,"reason":"NOT_ENOUGH_BALANCE","message":"not enough
 * balance"}` — is the exact text this replaces, so each test asserts both that the failure is
 * classified and that the envelope is gone from `message`.
 */
describe("classifyProviderError", () => {
  const link = { provider: "deepseek", model: "deepseek-flash" };

  test("DeepSeek's 402 insufficient_balance reads as out of funds", () => {
    const error = Object.assign(new Error("insufficient_balance"), {
      status: 402,
      error: { code: "insufficient_balance", message: "insufficient_balance" },
    });

    const classified = classifyProviderError(link, error);

    expect(classified).toBeInstanceOf(ProviderRequestError);
    const named = classified as ProviderRequestError;
    expect(named.kind).toBe("out_of_funds");
    expect(named.provider).toBe("deepseek");
    expect(named.message).toContain("out of credits");
    expect(named.message).not.toContain("insufficient_balance");
    expect(named.message).not.toContain("{");
    // The vendor's own text is kept for the log, not thrown away.
    expect(named.detail).toContain("insufficient_balance");
  });

  test("Novita's 403 NOT_ENOUGH_BALANCE is out of funds, not a permission failure", () => {
    const error = Object.assign(new Error("not enough balance"), {
      status: 403,
      error: {
        code: 403,
        reason: "NOT_ENOUGH_BALANCE",
        message: "not enough balance",
      },
    });

    const named = classifyProviderError(link, error) as ProviderRequestError;

    expect(named.kind).toBe("out_of_funds");
    expect(named.code).toBe("NOT_ENOUGH_BALANCE");
    expect(named.message).toContain("deepseek");
  });

  test("a 403 about moderation is not mistaken for an empty account", () => {
    const error = Object.assign(new Error("Input flagged by moderation"), {
      status: 403,
      error: { code: "moderation_blocked" },
    });

    expect(
      (classifyProviderError(link, error) as ProviderRequestError).kind,
    ).toBe("unknown");
  });

  test("a rejected key reads as unauthorized", () => {
    const error = Object.assign(new Error("Incorrect API key"), {
      status: 401,
    });

    const named = classifyProviderError(link, error) as ProviderRequestError;

    expect(named.kind).toBe("unauthorized");
    expect(named.message).toContain("API key");
  });

  test("a 429 reads as rate limiting, not as money", () => {
    const error = Object.assign(new Error("Rate limit reached"), {
      status: 429,
    });

    const named = classifyProviderError(link, error) as ProviderRequestError;

    expect(named.kind).toBe("rate_limited");
    expect(named.message).toContain("rate limiting");
  });

  test("'model features vision not support' reads as a capability refusal", () => {
    const error = Object.assign(
      new Error("model features vision not support"),
      {
        status: 400,
        error: {
          code: 400,
          reason: "INVALID_REQUEST_BODY",
          message: "model features vision not support",
        },
      },
    );

    const named = classifyProviderError(link, error) as ProviderRequestError;

    expect(named.kind).toBe("unsupported_capability");
    expect(named.message).toContain("without an attachment");
  });

  test("a network failure is left exactly as it was", () => {
    // No status and no vendor code: there is nothing to name, so the original error must survive
    // untouched or a timeout turns into an invented diagnosis.
    const error = Object.assign(new Error("Connection error."), {});

    expect(classifyProviderError(link, error)).toBe(error);
  });

  test("classifying twice does not re-wrap", () => {
    const once = classifyProviderError(
      link,
      Object.assign(new Error("x"), { status: 402 }),
    );

    expect(classifyProviderError(link, once)).toBe(once);
  });
});

/**
 * A tool answer that carries a picture.
 *
 * This is the plumbing behind the single largest fix in the desktop, so these are regression tests
 * for a bug that shipped: `computer_screenshot` fetched a full-screen PNG, measured the base64 to
 * print a KB figure, returned the figure, and told the model a screenshot had been taken. The model
 * was never sent an image, so the only thing it could learn about a screen was an AT-SPI tree that
 * is nearly empty on XFCE. Every "the Bot cannot use the computer" symptom came from here.
 *
 * The string arm of the union is the overwhelmingly common case and MUST keep behaving identically,
 * so most of what follows is about not changing that.
 */
describe("tool results that carry images", () => {
  /** A one-pixel-ish base64 stand-in; shape is what is under test, not decodability. */
  const pixels = "aGVsbG8=";

  test("a plain string result is untouched, exactly as before", () => {
    // The widening must not have changed the common path. A string in is a truncated string out.
    expect(toolResultContent("Clicked at 5, 5.", "computer_click")).toBe(
      "Clicked at 5, 5.",
    );
  });

  test("an object with no images degrades to its plain text", () => {
    // A malformed image must cost the model the picture, never the whole answer.
    expect(
      toolResultContent({ text: "taken", images: [] }, "computer_screenshot"),
    ).toBe("taken");
  });

  test("an object with a real image becomes a text part plus an image_url part", () => {
    const content = toolResultContent(
      {
        text: "Here is the screen.",
        images: [{ data: pixels, mimeType: "image/jpeg" }],
      },
      "computer_screenshot",
    ) as { type: string }[];
    expect(content.map((part) => part.type)).toEqual(["text", "image_url"]);
    /*
     * The `data:` prefix is built in exactly one place, here. Everywhere else in the tree carries
     * raw bytes, and a tool that forgot the prefix produced a provider error naming the URL rather
     * than a blank image the model then described as "a grey rectangle".
     */
    expect((content[1] as { image_url: { url: string } }).image_url.url).toBe(
      `data:image/jpeg;base64,${pixels}`,
    );
  });

  test("an image with the wrong mime type or the wrong bytes is dropped", () => {
    // This goes into an outbound provider payload, so it gets the same allowlist and base64
    // shape-check an uploaded attachment gets. `text/html` must never ride a field typed as an image.
    for (const bad of [
      { data: pixels, mimeType: "text/html" },
      { data: "not base64 !!", mimeType: "image/jpeg" },
      { data: "", mimeType: "image/jpeg" },
    ]) {
      expect(
        toolResultContent(
          { text: "seen", images: [bad] },
          "computer_screenshot",
        ),
      ).toBe("seen");
    }
  });

  test("an earlier turn's pictures are demoted to their text, and this turn's are kept", () => {
    /*
     * The cost rule. The most recent screenshot is what the model is reasoning about right now; a
     * screenshot from three steps ago is a picture of a window that has since changed AND is ~90KB of
     * the window. Keeping it trades a large stale cost for a small current one, and the provider
     * bills both. Demoting to the sentence loses nothing, because the current screen is in context
     * either way.
     */
    const pic = (data: string) => ({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${data}` },
    });
    const messages = [
      { role: "user", content: "earlier question" },
      {
        role: "tool",
        tool_call_id: "a",
        content: [{ type: "text", text: "old" }, pic("AAAA")],
      },
      { role: "assistant", content: "ok" },
      { role: "user", content: "now do it" },
      {
        role: "tool",
        tool_call_id: "b",
        content: [{ type: "text", text: "new" }, pic("BBBB")],
      },
    ] as unknown as OpenAIMessage[];

    const demoted = demoteStaleToolImages(messages);
    const toolContents = demoted
      .filter((m) => m.role === "tool")
      .map((m) => (m as unknown as { content: unknown }).content);
    /*
     * The earlier one lost its picture and kept its words — as a plain STRING, not as a list with the
     * picture removed. A demoted message collapses, because a one-part content list is just the
     * string with extra syntax and the providers are happier with the simple shape.
     */
    expect(toolContents[0]).toBe("old");
    // This turn's survived intact, as a part list, so the image is still there to be looked at.
    expect((toolContents[1] as { type: string }[]).map((p) => p.type)).toEqual([
      "text",
      "image_url",
    ]);
  });

  test("the per-run picture cap keeps the NEWEST, and demotes the rest to text", () => {
    /*
     * A cap that kept the OLDEST would be worse than no cap at all: it would spend the window on
     * screenshots of windows that have since closed and demote the one the model is looking at now.
     * That is why this walks backwards.
     */
    const pic = (n: number) => ({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${"A".repeat(n)}` },
    });
    const tools = Array.from({ length: 20 }, (_, i) => ({
      role: "tool",
      tool_call_id: `t${i}`,
      content: [{ type: "text", text: `shot ${i}` }, pic(i + 1)],
    }));
    const messages = [
      { role: "user", content: "go" },
      ...tools,
    ] as unknown as OpenAIMessage[];

    const demoted = demoteStaleToolImages(messages);
    // A demoted message becomes a plain string, which is itself part of the contract: the model gets
    // the sentence, not a list with the picture removed from it.
    const withPictures = demoted
      .filter((m) => m.role === "tool")
      .filter((m) => {
        const content = (m as unknown as { content: unknown }).content;
        return (
          Array.isArray(content) &&
          content.some((p) => (p as { type?: string }).type === "image_url")
        );
      })
      .map(
        (m) =>
          (m as unknown as { content: { image_url: { url: string } }[] })
            .content,
      );

    // Capped, and the survivor is the LAST one, which is the current screen.
    expect(withPictures.length).toBeGreaterThan(0);
    expect(withPictures.length).toBeLessThan(20);
    const last = withPictures.at(-1) as { image_url: { url: string } }[];
    expect(last.at(-1)?.image_url.url).toContain("A".repeat(20));
  });
});
