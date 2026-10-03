import OpenAI from "openai";

/**
 * Which model answers, and where the key is spent — the Remi model router, ported.
 *
 * remi.in routed across providers (deepseek, novita, openai, openrouter, google) with plan-based
 * rules and a fallback pair. This deployment is DeepSeek-only: one provider, one model
 * (`deepseek-flash`), one key. `buildModelChain` still returns a LIST because every caller
 * iterates it and the loop still walks it link by link — a chain of one is the shape those
 * readers already have, and collapsing the return type to a single link would touch seven call
 * sites to save nothing.
 *
 * Why one link rather than an ordered chain of every keyed provider: with a chain, the LAST
 * provider holding any key is the error a turn fails with, whatever actually broke. An empty
 * Novita account sat last, so every turn where DeepSeek or OpenRouter hiccupped surfaced as
 * `403 NOT_ENOUGH_BALANCE — not enough balance` from a vendor nobody had chosen, with the real
 * failure discarded upstream. A chain that cannot answer is worse than a chain of one, because
 * it reports the wrong reason.
 *
 * Everything here speaks OpenAI-compatible chat completions (the `openai` client against a base
 * URL). The PROVIDER is DeepSeek and the MODEL is `deepseek-flash`, always; the base URL is
 * DeepSeek's own unless `OPENAI_BASE_URL` says otherwise, because a proxy or gateway in front of
 * DeepSeek is a supported shape and the four cases in `model-providers.test.ts` exist for it. What
 * a base URL may no longer do is pick a different VENDOR — that was the coupling which let a chain
 * reach Novita at all.
 */

export type ModelLink = {
  /** Human name for logs and usage rows, e.g. "deepseek". Never a secret. */
  provider: string;
  /** The model string sent in the request body, e.g. "deepseek-chat". */
  model: string;
  /** Extra body fields, e.g. reasoning effort. */
  extraBody?: Record<string, unknown>;
  client: OpenAI;
};

const DEEPSEEK_PROVIDER = "deepseek";
/** DeepSeek's own endpoint, version segment included — the SDK appends `/chat/completions` under it. */
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_FLASH_MODEL = "deepseek-flash";

const clientCache = new Map<string, OpenAI>();

