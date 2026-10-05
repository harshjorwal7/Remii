import { textOf } from "../agents/message-text";
/**
 * Choosing which of a Bot's tools to put in front of the model, one run at a time.
 *
 * WHY THIS EXISTS. A model picks the right tool reliably out of about ten. Past roughly fifteen the
 * choice starts to go wrong, and it goes wrong quietly: the model calls a plausible neighbour, or
 * calls nothing and answers from memory. A realistic deployment of this template clears fifteen on
 * the first afternoon, because Drive and Slack and Jira and the browser each bring several. So the
 * catalogue has to be narrowed before the model sees it, and the unit that does the narrowing is the
 * skill: a skill says what it is for in one line, and it says which tools it needs.
 *
 * THE NARROWING IS NOT A BOUNDARY, AND MUST NEVER BE MISTAKEN FOR ONE. What a Bot may call is the
 * grant, checked in `callTool` along with the policy and the audit row. This decides only what is
 * offered out of what was already granted. Everything here can be wrong, or skipped entirely, and no
 * Bot gains a single capability it did not already hold. That is why the failure direction below is
 * "offer everything" rather than "offer nothing": narrowing is an accuracy device, and failing it
 * closed would take away tools an administrator granted because a model call timed out.
 *
 * WHY THE MODEL CHOOSES AND NOT A RETRIEVER. A retrieval prefilter fails categorically. If the tool
 * the run needed is not in the retrieved set, no amount of model capability gets it back, and the
 * published result is that a prefilter at 99% recall can land at or below no prefilter at all for
 * exactly that reason. A model that picks the wrong skill is wrong in a way the next turn can fix.
 * A prefilter that drops the tool is wrong in a way nothing can. So the model chooses, retrieval (if
 * a deployment ever needs it) narrows into that choice rather than replacing it, and every uncertain
 * case here resolves towards offering more rather than less.
 */

/** One granted skill, as much of it as choosing needs. */
export type SelectableSkill = {
  slug: string;
  title: string;
  /** The one line the model reads. This is the index; see K3. */
  summary: string;
  /** What the skill says it needs, as `<serverId>/<toolName>` refs. A declaration, not a grant. */
  tools: readonly string[];
};

/** A granted tool, as much of it as narrowing needs. */
export type SelectableTool = {
  /** `<serverId>/<toolName>`, the key a grant and a declaration are both written against. */
  ref: string;
};

/**
 * Why a run ended up offered what it was offered.
 *
 * Recorded rather than inferred, because every one of these looks identical from outside: the model
 * was handed some tools. Which of them happened decides whether a wrong answer is a selection bug, a
 * deployment that never declared anything, or a model call that failed. Without the reason, all
 * three read as "the Bot did not use its tools".
 */
export type SelectionReason =
  /** Few enough tools that a model chooses well among them unaided. Nothing was narrowed. */
  | "under-floor"
  /** No granted skill declares any granted tool, so there is no unit to select over. */
  | "nothing-declared"
  /** Pass one could not answer: no key, a timeout, a malformed reply. Everything stays offered. */
  | "unavailable"
  /** Pass one answered and named no skill. Everything stays offered; see the note below. */
  | "nothing-chosen"
  /** Pass one named skills, and the offer is their tools plus everything no skill claims. */
  | "selected";

export type Selection<Tool extends SelectableTool> = {
  /** What to hand the model. Always a subset of what was granted, and never a superset. */
  offered: Tool[];
  /** The slugs pass one chose. Empty for every reason other than `selected`. */
  skills: string[];
  reason: SelectionReason;
  /** How many were granted, so a reader can see the narrowing without recomputing it. */
  granted: number;
};

/**
 * Below this, the catalogue is already inside the range a model chooses well from, so pass one is a
 * model call that buys nothing and costs a round trip on every single run.
 *
 * Twelve because the reported knee is ten to fifteen and the cost of being slightly under it is
 * nothing, while the cost of being over it is a wrong tool call nobody sees. This is a template's
 * default, not a law: a deployment that measures its own knee somewhere else should move it.
 *
 * SaaS mode runs it at 64: modern models choose well from a few dozen tools, and every run under
 * the floor skips pass one entirely — one fewer model round trip before the Bot starts working.
 */
export const SELECTION_FLOOR = 64;

