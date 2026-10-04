import { z } from "zod";
import {
  buildIndex,
  parseRepoRef,
  type RepoIndex,
  type RepoSpec,
  readFile,
  resolveAmbiguousRef,
} from "./repo-index";

/**
 * Drafting skills out of a public repository, server-side.
 *
 * WHAT THIS IS. A person pastes a repository URL on the Skills screen, and this module reads the
 * repository and answers with skill drafts — the same five things the New-skill form asks for,
 * written once. Nothing is saved: the caller annotates each draft with whether its slug already
 * names a skill here, and the person decides what to keep. A skill can only add tools at run time,
 * so an unsaved draft is inert by construction — the form, and the ownership rule in
 * `POST /skills`, stay the ones that decide.
 *
 * WHAT "SKILLS" MEANS HERE. Files written as agent instructions: a `SKILL.md` anywhere in the
 * tree, a markdown file under a `skills/` folder, or a file named `*-skill.md`. Those are the
 * files a repository authors for its own agents, and they are what "add the skills this repo
 * contains" has to mean. A repository with none of them still yields one draft, written from
 * its carried files (README, AGENTS.md, a manifest) — one draft rather than none, because the
 * honest reading there is "this repository can be worked on", and the person reviews it anyway.
 *
 * THE MODEL CALL IS THE SAME ONE THE ROUTER USES. `complete` is a `createModelCompleter` from
 * `server/routing/model.ts`, so this module answers with JSON because the underlying call sets
 * `response_format`, and it throws on a missing key — which the route translates into the 503 a
 * deployment without a model answers every part of the product with. `index` and `read` are
 * seams so the tests drive this module with no network and no GitHub.
 */

/** One drafted skill, in the shape the form accepts. */
export type SkillDraft = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  /** The file the draft was grounded in, echoed back for the list. Null when unverifiable. */
  source: string | null;
  /** Filled in by the route, not the model: whose slug this one already names here. */
  existing?: "yours" | "the deployment's" | "someone else's" | null;
};

export type SkillDrafts = {
  drafts: SkillDraft[];
  repository: {
    url: string;
    ref: string;
    path: string;
    fileCount: number;
    truncated: boolean;
  };
};

/** How many skill files get carried whole. Beyond this the instruction is noise, not coverage. */
const MAX_SOURCE_FILES = 12;

/** Per-file and total prompt budgets, so a bundled monorepo cannot flood the context window. */
const PER_FILE_CHAR_CAP = 12_000;
const TOTAL_CHAR_CAP = 60_000;

/** At most this many valid drafts come back; a repo dictating three hundred is a misread. */
export const DRAFT_CAP = 20;

export function createSkillDrafter(deps: {
  complete: (prompt: string, signal?: AbortSignal) => Promise<string>;
  /** Test seam for the whole round-trip. Defaults to `buildIndex`. */
  index?: (spec: RepoSpec, signal?: AbortSignal) => Promise<RepoIndex>;
  /** Test seam. Defaults to `readFile`. */
  read?: (
    spec: RepoSpec,
    path: string,
    index: RepoIndex,
    signal?: AbortSignal,
  ) => Promise<string>;
}): (repo: string, signal?: AbortSignal) => Promise<SkillDrafts> {
  const indexOf = deps.index ?? buildIndex;
  const read = deps.read ?? readFile;

  return async (repo: string, signal?: AbortSignal) => {
    const parsed = parseRepoRef(repo);
    if (!parsed.ok) {
      /*
       * The route refuses this too, so the parsed pair of checks is kept in one place. A
       * caller that skipped the route still gets the parser's own sentence rather than a
       * fetch of something the parser would not have read.
       */
      throw new DraftRefusedError(parsed.error);
    }
    const spec = await resolveAmbiguousRef(parsed.value, signal);
    const index = await indexOf(spec, signal);

    const candidates = skillFileCandidates(index.tree);
    const files: { path: string; text: string }[] = [];
    let budget = TOTAL_CHAR_CAP;
    for (const path of candidates) {
      if (files.length >= MAX_SOURCE_FILES || budget <= 0) break;
      const text = (await read(spec, path, index, signal)).slice(
        0,
        PER_FILE_CHAR_CAP,
      );
      files.push({ path, text });
      budget -= text.length;
    }

    /*
     * The fallback is the same files `buildIndex` already carried whole, so a repo with no
     * SKILL.md still produces a draft rather than nothing. The prompt names the situation so
     * the model is asked to write a skill about the codebase, not to summarise the README.
     */
    const groundedInCarried = candidates.length === 0;
    if (groundedInCarried) {
      for (const [path, text] of Object.entries(index.keyFiles)) {
        if (files.length >= MAX_SOURCE_FILES || budget <= 0) break;
        budget -= text.length;
        files.push({ path, text: text.slice(0, PER_FILE_CHAR_CAP) });
      }
    }

    const prompt = draftPrompt({
      fullName: index.fullName,
      ref: index.ref,
      description: index.description,
      groundedInCarried,
      files,
    });
    const answer = await deps.complete(prompt, signal);
    const drafts = readDrafts(answer) ?? [];

    return {
      drafts,
      repository: {
        url: `https://github.com/${index.fullName}`,
        ref: index.ref,
        path: spec.path,
        fileCount: index.tree.length,
        truncated: index.truncated,
      },
    };
  };
}