function clientFor(provider: string, baseURL: string, apiKey: string): OpenAI {
  const cacheKey = `${provider}:${baseURL}:${apiKey.slice(0, 8)}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;
  const client = new OpenAI({ baseURL, apiKey });
  clientCache.set(cacheKey, client);
  return client;
}

function envOf(
  environment: Record<string, string | undefined>,
  name: string,
): string {
  return environment[name]?.trim() ?? "";
}

/** The one model this deployment answers on. `REMI_FLASH_MODEL` overrides it for a Pro-tier key. */
export function deepseekModel(
  environment: Record<string, string | undefined> = process.env,
): string {
  return envOf(environment, "REMI_FLASH_MODEL") || DEEPSEEK_FLASH_MODEL;
}

/**
 * Where this loop dials.
 *
 * `OPENAI_BASE_URL` verbatim when set, which is what lets a proxy or gateway sit in front of
 * DeepSeek, and DeepSeek's own endpoint when it is blank or absent — a bare host is the operator's
 * business, and nothing appends a version segment behind their back.
 */
export function deepseekBaseUrl(
  environment: Record<string, string | undefined> = process.env,
): string {
  return envOf(environment, "OPENAI_BASE_URL") || DEEPSEEK_BASE_URL;
}

/**
 * The chain for one turn: DeepSeek, once.
 *
 * The key is the one the caller resolved for the deployment and nothing else —
 * `resolveModelApiKey`, which reads a stored per-deployment credential (so key rotation works) and
 * otherwise falls back to `DEEPSEEK_API_KEY` and then `OPENAI_API_KEY`. Reading an environment key
 * here as well would be wrong in a way that is invisible until a test runs: several callers pass a
 * null key MEANING IT (`copilot.buildAgents` refuses an unconfigured deployment with one sentence,
 * and `memory-extract` returns early), so a key picked up behind their back turns a deliberate,
 * named failure into a real request dialed with a key nobody chose.
 *
 * No key at all is an EMPTY chain rather than a link that fails on every call. `noModelError` turns
 * that into one sentence naming the missing setting, which is a far better failure than a 401 from
 * the provider.
 *
 * `primary` is accepted and ignored. It used to choose the first link, which is exactly the
 * coupling that let a stale tenant package or `BOT_MODEL` send an off-vendor model id to
 * DeepSeek; a DeepSeek-only deployment has one legal model, so the deployment's model identity is
 * a display value (`copilot.runtimeModelForEnvironment`) and nothing more.
 */
export function buildModelChain(
  _primary: { provider: string; model: string },
  environment: Record<string, string | undefined> = process.env,
  primaryApiKey?: string | null,
): ModelLink[] {
  const apiKey = primaryApiKey?.trim() ?? "";
  if (!apiKey) return [];
  return [
    {
      provider: DEEPSEEK_PROVIDER,
      model: deepseekModel(environment),
      client: clientFor(
        DEEPSEEK_PROVIDER,
        deepseekBaseUrl(environment),
        apiKey,
      ),
    },
  ];
}

/** The sentence a turn fails with when no link exists at all. */
export function noModelError(_provider: "openai"): Error {
  return new Error(
    "No model credential is configured. Set DEEPSEEK_API_KEY (or OPENAI_API_KEY).",
  );
}

/** Why a provider refused, in the terms a person can act on. */
export type ProviderFailureKind =
  /** The account is real but has no money left in it. */
  | "out_of_funds"
  /** The key is missing, malformed, or revoked. */
  | "unauthorized"
  /** The provider's own limit on requests or tokens, not the account's balance. */
  | "rate_limited"
  /** This model will not accept part of the request — an image, a parameter, a schema. */
  | "unsupported_capability"
  | "unknown";

/**
 * A provider refusal, named.
 *
 * Carries the vendor's own fields so a log line can name the provider and the status without
 * anything having to parse a message, and carries `message` as a SENTENCE a chat may show, so the
 * raw vendor envelope never reaches the composer.
 */
export class ProviderRequestError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly kind: ProviderFailureKind;
  readonly status: number | null;
  /** The vendor's own error code, e.g. `NOT_ENOUGH_BALANCE`. A log field, never shown. */
  readonly code: string | null;
  /** The vendor's raw message, kept for the server log only. */
  readonly detail: string | null;

  constructor(input: {
    provider: string;
    model: string;
    kind: ProviderFailureKind;
    status: number | null;
    code: string | null;
    detail: string | null;
    message: string;
  }) {
    super(input.message);
    this.name = "ProviderRequestError";
    this.provider = input.provider;
    this.model = input.model;
    this.kind = input.kind;
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
  }
}

const OUT_OF_FUNDS_TEXT =
  /not enough balance|insufficient[_ ]?(balance|credit|quota)|out of credit|quota exceeded|payment required|billing_not_active|payment required/i;
const RATE_LIMIT_TEXT = /rate[_ ]?limit|too many requests|too many requests/i;
/**
 * DeepSeek and OpenAI-compatible gateways both phrase an unsupported request as prose — "model
 * features vision not support" — so this can only be a text match, not a code.
 */
const UNSUPPORTED_TEXT =
  /features? .* not support|not support .*features?|does not support|unsupported value|invalid_request_body|context length exceeded|maximum context/i;

/** Pull the vendor's `code`/`reason` out of whatever shape the SDK or the gateway produced. */
function providerCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const outer = error as { code?: unknown; error?: unknown; message?: unknown };
  const nested =
    typeof outer.error === "object" && outer.error !== null
      ? (outer.error as { code?: unknown; reason?: unknown })
      : null;
  for (const value of [nested?.reason, nested?.code, outer.code]) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function providerStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/**
 * Name a provider refusal.
 *
 * Returns the error untouched when it is not a refusal this can say something useful about, so a
 * caller that only wants the sentence can use `instanceof` and an unexpected failure keeps its own
 * message.
 *
 * The order matters: an explicit vendor code beats a status, because DeepSeek answers an empty
 * account with `402 insufficient_balance` while Novita answers the same condition with
 * `403 NOT_ENOUGH_BALANCE`, and OpenRouter uses `403` for moderation too — so status alone would
 * call a moderation refusal "out of funds". The text sweep runs last and only over the vendor's
 * message, so it can refine an otherwise-unknown failure without overriding a code that already
 * said something precise.
 */
export function classifyProviderError(
  link: { provider: string; model: string },
  error: unknown,
): unknown {
  if (error instanceof ProviderRequestError) return error;
  const status = providerStatus(error);
  const code = providerCode(error);
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const detail = raw || null;
  const haystack = `${code ?? ""} ${raw}`;

  let kind: ProviderFailureKind = "unknown";
  if (code && OUT_OF_FUNDS_TEXT.test(code)) kind = "out_of_funds";
  else if (status === 402) kind = "out_of_funds";
  else if (code && RATE_LIMIT_TEXT.test(code)) kind = "rate_limited";
  else if (status === 401) kind = "unauthorized";
  else if (status === 429) kind = "rate_limited";
  else if (status === 403 && OUT_OF_FUNDS_TEXT.test(haystack))
    kind = "out_of_funds";
  else if (status === 403 && UNSUPPORTED_TEXT.test(haystack))
    kind = "unsupported_capability";
  else if (status === 400 && UNSUPPORTED_TEXT.test(haystack))
    kind = "unsupported_capability";
  else if (OUT_OF_FUNDS_TEXT.test(haystack)) kind = "out_of_funds";
  else if (status !== null) kind = "unknown";

  if (kind === "unknown" && status === null && !code) return error;

  const message = providerFailureMessage({
    provider: link.provider,
    kind,
    status,
  });
  return new ProviderRequestError({
    provider: link.provider,
    model: link.model,
    kind,
    status,
    code,
    detail,
    message,
  });
}

/**
 * The sentence a person is shown, per kind.
 *
 * Every branch names the provider and says what to change. The vendor's own words stay in
 * `detail` for the log: a chat bubble reading `{"code":403,"reason":"NOT_ENOUGH_BALANCE"}` is not
 * an explanation, and the one line that reaches the composer is the only place an operator learns
 * what their deployment is misconfigured.
 */
export function providerFailureMessage(input: {
  provider: string;
  kind: ProviderFailureKind;
  status: number | null;
}): string {
  const { provider, kind, status } = input;
  switch (kind) {
    case "out_of_funds":
      return `The ${provider} account is out of credits, so the model could not answer. Top up ${provider} and send the message again.`;
    case "unauthorized":
      return `The ${provider} API key was rejected, so the model could not answer. Check the key configured for ${provider}.`;
    case "rate_limited":
      return `${provider} is rate limiting this deployment right now. Wait a moment and send the message again.`;
    case "unsupported_capability":
      return `${provider} would not accept part of that request with this model (${status ?? "rejected"}). Try the message without an attachment.`;
    default:
      return `The model provider ${provider} could not answer this turn (${status ?? "no status"}). The details are in the server log.`;
  }
}