/**
 * What pass one is asked, given the message and the skills the Bot holds.
 *
 * Deliberately biased towards choosing. The two mistakes are not symmetrical: an extra skill costs a
 * few tool definitions in the context, and a missing one costs the answer, because the tool it would
 * have loaded is not there to call. The prompt says so in as many words rather than leaving the
 * model to guess the trade, and the caller treats an empty answer as "offer everything" for the same
 * reason.
 */
export function selectionPrompt(
  text: string,
  skills: readonly SelectableSkill[],
): string {
  const catalogue = skills
    .map((skill) => `- ${skill.slug}: ${skill.title}. ${skill.summary}`)
    .join("\n");
  return [
    "You choose which capabilities to load for the message below. You are not answering it.",
    "",
    "Capabilities available:",
    catalogue,
    "",
    "Message:",
    text,
    "",
    'Reply with only JSON: {"skills": ["<slug>", ...]}.',
    "Choose every capability that might be needed, including ones you are only somewhat sure about.",
    "Choosing one that turns out to be unnecessary costs almost nothing. Failing to choose one that",
    "was needed means the work cannot be done at all, because its tools will not be loaded. When in",
    "doubt, include it. Use an empty list only when the message plainly needs none of them.",
  ].join("\n");
}

/**
 * Read pass one's answer into slugs, or `null` when it did not answer usefully.
 *
 * `null` and `[]` mean different things and the caller treats them differently: `null` is "the
 * selector did not work", `[]` is "the selector says none apply". Both currently end at the same
 * place, offering everything, but they are different facts and the audit row records which.
 *
 * Anything the model names that is not a granted skill is dropped rather than treated as an error.
 * A model inventing a slug should cost that slug, not the whole selection.
 */
