/**
 * A tool call, named the way the person watching would name it.
 *
 * The model is offered `mcp__notes__search_notes`, because a tool name has to be unique across every
 * server a Bot holds and has to survive two vendors both calling something `search`. None of that is
 * the reader's problem, and putting it on screen tells them how the thing is built rather than what
 * their Bot just did.
 *
 * Anything that is not a prefixed MCP name is left exactly as it is: a component the app registered
 * already has a name somebody chose.
 */
export type ToolName = {
  /** What was done, for the line itself. */
  label: string;
  /** Which server it was done against, muted beside the label. Absent for anything not MCP. */
  detail?: string;
};

/**
 * The tools a Bot is given by this app rather than by a server, in the words a person would use.
 *
 * `humanise` below is for a vendor's tool, where the name is somebody else's to guess at. These are
 * this app's own names, and they are the ones a person actually watches: `delegate_bot` and
 * `computer_run_command` are the two lines in a transcript that say what their Bot is doing, and
 * both read as code. Guessing at them produces "Delegate bot" and "Computer run command" — the first
 * says the mechanism, the second says nothing at all about a browser.
 *
 * Keyed by exact name rather than by prefix, so a deployment that renames or shadows a tool is not
 * silently relabelled. A miss falls through to the name, which is the pre-existing behaviour.
 */
const OWN_TOOLS: Record<string, string> = {
  // Delegation. The whole point of a supervisor, so these three get real sentences.
  delegate_bot: "Delegated",
  message_bot: "Sent a message to",
  bot_add_and_delegate: "Summoned and delegated to",

  // The browser, which a person needs to recognise at a glance because they may have to take over.
  computer_navigate: "Opened a page",
  computer_page_frame: "Read the page",
  computer_snapshot: "Looked at the screen",
  computer_screenshot: "Took a screenshot",
  computer_read: "Read the screen",
  computer_click: "Clicked",
  computer_type: "Typed",
  computer_key: "Pressed a key",
  computer_scroll: "Scrolled",
  computer_read_file: "Read a file on the computer",
  computer_write_file: "Wrote a file on the computer",
  computer_list_files: "Listed files on the computer",
  computer_run_command: "Ran a command on the computer",
  computer_request_help: "Asked for help with the browser",
  computer_take_control: "Asked you to take the browser",
  computer_request_secret: "Asked for a password or secret",

  // The web.
  web_search: "Searched the web",
  web_open: "Opened a web page",
};

/**
 * Delegation tools, whose line is only half a sentence without its target.
 *
 * A label of "Delegated" on its own says that a Bot handed something away and not to whom, which
 * for a supervisor is the only part worth knowing: the whole design of this app is that the person
 * cannot see which of their coworkers is holding the work. The target is in the arguments, so it
 * is read from there.
 */
const DELEGATION_TOOLS: Record<string, string> = {
  delegate_bot: "bot",
  message_bot: "bot",
  bot_add_and_delegate: "bot",
};

export function readToolName(name: string, args?: string): ToolName {
  const own = OWN_TOOLS[name];
  if (own) {
    const target = DELEGATION_TOOLS[name]
      ? readDelegationTarget(args)
      : undefined;
    return target ? { label: `${own} ${target}` } : { label: own };
  }

  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") return { label: name };

  const [, server, ...rest] = parts;
  const tool = rest.join("__");
  const label = humanise(tool);

  /*
   * The server is dropped when the action already names it as the thing acted upon. Vendors name a
   * tool after the thing it acts on, so `mcp__notes__search_notes` would otherwise read "Search
   * notes notes" and `mcp__routines__create_routine` "Create routine routines", both of which look
   * like a bug rather than a label. A server key can itself be more than one word — `google-drive`,
   * `google_drive` — so it is split into words the same way `humanise` splits the tool name, each
   * singularised, and looked for as a contiguous run inside the label's words. Whole words in an
   * unbroken sequence, never a substring test: that is what let "Create routine routines" through in
   * the first place.
   *
   * `humanise` always puts the verb first, and that leading word is excluded from the search:
   * `mcp__posts__post_message` singularises its server to "post", which is also the tool's own verb,
   * so without this exclusion "Post message" would lose its "posts" attribution over a coincidence
   * with the verb rather than a naming of the server. Same shape for `mcp__lists__list_files`
   * against "List". Only the words after the verb describe what the action was taken on, so only
   * those are eligible to match the server.
   *
   * This does not, and cannot, catch every collision: `mcp__news__get_new_items` singularises "news"
   * to "new", which genuinely is the second word of "Get new items", so the server is still dropped
   * there. English plural heuristics cannot tell that "new" apart from the "new" in "news" — that is
   * a known limit of this rule, not a bug to chase with a word list.
   */
  const labelWords = label.toLowerCase().split(" ").map(singular);
  const wordsActedOn = labelWords.slice(1);
  const serverWords = wordsOf(server ?? "").map(singular);
  const named = containsPhrase(wordsActedOn, serverWords);
  return named ? { label } : { label, detail: server };
}

/**
 * The coworker a delegation tool was aimed at, in the words their name is written with.
 *
 * Reads the raw arguments because that is what the transcript holds, and parses defensively: a
 * malformed or absent argument is a line with no target, never a thrown render. Capped, because
 * this is a label on screen and a tool argument is model output.
 */
function readDelegationTarget(args: string | undefined): string | undefined {
  if (!args) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const target = (parsed as Record<string, unknown>).bot;
  if (typeof target !== "string") return undefined;
  const trimmed = target.trim().slice(0, 60);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * `routines` and `routine` are the same word for this purpose.
 *
 * A vendor names the server for the collection and the tool for the one item —
 * `mcp__routines__create_routine` — so the exact-substring test that stops "Search notes notes" lets
 * "Create routine routines" straight through, and it reads as a typo rather than as a label.
 *
 * Dropping one trailing `s` from each side before comparing is the whole of the difference between
 * those two cases. This is not a stemmer and must not grow into one: the only thing it has to catch
 * is one vendor writing the same noun twice, once plural and once not.
 */
function singular(word: string): string {
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

/**
 * `search_notes` as "Search notes".
 *
 * Vendors write tool names in snake_case, camelCase or a mixture, and the only thing they agree on
 * is that the first word is a verb. Splitting on both and sentence-casing the result gets a phrase
 * that reads as an action without anybody maintaining a table of names.
 */
function humanise(tool: string): string {
  const words = wordsOf(tool).join(" ");
  if (words.length === 0) return tool;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * `google-drive`, `google_drive` and `googleDrive` all split to the same `["google", "drive"]`.
 *
 * The same splitting `humanise` does for a tool name, pulled out so a server key can be broken into
 * words too rather than compared as one opaque token.
 */
function wordsOf(text: string): string[] {
  return text
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase()
    .split(" ")
    .filter((word) => word.length > 0);
}

/**
 * Whether `needle` occurs in `haystack` as a run of whole words, in order and unbroken.
 *
 * This is the whole-word alternative to a substring test: `["routine"]` must line up with a word
 * in `["create", "routine"]`, not merely appear inside one of its letters.
 */
function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word))
      return true;
  }
  return false;
}
