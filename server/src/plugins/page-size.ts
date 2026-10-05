/**
 * PAGE SIZE AND THE PAGE AFTER THIS ONE, for actions that return a list.
 *
 * WHY A LIST ACTION NEEDS HELP FROM THIS SIDE. A model's arguments are whatever it happened to write,
 * and it has no way to know what a vendor's default page size is — `maxResults`, `limit`, `per_page`,
 * `count` and a dozen others all mean it, and every vendor picks its own number. Left alone that
 * number decides the answer: a page of 100 messages is megabytes of base64 for a Bot that wanted the
 * subject line of the newest one, and a page of 5 is a mailbox that looks empty. Neither is a choice
 * anybody made.
 *
 * AND THE PAGE AFTER THIS ONE IS THE HALF THAT WAS MISSING ENTIRELY. A vendor that has more to give
 * says so — `nextPageToken`, `next_cursor`, `after` — and this deployment read every one of those as
 * just another field in a JSON document. Nothing in the context said "there is more, and here is the
 * argument to ask for it with", so a Bot holding a page of results answered from the page as though
 * it were the whole list. Saying it costs one sentence and turns a partial answer into a question the
 * model knows how to finish.
 *
 * Both halves live here for the same reason: both are about what a LIST action puts on the wire, and
 * neither can be decided where the schema lives alone.
 *
 * {@link withDefaultPageSize} is called by the store, which is the only place holding both an action's
 * schema and the arguments about to be sent — a transport is handed arguments and is blind to the
 * declaration that names them. {@link nextPageHint} is called by the transport instead, and the
 * asymmetry is deliberate: the token is only findable in the vendor's own answer, and by the time an
 * answer reaches the store it has been shaped into a document that no longer parses.
 */

/**
 * ARGUMENTS THAT MEAN "HOW MANY", across the vendors a Composio deployment connects.
 *
 * Matched by name AND checked against the schema, never by name alone. `count` is Slack's page size
 * and a column name elsewhere; `limit` is a rate limit on some actions and a page size on others. The
 * checks below — an integer, no enum, not required, a maximum we are not exceeding — are what make
 * injecting a number into somebody else's action safe: an action whose `limit` is a rate limit has a
 * maximum, and 25 is under it, so the injection is at worst inert.
 */
const PAGE_SIZE_ARGS = [
  "maxResults",
  "max_results",
  "maxItems",
  "max_items",
  "numResults",
  "num_results",
  "maxCount",
  "max_count",
  "pageSize",
  "page_size",
  "perPage",
  "per_page",
  "per_page_size",
  "limit",
  "count",
] as const;

/**
 * ONE PAGE, SIZED TO THE ANSWER BUDGET RATHER THAN TO A ROUND NUMBER.
 *
 * Twenty-five is not a conventional page size; it is what fits. A Gmail message with its headers is
 * roughly 600 characters, so twenty-five of them is about 15,000 — inside the 20,000 the app budget in
 * `./result-budget` allows, which means an ordinary page arrives WHOLE and the model is told it is
 * whole. That is the property worth having: the moment the ceiling bites is the moment a Bot starts
 * answering about emails it never read, so the page size and the budget are one decision and are set
 * against each other here rather than by whichever the vendor happened to publish.
 *
 * A model that wants more sends a page token, and {@link nextPageHint} tells it how.
 */
const DEFAULT_PAGE_SIZE = 25;

/** Fields a vendor uses to say "there is more, and this is how to ask for it". */
const CURSOR_FIELDS = [
  "nextPageToken",
  "next_page_token",
  "nextCursor",
  "next_cursor",
  "nextPage",
  "next_page",
  "pageToken",
  "page_token",
  "continuationToken",
  "continuation_token",
  "startCursor",
  "start_cursor",
  "endCursor",
  "end_cursor",
  "next",
  "after",
] as const;

/** A schema node, as far as this module reads one. */
type Node = Record<string, unknown>;

const isRecord = (value: unknown): value is Node =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The properties of an action's argument schema, or an empty map when the schema is not an object.
 *
 * Deliberately shallow and deliberately narrow. An action whose arguments sit behind `$ref` or
 * `allOf` gets no page-size default rather than a guess at what is behind them — this deployment
 * drops such an action's optional file parameters in three other places on principle, and guessing
 * here would put a number into an argument whose name we have not actually seen.
 */
function propertiesOf(schema: unknown): Node {
  if (!isRecord(schema)) return {};
  if (schema.type !== undefined && schema.type !== "object") return {};
  const properties = schema.properties;
  return isRecord(properties) ? properties : {};
}

/** An integer, or a number with no fractional part: the only things a page size may be. */
function isCountable(node: unknown): boolean {
  if (!isRecord(node)) return false;
  const type = node.type;
  if (type !== "integer" && type !== "number") return false;
  // A bounded value is a page size only if our default is inside its range; see below.
  return true;
}

/** The vendor's own bounds on one argument, or null where it published none. */
function boundsOf(node: Node): { minimum: number; maximum: number | null } {
  const read = (key: string): number | null =>
    typeof node[key] === "number" ? (node[key] as number) : null;
  return {
    minimum: read("minimum") ?? 1,
    maximum: read("maximum"),
  };
}