/** Refused to read the address at all. The route surfaces the parser's sentence, as a 400. */
export class DraftRefusedError extends Error {}

/**
 * The paths that author a repository's skills, shallowest first.
 *
 * EXPORTED BECAUSE THE ORDERING IS THE PROMISE. "As many as the repo actually contains" means
 * every `SKILL.md` file, not the first one `git/trees` happened to hand back, and the cap is
 * applied after the ordering so the files closest to the repository's root win a close race.
 * Pure over its argument, so the test is free of GitHub.
 */
export function skillFileCandidates(paths: readonly string[]): string[] {
  return paths
    .filter((path) => isSkillFile(path))
    .sort((a, b) => {
      const depth = (s: string) => s.split("/").length;
      const d = depth(a) - depth(b);
      return d !== 0 ? d : a.localeCompare(b);
    })
    .slice(0, MAX_SOURCE_FILES * 4);
}

function isSkillFile(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  if (/^skill\.md$/i.test(name)) return true;
  if (/[-_]skill\.md$/i.test(name)) return true;
  // A markdown file under a `skills/` folder is a skill by its address.
  if (/(^|\/)skills\/.+\.md$/i.test(path)) return true;
  return false;
}

function draftPrompt(input: {
  fullName: string;
  ref: string;
  description: string | null;
  groundedInCarried: boolean;
  files: { path: string; text: string }[];
}): string {
  const note = input.groundedInCarried
    ? "No SKILL.md files were found. Derive one skill about what this codebase does and how to work on it, grounded in the carried files below."
    : "Extract one skill per skill file below, and no more than one skill beyond that when the files plainly describe a shared effort. Each skill keeps the file's own intent.";
  const blocks = input.files
    .map((file) => `### ${file.path}\n${file.text}`)
    .join("\n\n");
  return [
    `You are reading the public repository ${input.fullName}${input.description ? ` (${input.description})` : ""} at its ${input.ref} branch. ${note}`,
    "",
    "For each skill produce:",
    '- "slug": the / command, lower-case letters, numbers and hyphens, 2 to 40 characters, like `tauri-windows-signing`.',
    '- "title": a few words of sentence case, up to 120 characters.',
    '- "summary": one line, up to 200 characters, no trailing period.',
    '- "instructions": the instruction the Bot follows, written to the Bot as directions. Keep what the source file says; do not pad or generalise away specifics.',
    '- "source": the path of the file it came from.',
    "",
    'Reply with JSON only: {"drafts": [ ... ]}. No prose outside the object.',
    "",
    blocks,
  ].join("\n");
}

/** The same lengths and slug shape the form and schema are held to, so a draft that saves is one route checks. */
const draftSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/),
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(200).catch(""),
  instructions: z.string().trim().min(1),
  source: z.string().trim().nullable().catch(null),
});

/**
 * Read the model's answer, the way the router reads its own: object first, whole answer never.
 *
 * Returns the valid unique drafts, or null when there is no object at all. Drafts that fail the
 * schema are dropped rather than making the whole answer unusable — a repository that produced
 * one malformed draft out of six should lose that draft, not the five.
 */
export function readDrafts(answer: string): SkillDraft[] | null {
  const object = answer.match(/\{[\s\S]*\}/);
  if (!object) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(object[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const drafts = (parsed as { drafts?: unknown }).drafts;
  if (!Array.isArray(drafts)) return null;

  const seen = new Set<string>();
  const out: SkillDraft[] = [];
  for (const candidate of drafts) {
    const checked = draftSchema.safeParse(candidate);
    if (!checked.success) continue;
    const { slug } = checked.data;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ ...checked.data, existing: null });
    if (out.length >= DRAFT_CAP) break;
  }
  return out;
}
