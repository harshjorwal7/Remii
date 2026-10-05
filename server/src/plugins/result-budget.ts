import { cutAtCodeUnits } from "../channels/text";

/**
 * HOW MUCH OF A TOOL RESULT A MODEL IS SHOWN, AND HOW IT IS SHOWN.
 *
 * A tool result goes straight into a model's context, so an unbounded one is somebody else's server
 * deciding how much of our context window to spend. But a single bound for every tool was wrong, and
 * wrong in the one direction that loses answers: Gmail publishes 63 actions whose results are
 * structured JSON carrying whole messages, and a bound tuned for a screenshot cut such a result to a
 * couple of entries — every string to 1,500 characters, every array to 15 items, the whole thing to
 * 4,000. A Bot asked "what did that thread say" was handed two headers and told the rest was
 * truncated, and it answered from that. The same bound on `computer_navigate` is exactly right.
 *
 * So the bound is a property of the KIND OF ANSWER, not of the loop: a screen tool's output is a few
 * hundred characters of our own machine and a vendor app's is somebody's mailbox. Two classes,
 * declared per tool where the tool is declared, and read here.
 *
 * THIS MODULE IS SHARED BY THE LOOP AND THE TRANSPORT ON PURPOSE. The in-process loop shapes a result
 * for the model; `/api/agent-tools/call` hands the same result to a framework Bot running its own
 * loop, which does not shape anything. When the shaping lived only in the loop, the two topologies
 * disagreed by a factor of five on identical data — the built-in Bot saw 4,000 characters of a Gmail
 * answer and the LangGraph Bot saw 20,000 — and which one a deployment got was a wiring decision
 * nobody was shown. Composio's own transport therefore shapes with the same budget and the same code,
 * so an app result leaves the store already shaped for a model and neither path can quietly apply a
 * second, different one.
 */

/** Which bound applies. Declared by the tool that produces the answer. */
export type ResultBudgetClass = "screen" | "app";

export type ResultBudget = {
  /** Whole-result ceiling, in characters, notice included. */
  total: number;
  /** Per-string ceiling, applied while walking a structured value. */
  string: number;
  /** Per-array ceiling. */
  items: number;
  /** How deep to walk before a subtree becomes a marker. */
  depth: number;
};

/**
 * THE TWO BOUNDS.
 *
 * `screen` is unchanged from the bound this module replaces, deliberately: it is what every desktop
 * and screen tool was tested against, it is generous for the output those tools produce, and nothing
 * about a screenshot improves by being shown twice as much.
 *
 * `app` is set so that THE VENDOR'S CAP IS NOT THE BINDING ONE. Every transport in this tree cuts an
 * answer at `MAX_RESULT_CHARS` — 20,000 — before the loop ever sees it, so an app budget below that
 * would be a second cut applied to text that had already been cut once, which is how a bound turns
 * into truncation. Setting them equal makes the invariant checkable: shaping an app result in the
 * transport and shaping it again in the loop is a no-op, and the model sees everything the vendor was
 * willing to send.
 *
 * The per-string and per-array figures are what actually decide a Gmail answer, because that is a
 * JSON object the structured branch walks: `messages` is an array (50 items), each message's
 * `payload.headers` is another array, and the body sits at `payload.body.data` as base64. Four
 * thousand characters per string leaves room for a header and little else; four thousand per string
 * with fifty items leaves the message. Depth 10 rather than 6 because a Gmail part is already six
 * levels down before its own `parts` array starts, and at 6 the walk was replacing message bodies
 * with the literal string `[Object]`.
 */
export const RESULT_BUDGETS: Record<ResultBudgetClass, ResultBudget> = {
  screen: { total: 4_000, string: 1_500, items: 15, depth: 6 },
  app: { total: 20_000, string: 4_000, items: 50, depth: 10 },
};

/** The class a tool gets when it declares none, which is every tool that is not a vendor app. */
export const DEFAULT_RESULT_BUDGET: ResultBudgetClass = "screen";

/**
 * The bound for one tool.
 *
 * The tool's own declaration is the only authority. There is deliberately no inference from the name
 * here: `mcp__` and `gog_` would both answer "app" today, and both are set explicitly where the tool
 * is built, which is the same place the description the model reads is written.
 */
export function resultBudgetFor(tool: {
  resultBudget?: ResultBudgetClass;
}): ResultBudget {
  return RESULT_BUDGETS[tool.resultBudget ?? DEFAULT_RESULT_BUDGET];
}

/**
 * Keys whose value is bytes rather than information, dropped wherever they appear in a vendor's JSON.
 *
 * BY KEY AND NOT BY SIZE, for these two. A screenshot's base64 has to be recognised even when it is
 * small, or a run's image budget would be decided by a payload that happens to compress well; and a
 * vendor's `base64` field means the vendor's own encoding rather than ours, whatever it holds.
 */