export function readChosenSkills(
  answer: string,
  skills: readonly SelectableSkill[],
): string[] | null {
  /*
   * The object in the answer, not the answer as a whole.
   *
   * `response_format` asks for bare JSON and does not guarantee it: Anthropic's OpenAI-compatible
   * endpoint ignores the field, and a model left to itself often fences its object or leads with a
   * sentence. Parsed whole, every such answer read as a selector that could not say, and a Bot on
   * that model was offered its entire catalogue on every run. The router reads its answer from the
   * same completer this way already (`classify.ts`); an answer with no object in it is still null.
   */
  const object = answer.match(/\{[\s\S]*\}/);
  if (!object) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(object[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const chosen = (parsed as { skills?: unknown }).skills;
  if (!Array.isArray(chosen)) return null;
  const known = new Set(skills.map((skill) => skill.slug));
  return [
    ...new Set(
      chosen.filter(
        (slug): slug is string => typeof slug === "string" && known.has(slug),
      ),
    ),
  ];
}

/**
 * The tools a set of chosen skills asks for, intersected with what the Bot actually holds.
 *
 * The intersection is the whole safety property. A skill may name any tool: anybody signed in may
 * write one, and `skill_tools` deliberately has no foreign key and grants nothing. If a declaration
 * could widen the offer, writing a skill would be a way to hand yourself a tool, and the one surface
 * here that is not an administrator's would become the way around every surface that is.
 */
function declaredBy(
  skills: readonly SelectableSkill[],
  granted: ReadonlySet<string>,
): Set<string> {
  const refs = new Set<string>();
  for (const skill of skills) {
    for (const ref of skill.tools) if (granted.has(ref)) refs.add(ref);
  }
  return refs;
}

/**
 * Narrow one Bot's granted tools for one run.
 *
 * `choose` is pass one, injected rather than called here so this stays a plain function a test can
 * drive without a network. It may throw or return `null`; both mean "could not say", and both leave
 * every granted tool offered.
 */
export async function selectTools<Tool extends SelectableTool>(input: {
  tools: readonly Tool[];
  skills: readonly SelectableSkill[];
  /** The message this run is about. Empty is treated as "cannot say", not as "needs nothing". */
  text: string;
  choose: (
    prompt: string,
    signal?: AbortSignal,
  ) => Promise<string | null> | (string | null) | Promise<never>;
  signal?: AbortSignal;
  /** Overridable so a deployment that measured its own knee is not stuck with ours. */
  floor?: number;
}): Promise<Selection<Tool>> {
  const { tools, skills, text } = input;
  input.signal?.throwIfAborted();
  const floor = input.floor ?? SELECTION_FLOOR;
  const everything = (reason: SelectionReason): Selection<Tool> => ({
    offered: [...tools],
    skills: [],
    reason,
    granted: tools.length,
  });

  if (tools.length <= floor) return everything("under-floor");

  const grantedRefs = new Set(tools.map((tool) => tool.ref));
  const declared = declaredBy(skills, grantedRefs);
  // Nothing to select over. A Bot with grants and no skills is every deployment on day one, and it
  // must behave exactly as it did before this existed.
  if (declared.size === 0) return everything("nothing-declared");
  if (text.trim() === "") return everything("unavailable");

  let chosen: string[] | null = null;
  try {
    const answer = await input.choose(
      selectionPrompt(text, skills),
      input.signal,
    );
    input.signal?.throwIfAborted();
    chosen =
      typeof answer === "string" ? readChosenSkills(answer, skills) : null;
  } catch {
    // A user stopping the run is not an unavailable selector. Never start a fallback model run.
    input.signal?.throwIfAborted();
    // A selector that failed is not an error a person should ever see. It costs this run the
    // narrowing and nothing else, which is the behaviour that shipped before it existed.
    chosen = null;
  }
  if (chosen === null) return everything("unavailable");
  /*
   * The model says none apply, and everything stays offered anyway.
   *
   * Reading this as "offer only the tools no skill claims" would be the categorical failure the
   * header warns about: one bad judgement in pass one, and the tool the run needed is not merely
   * ranked low, it is absent. Offering everything here is the behaviour that shipped before
   * selection existed, so the worst case of a confused selector is exactly the old accuracy rather
   * than a Bot that has lost its hands.
   */
  if (chosen.length === 0) return everything("nothing-chosen");

  const wanted = declaredBy(
    skills.filter((skill) => chosen.includes(skill.slug)),
    grantedRefs,
  );
  return {
    /*
     * The chosen skills' tools, plus every granted tool no skill claims at all.
     *
     * Undeclared tools ride along on purpose. A declaration is opt-in, so an administrator can grant
     * a tool that no skill has been written for yet, and dropping it would silently remove a
     * capability somebody deliberately handed over. The offer therefore shrinks as skills come to
     * cover the catalogue, and a deployment that has declared nothing is never punished for it.
     */
    offered: tools.filter(
      (tool) => !declared.has(tool.ref) || wanted.has(tool.ref),
    ),
    skills: chosen,
    reason: "selected",
    granted: tools.length,
  };
}

/**
 * The message pass one reads: the last thing the person said.
 *
 * The last user message rather than the whole thread, because what to load is a question about the
 * turn being taken. Feeding the transcript in would make an early mention of Drive keep Drive tools
 * loaded for the rest of the conversation, which is the opposite of narrowing.
 */

export function latestUserText(
  messages: readonly { role?: string; content?: unknown }[],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    // AG-UI allows structured content, and text parts are the only part a selector can read. See
    // textOf: a hop asks the same question of the same shapes.
    if (typeof message.content === "string") return message.content;
    const text = textOf(message.content);
    return text === "" ? "" : text;
  }
  return "";
}

/**
 * NARROWING BY APP, WHICH IS THE UNIT THAT ACTUALLY EXISTS IN A COMPOSIO DEPLOYMENT.
 *
 * WHY IT IS SEPARATE FROM THE SKILL PASS ABOVE. Two reasons, and the second is the one that matters.
 *
 * The first is that a skill is opt-in and no deployment has any. `selectTools` returns
 * `nothing-declared` — everything offered — for a Bot with grants and no skills, which is every
 * deployment on day one and most deployments after a year. So the skill pass is off exactly when a
 * catalogue has grown large enough to need narrowing.
 *
 * The second is the number. `SELECTION_FLOOR` is 64, and Gmail publishes 63 actions. A Bot connected
 * to Gmail and nothing else sits ONE below the floor: every run is handed sixty-three tool
 * definitions and schemas, which is several thousand tokens of context to choose from, and the
 * module's own header says a model chooses reliably out of about ten and starts going wrong past
 * fifteen — quietly, by calling a plausible neighbour or by answering from memory. So the largest
 * single-app deployment in the product was the one the floor exempted.
 *
 * AN APP IS A BETTER UNIT THAN A SKILL HERE because it needs no declaration to exist. Every granted
 * Composio tool already names its app in its own name, so the grouping is free, needs no model call,
 * and cannot be wrong about a Bot's capabilities — every action of a relevant app is still granted,
 * still checked in `callTool`, still written to the audit row.
 *
 * AND IT IS NOT A BOUNDARY, for the same reason the skill pass is not. See the header: what a Bot may
 * call is the grant, and this decides only what is offered out of what was already granted. Every
 * failure direction here is "offer everything", and the dropped tools stay reachable through
 * `composio_search_tools`, which is built over the FULL granted set rather than over the offered one.
 */

/** A granted tool, as much of it as narrowing by app needs. */
export type SelectableAppTool = SelectableTool & {
  /** `mcp__<serverId>__<toolName>`, the shape the model is offered. */
  name: string;
  description: string;
};

/**
 * How many tools one app may contribute before the rest wait for a search.
 *
 * Sixteen rather than ten. The module's own header puts reliable choice at about ten and says past
 * fifteen it goes wrong — but this is per APP, not for the whole catalogue, so the number has to
 * leave room for an app whose actions overlap: Gmail's read actions alone are `GMAIL_FETCH_EMAILS`,
 * `GMAIL_FETCH_MESSAGE`, `GMAIL_FETCH_THREAD`, `GMAIL_GET_MESSAGE`, `GMAIL_LIST_MESSAGES`,
 * `GMAIL_LIST_THREADS`, `GMAIL_LIST_LABELS`, `GMAIL_LIST_DRAFTS`, and a query the model cannot make
 * from one line. Ten of sixty-three would cut the reads in half to save context that the app budget
 * in `./result-budget` has already made cheap elsewhere.
 */
export const APP_SELECTION_PER_APP = 16;

/**
 * Below this many tools, no narrowing at all.
 *
 * Smaller than {@link SELECTION_FLOOR} because this pass is free and runs on every run, so it has to
 * pay for itself sooner than a pass that spends a model round trip does. Past this the arithmetic is
 * not close — a Bot on three small apps clears 24 easily and gains nothing from being trimmed.
 */
export const APP_SELECTION_FLOOR = 24;

/** Why a run ended up offered what it was offered. See {@link Selection} for the same idea. */
export type AppSelectionReason =
  /** Few enough tools that everything stays offered. */
  | "under-floor"
  /** Nothing in the message named an app, so nothing was ruled out. */
  | "nothing-matched"
  /** Some apps were ruled out and the rest were ranked. */
  | "selected";

export type AppSelection<Tool extends SelectableAppTool> = {
  /** What to hand the model. Always a subset of what was granted. */
  offered: Tool[];
  /**
   * The apps whose actions were offered, for a reader deciding whether the narrowing was sensible.
   * Every action of every app NOT named here is still granted, still reachable by search, and still
   * checked the same way when called.
   */
  apps: string[];
  reason: AppSelectionReason;
  /** How many were granted, so a reader can see the narrowing without recomputing it. */
  granted: number;
};

/**
 * The app a tool belongs to, or null for a tool that belongs to no app.
 *
 * READ OFF THE NAME, because that is the one place the app is written. `toolNameFor` builds it as
 * `mcp__<serverId>__<toolName>` — the slash a grant uses cannot go in a model tool name, which is
 * exactly why the app is readable from the model's spelling and the grant's is not.
 *
 * Null for everything else rather than a guess: a desktop tool, a workbench tool, a `gog_` tool and a
 * `local/` tool are not app actions and are never narrowed by this pass. `mcp__` with nothing after it
 * is null too, so a malformed name falls into "no app" and is therefore never dropped.
 */
export function appOf(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0) return null;
  return rest.slice(0, separator);
}