/**
 * A page size for one action, or null when the action has no argument that means one.
 *
 * NULL RATHER THAN A BOUNDED ANSWER for an argument we cannot reason about. An `enum`, a `default`,
 * a `oneOf` or a non-numeric type all mean the argument is not a plain count, and injecting into it
 * would either be rejected by the vendor or change what the action does. Returning null leaves the
 * model's own value, or the vendor's default, exactly as they were.
 */
function pageSizeFor(properties: Node): { name: string; value: number } | null {
  for (const name of PAGE_SIZE_ARGS) {
    const node = properties[name];
    if (node === undefined || !isCountable(node)) continue;
    if (isRecord(node) && Array.isArray(node.enum)) continue;
    const { minimum, maximum } = boundsOf(isRecord(node) ? node : {});
    /*
     * SKIPPED WHEN THE VENDOR'S CEILING IS BELOW OURS, and not clamped. An action that says "at most
     * 10" is one where 10 is what the vendor considers a page — clamping to it would send a number
     * and pretend the page-size decision had been made here, when the vendor had already made it.
     * The action runs either way; only our claim about the page changes, and the honest claim is that
     * we had nothing to say.
     */
    if (maximum !== null && maximum < DEFAULT_PAGE_SIZE) continue;
    if (minimum > DEFAULT_PAGE_SIZE) continue;
    return { name, value: DEFAULT_PAGE_SIZE };
  }
  return null;
}

/**
 * Give a list action a page size, if the model left it out and the schema says what one is called.
 *
 * NEVER OVERRIDES THE MODEL. An argument that is present is the model's decision — it asked for 5
 * because it wants five, and it asked for 100 because it wants a hundred, and in both cases it has
 * read something about the task that this module has not. This only fills a gap.
 *
 * ONLY FOR SOMETHING CONFIRMED TO READ, and that is a closed door rather than an open one. Every write
 * in this tree is a thing a model does to a person, so a `limit` on an action that changes something is
 * not a page and a number put into it can change what the action did. An effect this module cannot
 * read as `read` — including none at all — is treated as a write, which costs only the vendor's own
 * default page size, exactly what happened before this existed. `classifyTool` answers `read` or
 * `write` and never anything else, so the conservative branch is unreachable from the store; it is
 * here so that a future caller passing something less careful cannot widen this by accident.
 *
 * Returns the same object when nothing is injected, so the common call allocates nothing.
 */
export function withDefaultPageSize(args: {
  toolName: string;
  args: Record<string, unknown>;
  schema: unknown;
  effect?: "read" | "write" | null;
}): Record<string, unknown> {
  if (args.effect !== "read") return args.args;
  const properties = propertiesOf(args.schema);
  if (Object.keys(properties).length === 0) return args.args;
  for (const name of PAGE_SIZE_ARGS) {
    // Present in any form — including `undefined`, which a model does produce — means it was chosen.
    if (name in args.args) return args.args;
  }
  const page = pageSizeFor(properties);
  if (page === null) return args.args;
  return { [page.name]: page.value, ...args.args };
}

/** The cursor token a vendor's answer carries, and the field it was in. */
function findCursor(
  value: unknown,
  depth = 0,
): { field: string; token: string } | null {
  if (depth > 4) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findCursor(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const field of CURSOR_FIELDS) {
    const token = value[field];
    if (typeof token === "string" && token.trim() !== "") {
      return { field, token };
    }
  }
  for (const entry of Object.values(value)) {
    const found = findCursor(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * The sentence that turns a page into a question the model knows how to finish.
 *
 * READ FROM THE VENDOR'S OWN ANSWER, BEFORE ANY SHAPING, and that ordering is the whole reason this
 * lives here and is called by the transport. Once a result has been shaped it is a document with a
 * note on the end of it and no longer parses, so a hint that could only be found by parsing the final
 * text would find nothing — which is the same class of bug as asking a model to page a list it was
 * never told had more of.
 *
 * THE TOKEN IS NAMED, NOT THE ARGUMENT, because the transport is handed arguments and never the
 * schema. A vendor's own field name is the best available guess at the argument it came from, and for
 * the vendors that page at all it is usually right: `page_token`, `pageToken`, `nextPageToken`,
 * `next_cursor`, `after` and `start_cursor` are each both the response field and the request argument
 * in Slack, Gmail, Notion and Drive respectively. Where it is wrong the sentence says the token is in
 * a field of that name, which is enough for a model holding the action's own definition to find the
 * argument, and a model told only "there is more" has nothing to act on.
 *
 * Says nothing when there is no token, which is most results — a send, a fetch, a delete — and this
 * is called on every single one of them.
 */
export function nextPageHint(data: unknown): string {
  const cursor = findCursor(data);
  if (cursor === null) return "";
  return `[This action has more results. Call it again passing ${cursor.field}="${cursor.token}" to get the next page, rather than treating this one as the whole list.]`;
}