const BYTE_KEYS = new Set(["imageDataUrl", "base64", "image_data_url"]);

/** Enough of a string to tell base64 from prose without walking a megabyte. */
const ENCODED_SAMPLE = 512;

/**
 * Below this, a base64-shaped string is text.
 *
 * The size floor is deliberately generous and is the reason this heuristic is allowed to guess at all.
 * A miss costs 4,000 characters of a blob the model cannot read; a false positive deletes real
 * content, and the string that provokes one is exactly the plausible-looking one a value gets by
 * being a long identifier list with no separators. 8 KB is below any encoded body worth removing and
 * well above anything that is prose.
 */
const ENCODED_FLOOR = 8_192;

/**
 * Whether a string is an encoded blob this deployment will not put in front of a model.
 *
 * THE DIGIT TEST IS WHAT MAKES IT SAFE TO GUESS. Two independent conditions — base64's alphabet and a
 * length past {@link ENCODED_FLOOR} — are satisfied by a long run of letters, and a 60,000-character
 * field of one repeated character was read as an image by shape alone. Encoded output of this size
 * mixes cases and digits essentially always; a run of letters contains neither, so it stays text.
 *
 * Sampled rather than tested whole: the strings this exists to catch run to megabytes, and a
 * character-class test over the whole of one is work paid on every Gmail answer to answer a question
 * about its first 512 characters. The alphabet carries `-` and `_` because Gmail encodes base64url.
 */
const ENCODED_ALPHABET = /^[A-Za-z0-9+/=\r\n_-]+$/;
const ENCODED_DIGIT = /[0-9]/;

export function looksEncoded(value: string): boolean {
  if (value.length < ENCODED_FLOOR) return false;
  const sample = value.slice(0, ENCODED_SAMPLE);
  return ENCODED_DIGIT.test(sample) && ENCODED_ALPHABET.test(sample);
}

/** What was left out of a shaped result, so the notice can say so rather than only saying "cut". */
export type Omission = {
  strings: number;
  stringChars: number;
  items: number;
  objects: number;
  encoded: number;
};

const nothingOmitted = (): Omission => ({
  strings: 0,
  stringChars: 0,
  items: 0,
  objects: 0,
  encoded: 0,
});

const omittedAnything = (omitted: Omission): boolean =>
  omitted.strings > 0 ||
  omitted.items > 0 ||
  omitted.objects > 0 ||
  omitted.encoded > 0;

/**
 * What the model is told when the result it was given is not the whole result.
 *
 * COUNTS AND NOT A NUMBER, because the counts are what the model acts on. "Truncated" is a fact it
 * files away; "40 array items were omitted" tells it there is more, and the advice tells it how to get
 * there. The old per-array `[... N items truncated]` markers said one number per array and nothing at
 * all about which array, so a model reading a trimmed mailbox could not tell a trimmed mailbox from a
 * short one — which is the whole failure this replaces, and the one that produced a confident answer
 * about emails nobody read.
 *
 * ONE CLAUSE, NOT A BRACKETED MARKER, because this and the whole-result cut below both have to
 * survive. They arrive together — a result past the ceiling has usually already lost fields and items
 * — and a marker appended to a prefix that is then cut off is a marker that says nothing. Clauses the
 * two compose into one note at the very end is one that survives either way.
 *
 * Bounded, not proportional: four numbers however large the result was, so the note cannot crowd out
 * the thing it describes.
 */
export function describeOmissions(omitted: Omission): string {
  const parts: string[] = [];
  if (omitted.items > 0) parts.push(`${omitted.items} array items`);
  if (omitted.strings > 0) {
    parts.push(
      `${omitted.strings} strings (${omitted.stringChars} characters)`,
    );
  }
  if (omitted.encoded > 0) parts.push(`${omitted.encoded} encoded blobs`);
  if (omitted.objects > 0) parts.push(`${omitted.objects} deeper objects`);
  return parts.join(", ");
}

/** The one remedy, said by whichever note is telling the model it has not seen everything. */
const ADVICE =
  "Narrow the query, lower its page size, or fetch the next page to see the rest.";

/**
 * The note a cut result ends with, composed rather than picked from a menu.
 *
 * `arrived` is the length of the whole result and `kept` the length of the prefix that survived, and
 * both are stated because a model told "its first 4,000 of 18,732 characters are shown" can decide
 * whether the answer it needs is likely to be in what it has. `omitted` is empty on the whole-result
 * path — nothing was removed field by field, the text simply stopped — and that is exactly when the
 * lengths matter most, because there are then no counts to infer them from.
 */