/**
 * Tokens worth matching on, from what the person said.
 *
 * LONGER THAN TWO CHARACTERS, and that is the whole filter. Everything this scores is a substring
 * test over app names and vendor action names, so a two-letter token matches most of both and a
 * three-letter token matches a few — "did" in "did the invoice arrive" would put every app with "di"
 * in it into contention.
 */
function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

/** How many of the tokens appear in the haystack. One point each, so length does not dominate. */
function scoreOf(haystack: string, tokens: readonly string[]): number {
  let score = 0;
  for (const token of tokens) if (haystack.includes(token)) score += 1;
  return score;
}

/**
 * Narrow one Bot's granted tools to the apps this run is about.
 *
 * `signal` is honoured between apps so a person who stops a run during selection gets a stop rather
 * than a wait — and, like the skill pass, this is a pure function over what was already granted, so
 * every way it can fail is a way it can offer too much.
 */
export async function selectToolsForApps<
  Tool extends SelectableAppTool,
>(input: {
  tools: readonly Tool[];
  text: string;
  signal?: AbortSignal;
  /** Overridable so a deployment that measured its own knee is not stuck with ours. */
  floor?: number;
  /** Overridable for the same reason. */
  perApp?: number;
}): Promise<AppSelection<Tool>> {
  const { tools, text } = input;
  input.signal?.throwIfAborted();
  const floor = input.floor ?? APP_SELECTION_FLOOR;
  const perApp = input.perApp ?? APP_SELECTION_PER_APP;
  const everything = (reason: AppSelectionReason): AppSelection<Tool> => ({
    offered: [...tools],
    apps: [],
    reason,
    granted: tools.length,
  });

  if (tools.length <= floor) return everything("under-floor");

  /*
   * GROUPED BY APP FIRST, so an app is judged once rather than once per action. Gmail's sixty-three
   * actions all contain "GMAIL" and most contain "LIST", so scoring per action would let a message
   * mentioning "list" rule Gmail relevant on the strength of its own pagination actions and then rank
   * sixty-three near-identical haystacks against each other.
   */
  const byApp = new Map<string, Tool[]>();
  for (const tool of tools) {
    const app = appOf(tool.name);
    // Not an app action, or an unnameable one. Never dropped: this pass narrows APPS.
    if (app === null) continue;
    const bucket = byApp.get(app);
    if (bucket) bucket.push(tool);
    else byApp.set(app, [tool]);
  }
  const tokens = tokensOf(text);
  if (tokens.length === 0) return everything("nothing-matched");

  /*
   * ONE APP IS STILL WORTH NARROWING, and the question this actually answers is not "which app" —
   * with one app that is already decided — but "how many of it". Gmail's sixty-three actions on a
   * single-app Bot is the case this pass exists for, and a floor here would be the floor the old
   * number had: one short of where the problem sat, by construction.
   *
   * Left out on purpose, so the natural-but-wrong version of this guard goes noticed: returning the
   * whole list whenever `byApp.size === 1`. That reads as safe because it is the old behaviour, and it
   * is exactly the behaviour that made every Gmail run a sixty-three-tool prompt while one line in
   * this module explained the cost of it. The "nothing matched" branch above is where the fail-open
   * lives; nothing more needs to be offered than that branch and the per-app cap already produce.
   */

  /*
   * ONE SET OF WORDS PER APP, MATCHED WHOLE.
   *
   * An app is relevant when a word from the message appears in that app's vocabulary — its id, and
   * the whole names of its balanced actions. Splitting on every non-letter does two jobs at once. It
   * turns `mcp__gmail__GMAIL_SEND_EMAIL` into {gmail, send, email}, which is a sentence a person can
   * actually write ("email", "send"), and it COMMAS rather than abridges: a substring test against
   * `thread` read "the" as a match for every Gmail run on earth, because "the" is a prefix of "thread"
   * and is in every sentence ever said — which is the scoring that made a message about Drive offer
   * Gmail. Whole words fail the other way sometimes — "invoice" is not a word in any tool name — and
   * that failure is the safe one: it offers everything. See the `nothing-matched` branch.
   *
   * GENERIC WORDS ARE DROPPED from the app's side of the comparison. `compose`/`tool`/`mcp`/`app`
   * appear in every Composio name and would mark every app as relevant to every message for the same
   * reason "the" did.
   */
  const GENERIC = new Set(["tool", "tools", "mcp", "app", "apps", "the"]);
  const wordsOf = (names: readonly string[]): Set<string> => {
    const words = new Set<string>();
    for (const name of names) {
      for (const part of name.toLowerCase().split(/[^a-z0-9]+/)) {
        if (part.length > 2 && !GENERIC.has(part)) words.add(part);
      }
    }
    return words;
  };

  const relevant = new Map<string, number>();
  for (const [app, appTools] of byApp) {
    const vocabulary = wordsOf([app, ...appTools.map((tool) => tool.name)]);
    let score = 0;
    for (const token of tokens) if (vocabulary.has(token)) score += 1;
    if (score > 0) relevant.set(app, score);
  }

  /*
   * NOTHING MATCHED IS OFFER EVERYTHING, and this is the load-bearing branch. A run about something
   * with no app vocabulary in it — "reply to that email from Sarah", where the message names no app —
   * would otherwise be offered nothing at all, which is the categorical failure the header of this
   * module is about: a tool the run needed that is merely unranked low versus one that is not there.
   */
  if (relevant.size === 0) return everything("nothing-matched");

  /*
   * AN APP WITH MORE THAN ITS SHARE IS NEVER DROPPED WHOLLY. Ranking decides which of Gmail's sixty-three
   * actions are offered, never whether Gmail is: an app that scored and then lost every action to the
   * cap is an app the model cannot use this turn, and the discovery record would read as though it had
   * been ruled out.
   */
  const offered: Tool[] = [];
  const ranked: { app: string; tool: Tool; score: number }[] = [];
  for (const tool of tools) {
    const app = appOf(tool.name);
    /*
     * A TOOL THAT BELONGS TO NO APP IS NEVER RULED OUT by this pass. Desktop tools, the workbench, the
     * local CLI — their app-ness is unknown, so the conservative reading is "always offer them" in
     * the same breath as "never narrow them out". `app === null` is the unnameable-name case too, so a
     * malformed tool name cannot cause a tool to vanish from the list it is granted.
     */
    if (app === null) {
      offered.push(tool);
      continue;
    }
    /*
     * IRRELEVANT APPS ARE NOT OFFERED. They are the thing this pass exists to remove from the prompt:
     * seventy-two Slack definitions on a run about Drive is the cost `APP_SELECTION_PER_APP` is meant
     * to stop. They remain reachable — `composio_search_tools` ranks over the WHOLE grant, not over
     * what this run was offered — and `callTool` still checks the grant before anything runs, so this
     * is a ranking, never a boundary.
     */
    if (!relevant.has(app)) continue;
    /*
     * EVERY ACTION OF A RELEVANT APP IS RANKED, including the ones whose own name matches nothing.
     * Which of Gmail's sixty-three actions are offered is a separate decision made by the cap below,
     * and an app whose actions all scored zero still gets its share, because an app that is relevant
     * and contributes nothing is an app the model cannot use this turn.
     */
    ranked.push({
      app,
      tool,
      score: scoreOf(`${tool.name} ${tool.description}`.toLowerCase(), tokens),
    });
  }

  /*
   * RANKED WITHIN EACH APP, keeping the cap per app rather than a cap overall. A global cap on a
   * two-app Bot would be spent by whichever app scored higher, and the second app would arrive as one
   * action however many it has — which is the shape that produced a Bot that could read Gmail and not
   * Slack, from a deployment that had connected both.
   *
   * Name-ordered on a tie, because the grant list arrives from a database and two deployments with
   * the same grants must offer the same tools in the same order or a run is not reproducible.
   */
  const kept = new Map<string, number>();
  ranked.sort(
    (left, right) =>
      right.score - left.score || left.tool.name.localeCompare(right.tool.name),
  );
  for (const entry of ranked) {
    const count = kept.get(entry.app) ?? 0;
    if (count >= perApp) continue;
    kept.set(entry.app, count + 1);
    offered.push(entry.tool);
  }

  input.signal?.throwIfAborted();
  /*
   * DEDUPLICATED, because a tool can match on both its app and its own name and be queued twice. Not
   * `new Set` on the array alone: the offered list is also the order the model reads, and a repeat
   * would offer the same definition twice.
   */
  const seen = new Set<string>();
  const unique = offered.filter((tool) => {
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });

  /*
   * NOTHING WAS NARROWED IS STILL `selected`, because this pass ran and ruled nothing out — the
   * distinction that matters to a reader is whether the app grouping had anything to say, not whether
   * the cap happened to bite.
   */
  return {
    offered: unique,
    apps: [...relevant.keys()].sort(),
    reason: "selected",
    granted: tools.length,
  };
}