function tailNote(omitted: string, arrived: number, kept: number): string {
  const because: string[] = [];
  if (omitted) because.push(`${omitted} were omitted from it`);
  if (kept < arrived) {
    because.push(`only its first ${kept} of ${arrived} characters are shown`);
  }
  if (because.length === 0) return "";
  return `[This is not everything the action returned: ${because.join(", and ")}. ${ADVICE}]`;
}

/** What replaces a removed body, so the model can tell "there was one" from "there was nothing". */
const BODY_OMITTED =
  "encoded bytes were removed; fetch the message again with an action that decodes it, or read the body from the thread, to see it";

/**
 * The prefix cut, with the note sized against the budget rather than guessed at.
 *
 * THE OLD VERSION RESERVED 200 CHARACTERS FOR A NOTE THAT CAN BE LONGER THAN 200, so on a large
 * remainder the result came out OVER the very ceiling it was cut to, and the model was handed more
 * text than the bound promised. The note is built first here and the prefix is whatever is left.
 *
 * `omitted` is passed in rather than recomputed so a result that lost fields to the per-string limit
 * AND then to the ceiling reports both facts in one note, instead of the second erasing the first.
 */
export function capToolText(
  value: string,
  budget: ResultBudget,
  omitted = "",
): string {
  if (value.length <= budget.total) {
    const whole = tailNote(omitted, value.length, value.length);
    return whole ? `${value}\n\n${whole}` : value;
  }
  /*
   * The note is MEASURED AT ITS WIDEST before the prefix is decided, not built once and fitted after.
   * `kept` appears inside the note as a number, so a note measured with the eventual value is a
   * character or three shorter than the note that value produces — and the result came out that many
   * characters over the ceiling it had just been cut to, which is the exact failure the fixed 200
   * was here to stop. `budget.total` is the widest `kept` can be, so measuring there is an upper bound.
   */
  const widest = tailNote(omitted, value.length, budget.total).length;
  const kept = Math.max(0, budget.total - widest - 2);
  return `${cutAtCodeUnits(value, kept)}\n\n${tailNote(omitted, value.length, kept)}`;
}

/**
 * Walk a vendor's JSON down to the budget, counting what did not fit.
 *
 * THE ORDER MATTERS. The encoded-blob test runs before the length test and the byte-key test before
 * both, so an `imageDataUrl` and a large base64 under a third vendor's name are both dropped
 * regardless of length. A blob that reached the length test would instead be kept at the string
 * ceiling — which for 1,500 characters is 1,500 characters of the model reading nothing.
 *
 * The path is carried so the marker can say WHERE the cut happened. A model told a result was trimmed
 * has to be able to ask a question that gets past the trim, and "payload.body is nested deeper than
 * this result shows" is an answer it can act on where `[Object]` is not.
 */
function pruneValue(
  value: unknown,
  budget: ResultBudget,
  omitted: Omission,
  path: string,
  depth: number,
): unknown {
  const at = path || "the result";
  if (depth > budget.depth) {
    omitted.objects += 1;
    return `[${at} is nested deeper than this result shows]`;
  }
  if (typeof value === "string") {
    if (looksEncoded(value)) {
      omitted.encoded += 1;
      return `[${at} is ${value.length} characters of encoded bytes, not text]`;
    }
    if (value.length <= budget.string) return value;
    omitted.strings += 1;
    omitted.stringChars += value.length - budget.string;
    return `${cutAtCodeUnits(value, budget.string)}... [${value.length - budget.string} more characters]`;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, budget.items)
      .map((entry, index) =>
        pruneValue(entry, budget, omitted, `${at}[${index}]`, depth + 1),
      );
    if (value.length > budget.items) {
      omitted.items += value.length - budget.items;
      items.push(
        `[${at} held ${value.length} items; ${budget.items} are shown]`,
      );
    }
    return items;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (BYTE_KEYS.has(key)) {
        omitted.encoded += 1;
        out[key] =
          typeof entry === "string"
            ? `[${entry.length} characters of encoded bytes]`
            : "[encoded bytes]";
        continue;
      }
      out[key] = pruneValue(
        entry,
        budget,
        omitted,
        path ? `${path}.${key}` : key,
        depth + 1,
      );
    }
    return out;
  }
  return value;
}

/**
 * Shape a vendor's JSON for a model, and say whether anything was left out.
 *
 * `truncated` is not a convenience. `McpCallResult` carries one and this is the function that decides
 * it for a Composio answer, so a result shaped down to its per-string limit and reported as whole is
 * the same lie in the same field that the transport's own cap was written to stop — a field whose
 * whole job is telling a model that what it is reading stops early.
 *
 * Re-serialising without indentation is deliberate: Composio's envelope
 * arrived pretty-printed with two-space indentation, which spent roughly a third of the ceiling on
 * whitespace, and this value is measured against a budget in characters rather than in information.
 *
 * Idempotent by construction: shaping an already-shaped value changes nothing, because every part of
 * it is already inside every limit and nothing is counted. That is what lets the transport shape AND
 * the loop shape, which is what makes the two topologies agree.
 *
 * A result that does not parse takes the text branch instead, which has one rule and no per-field
 * limits — there is no structure in it to preserve any.
 */
export function shapeToolResult(
  result: string,
  budget: ResultBudget,
): { text: string; truncated: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return {
      text: capToolText(result, budget),
      truncated: result.length > budget.total,
    };
  }
  const omitted = nothingOmitted();
  const shaped = pruneValue(parsed, budget, omitted, "", 0);
  const text = JSON.stringify(shaped) ?? String(shaped);
  const cut = omittedAnything(omitted);
  /*
   * The note is appended LAST and the ceiling is honoured around it, in one place, so the two cuts
   * cannot overwrite each other. That was the failure this replaced twice over: a note appended before
   * the whole-result cut was itself cut off on exactly the results that needed it most.
   */
  return {
    text: capToolText(text, budget, describeOmissions(omitted)),
    truncated: cut,
  };
}

/**
 * Shape a result for a model, keeping only the text.
 *
 * For the loop, where the flag is spent: a result already shaped by the transport is shaped again
 * here and changes nothing, so a boolean describing what this call did would say "nothing was cut"
 * about a result the model is quite plainly not being shown whole. The transport is where the flag
 * belongs, because the transport is where the first cut happens.
 */
export function shapeToolResultForContext(
  result: string,
  budget: ResultBudget,
): string {
  return shapeToolResult(result, budget).text;
}

/**
 * WHAT MAKES A `data` FIELD AN ENCODED BODY RATHER THAN DATA.
 *
 * `data` is a generic name and this deployment drops keys by name, so dropping every `data` would
 * throw away a Slack row's and a Sheets cell's. Two shapes make it a MIME payload, and they are the
 * two Gmail itself uses:
 *
 *  - a `data` string whose object also names a `mimeType` — that is the content of one MIME part;
 *  - a `data` string inside a `body` object — Gmail puts every message body's content there, both
 *    at the top level of a simple message and under `payload.parts[].body` for a multipart one.
 *
 * Nothing else is removed. That is the whole safety argument for doing this at the transport instead
 * of generically: the rule is narrow enough to leave other vendors' payloads intact.
 */
function isMimePayload(
  key: string,
  entry: unknown,
  record: Record<string, unknown>,
  insideBody: boolean,
): boolean {
  if (key !== "data" || typeof entry !== "string") return false;
  return insideBody || typeof record.mimeType === "string";
}

/**
 * Remove encoded MIME bodies from a vendor's value, returning a new value.
 *
 * Why this is here and not only in the budget walk: the walk can tell a blob from prose by shape and
 * keeps the result honest, but the value still TRAVELS. Composio's envelope is received whole,
 * serialized whole, capped whole, and only then shaped — on a mailbox page that is megabytes of base64
 * through a string before anything looks at it, and the cap then decides the outcome by where the
 * bytes happen to fall in the document. Removing the bodies first means the cap spends itself on
 * messages.
 *
 * A value with nothing to remove is returned unchanged by identity, so the common case costs one
 * array walk and no allocation.
 */
export function stripMimePayloads(value: unknown, depth = 0): unknown {
  return stripEncoded(value, depth, false);
}

/**
 * The walk, carrying whether this value was reached through a `body`.
 *
 * `insideBody` is the state the two rules cannot both be expressed without: a Gmail MIME part stores
 * its content at `payload.body.data`, so the `data` is a child of `body` and its parent names no
 * `mimeType` at all. Reading `mimeType` from the parent only would miss every body inside a
 * multipart message — which is most of them, and all the interesting ones.
 */
function stripEncoded(
  value: unknown,
  depth: number,
  insideBody: boolean,
): unknown {
  if (depth > 24) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((entry) => {
      const stripped = stripEncoded(entry, depth + 1, false);
      if (stripped !== entry) changed = true;
      return stripped;
    });
    return changed ? out : value;
  }
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(record)) {
    if (isMimePayload(key, entry, record, insideBody)) {
      out[key] = BODY_OMITTED;
      changed = true;
      continue;
    }
    const stripped = stripEncoded(entry, depth + 1, key === "body");
    if (stripped !== entry) changed = true;
    out[key] = stripped;
  }
  return changed ? out : record;
}
