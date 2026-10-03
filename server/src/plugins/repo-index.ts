/**
 * Reading a public GitHub repository, and the rules about how much of it.
 *
 * WHY A SKILL MAY NAME ONE. A skill is an instruction, and the reason anybody signed in may write
 * one is that it adds no capability: it can only ask a Bot for what that Bot was already granted
 * (`db/schema/plugins.ts` says so at length on `skills`). A repository read at run time keeps that
 * argument honest — it adds no tool, opens no credential and reaches no system this deployment does
 * not already reach. It is prose that was published to be read.
 *
 * WHICH IS AN ARGUMENT ABOUT PUBLIC REPOSITORIES AND NOT ABOUT THE OTHER KIND, so this module
 * refuses everything else. There is no token in the store, no token in the URL, and no path through
 * here that reaches a host other than `api.github.com`: the parser hands back an owner, a repository
 * and nothing else, and every request is built from those three values against a constant base. A
 * private repository would need a credential, a credential would need somewhere to live, and the
 * moment it does the content stops being public — which would make "a skill grants no capability"
 * no longer true. So `parseRepoRef` accepts only `github.com`, and the answer for anything else is a
 * sentence rather than a fallback.
 *
 * EVERY LIMIT HERE IS A LIMIT ON WHAT GOES INTO A MODEL'S CONTEXT, NOT ON WHAT GOES INTO A DATABASE.
 * A repository is unbounded and a context window is not, so each of these numbers is the point where
 * the alternative would be a run that fails with an unhelpful 400 from the provider rather than one
 * that says what it left out.
 */

/** GitHub's REST API, and the only host anything here is ever asked for. */
const API = "https://api.github.com";

/** How long one GitHub call may take before it is treated as the vendor being unwell. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The largest response body accepted, in bytes, for any call.
 *
 * Checked against `content-length` before the body is read, so an oversized answer is refused
 * without being pulled into this process. The tree of a very large repository is the case that
 * matters: `git/trees?recursive=1` answers with every path in the repository and no way to ask for
 * less, so a monorepo with a hundred thousand files would otherwise be read in full to be counted.
 */
const RESPONSE_CAP_BYTES = 8_000_000;

/**
 * How many file paths one cached index holds.
 *
 * Not the number GitHub will return — it caps that itself and says so with `truncated` — but the
 * number worth carrying. A model looking for something in a repository starts at the top of it, so
 * what survives the cut is chosen by depth below in {@link buildIndex} rather than by GitHub's
 * ordering. A tree that lost its tail says so in `truncated`, and the tool that offers it says so
 * again in its description, rather than the Bot concluding a file is absent because it was dropped.
 */
export const TREE_LIMIT = 5_000;

/**
 * How many files are carried whole, and how many bytes they may come to between them.
 *
 * This is what makes search a search. Fetching every blob of a repository to look for a string in it
 * is not something a run may do on the strength of one `/` command, so the files carried are the ones
 * that describe the repository rather than implement it: the README, the docs, the manifests. What a
 * model almost always needs from a repository it has not seen is how the thing is built and called,
 * and that is what these are.
 *
 * It is also the reason the tool description says plainly that search covers paths and these files
 * rather than every source file. A tool that quietly under-reports is worse than one that says what
 * it does not do, because the model will report a negative it did not actually establish.
 */
export const KEY_FILE_LIMIT = 40;
export const KEY_FILE_BYTES = 200_000;

/** One key file, over this, is skipped rather than truncated: half a manifest is a lie. */
const KEY_FILE_CAP_BYTES = 100_000;

/**
 * Where in a run one file may put, in lines.
 *
 * Two thousand lines is roughly the point where a source file stops being readable in one go anyway,
 * and a refusal that names the range to ask for next is a better answer than a truncated file with
 * no indication that there was more.
 */
export const FILE_LINE_LIMIT = 2_000;

/** And in bytes, which is the limit that actually binds on a file of very long lines. */
export const FILE_BYTE_LIMIT = 40_000;

/** What one search returns of each kind, so a broad term cannot flood the context. */
const SEARCH_PATH_LIMIT = 40;
const SEARCH_CONTENT_LIMIT = 40;

/**
 * Extensions never carried whole.
 *
 * A short list, and chosen for what is unambiguous rather than exhaustive: anything that is text in
 * a repository's own documentation has an extension this list does not name, so the size cap and
 * GitHub's own refusal to base64 anything binary are doing most of the work here. This catches the
 * common case — an icon, a screenshot, a fixture — without the list pretending to be a test of
 * whether a file is text.
 */
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "bmp",
  "tiff",
  "avif",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "jar",
  "war",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "mov",
  "avi",
  "wav",
  "ogg",
  "webm",
  "so",
  "dylib",
  "dll",
  "exe",
  "bin",
  "o",
  "a",
  "class",
  "wasm",
  "pyc",
  "pyo",
  "lock",
]);

/**
 * Owner and repository segments, as GitHub itself accepts them.
 *
 * Deliberately narrow. The host is a constant and these two are the only parts of a request that come
 * from the person, so this is the line that keeps `../` and `?` out of a URL. GitHub's own rules are
 * looser for repositories that begin with `.`, which is a spelling this does not need to accept.
 */
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * A branch, tag or commit.
 *
 * Slashes are allowed because branch names are paths (`release/2.4`), and everything that could
 * change what a URL means is refused: `..` walks up, a leading slash changes the path, `@{` opens a
 * reflog expression, and a `?` or `#` would end the segment it sits in. The value is percent-encoded
 * wherever it is used regardless — this is about not accepting nonsense, not about making encoding
 * optional.
 */
const REF = /^(?![./])(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]{1,255}$/;

/** A repository, pointed at, as the author wrote it and the server understood it. */
export type ParsedRepo = {
  owner: string;
  repo: string;
  /** The branch, tag or commit they named. Null means whatever the repository's default is. */
  ref: string | null;
  /** A subfolder inside the repository, with no leading or trailing slash. Empty for the whole. */
  path: string;
  /**
   * True when the address named a branch containing a slash, so the split above is a guess.
   *
   * NOT PERSISTED, and not something `readTree` acts on: it is the parser saying "I cannot tell you
   * whether `release/2.4` is one ref or two", and the route resolves it with
   * {@link resolveAmbiguousRef} before anything is written. What reaches the store is a decided ref and
   * path, so no row ever carries a question mark.
   */
  ambiguous?: boolean;
};

/** What a skill stores, once parsed. The same four values, with the URL gone. */
export type RepoSpec = ParsedRepo;

/**
 * A refusal with a sentence a person can act on.
 *
 * Not a thrown vendor object: GitHub's error bodies carry documentation URLs and, on a rate-limit
 * refusal, the reset time, and pasting those at somebody in a form is how a settings screen ends up
 * explaining HTTP to a person who only wanted to fix a URL. Everything here is written for the person
 * holding the form.
 */
export class RepoRefusedError extends Error {
  constructor(
    message: string,
    /** 400 for something the author can correct, 502 for GitHub being unwell. */
    readonly status: 400 | 403 | 429 | 502,
  ) {
    super(message);
    this.name = "RepoRefusedError";
  }
}

type Parsed = { ok: true; value: ParsedRepo } | { ok: false; error: string };

/**
 * Read a GitHub URL a person pasted, or tell them what is wrong with it.
 *
 * ACCEPTED, because each of these is something people actually paste:
 *   - `https://github.com/owner/repo`
 *   - `github.com/owner/repo`
 *   - `owner/repo`
 *   - `https://github.com/owner/repo.git`
 *   - `https://github.com/owner/repo/tree/release/2.4` — a branch and the folder under it
 *   - `https://github.com/owner/repo/commit/<sha>` — one commit, which reads exactly like the branch
 *
 * The bare `owner/repo` form is the one worth arguing about. It is unambiguous — the `/` is
 * required and the two halves are validated as GitHub validates them — and it is what a person types
 * when they mean "this repository" rather than "this page", which is what this field is for.
 *
 * Everything else is refused by name. A URL pointing anywhere but `github.com` is the case that
 * matters: this is the boundary between a person naming a repository and a person naming a host this
 * deployment will make a request to, and it is enforced here rather than trusted to the caller.
 */
export function parseRepoRef(input: string): Parsed {
  const raw = input.trim();
  if (!raw) {
    return { ok: false, error: "A repository URL is required." };
  }

  /*
   * `..` IS REFUSED ON THE RAW STRING, BEFORE `URL` IS ALLOWED TO NORMALISE IT AWAY.
   *
   * `new URL("https://github.com/owner/repo/tree/main/a/../../b").pathname` is `/owner/repo/tree/b` —
   * the parser resolves the dot segments itself, so by the time this code sees the path the evidence is
   * gone and `tree/b` arrives looking like a branch somebody legitimately asked for. Reading it from the
   * raw input first is the only place the evidence still exists. It is not a traversal vulnerability
   * either way, since every request here is built from validated segments against a constant host, but
   * silently reinterpreting an address is the kind of thing a person cannot debug.
   */
  if (/(?:^|\/)\.\.(?:\/|$)/.test(raw)) {
    return {
      ok: false,
      error:
        "That address steps outside the repository. Give the repository, or a folder inside it, like packages/api.",
    };
  }

  let rest: string;
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, error: "That is not a URL this can read." };
    }
    // The one check that keeps this a GitHub reader. `www.` is accepted because it is the same site.
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") {
      return {
        ok: false,
        error:
          "Only GitHub repositories can be read here. Give a github.com address — a repository on any other host is not reachable.",
      };
    }
    if (url.protocol !== "https:") {
      return {
        ok: false,
        error: "Use the https address of the repository.",
      };
    }
    /*
     * A query or a fragment is a LINK TO SOMETHING, not a repository, and dropping it quietly is worse
     * than refusing it: `?ref=main` and `#readme` both look like an address somebody pasted and both
     * mean somewhere more specific than the repository root.
     */
    if (url.search !== "" || url.hash !== "") {
      return {
        ok: false,
        error:
          "Give the repository address itself, without a link's options. Use github.com/owner/repo/tree/main to name a branch.",
      };
    }
    rest = url.pathname;
  } else if (/^github\.com\//i.test(raw)) {
    rest = raw.replace(/^github\.com\//i, "");
  } else if (/^[\w.-]+\/[\w.-]+(?:\/.*)?$/.test(raw)) {
    // The hostless form, with or without a branch and folder — `owner/repo/tree/main/packages/api` is
    // as reasonable to type as `owner/repo`, and the same segments are validated below either way.
    rest = raw;
  } else {
    return {
      ok: false,
      error:
        "Give a github.com address, or owner/repo — for example https://github.com/owner/repo.",
    };
  }

  const segments = rest
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        // A stray `%` is a typo, not an attack, and the answer should say so rather than 500.
        return segment;
      }
    })
    .filter((segment) => segment.length > 0);

  if (segments.length < 2) {
    return {
      ok: false,
      error:
        "A repository address names an owner and a repository — for example https://github.com/owner/repo.",
    };
  }

  const owner = segments[0] ?? "";
  // The `.git` suffix is how the address looks to a terminal, and everybody has it in their history.
  const repo = (segments[1] ?? "").replace(/\.git$/i, "");
  if (
    !SEGMENT.test(owner) ||
    !SEGMENT.test(repo) ||
    owner === "." ||
    repo === "."
  ) {
    return {
      ok: false,
      error:
        "That address has characters a GitHub owner or repository name cannot contain.",
    };
  }

  /*
   * The rest is a location inside the repository, and only the two shapes GitHub itself uses are
   * read. Anything else under a repository URL — a blob, an issue, a pull request — is somebody
   * following a link rather than naming a repository, and guessing which repository they meant would
   * attach a skill to the wrong code.
   */
  let ref: string | null = null;
  let path = "";
  let ambiguous = false;
  const third = segments[2];
  if (third === "tree") {
    /*
     * EVERY `/tree/` WITH A FOLDER IN IT IS AMBIGUOUS, and no amount of looking at the address settles
     * it: `tree/release/2.4` is a branch called `release/2.4` under one reading and a folder `2.4` on
     * `release` under the other, and the same question is open — much less likely to be answered yes —
     * for `tree/main/packages/api`. Only the repository knows which of its branches exist, so this
     * records that the question is open rather than guessing, and `resolveAmbiguousRef` asks GitHub
     * once, at save time, for the branch list.
     *
     * Guessing the other way is not merely wrong, it is wrong invisibly: the skill saves, the address
     * still looks exactly as it was typed, and the folder the person never meant is what the Bot reads.
     * One request on a save is the cheap side of that trade.
     */
    ref = segments[3] ?? null;
    path = segments.slice(4).join("/");
    ambiguous = segments.length > 4;
  } else if (third === "commit") {
    ref = segments[3] ?? null;
  } else if (third !== undefined) {
    return {
      ok: false,
      error:
        "Point at the repository itself, or at a branch or folder inside it — github.com/owner/repo, or github.com/owner/repo/tree/main/packages/api.",
    };
  }

  if (ref !== null && !REF.test(ref)) {
    return {
      ok: false,
      error: "That branch, tag or commit name cannot be read.",
    };
  }

  // Normalised to no leading or trailing slash, because every use joins it to something else.
  path = path.replace(/^\/+|\/+$/g, "");
  if (
    path.split("/").some((segment) => segment === "..") ||
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path)
  ) {
    return {
      ok: false,
      error:
        "A folder inside the repository cannot step outside it. Give a path like packages/api.",
    };
  }

  return { ok: true, value: { owner, repo, ref, path, ambiguous } };
}

/** {@link parseRepoRef}, for the places that have already decided the input is present. */
export function parseRepoRefOrThrow(input: string): ParsedRepo {
  const parsed = parseRepoRef(input);
  if (!parsed.ok) throw new RepoRefusedError(parsed.error, 400);
  return parsed.value;
}

/**
 * Decide whether `release/2.4` is one branch or a branch and a folder, by asking the repository.
 *
 * Called ONCE, at save time, and only for the addresses that are genuinely ambiguous. The repository's
 * branch list is asked for the first segment and the longest ref that is a prefix of the address wins —
 * which is the same rule GitHub's own URLs follow, and which is why `release/2.4` reads as the branch
 * `release/2.4` when it exists and as `release` plus a folder when it does not.
 *
 * The fallback is the plain reading rather than a refusal, because a repository with no branch called
 * `release` and no folder called `2.4` will be refused by the tree read moments later with a sentence
 * that names both possibilities — which is a better answer than this function inventing a second one.
 *
 * A failed call is NOT an error. Saving a skill must not depend on GitHub being reachable, and an
 * ambiguous address that is saved undecided still saves: it is read back as the plain split, and the
 * tree read will refuse it with something a person can act on.
 */
export async function resolveAmbiguousRef(
  parsed: ParsedRepo,
  signal?: AbortSignal,
): Promise<RepoSpec> {
  if (!parsed.ambiguous || !parsed.ref) return parsed;
  const first = parsed.ref.split("/")[0] ?? "";
  if (!first) return parsed;

  let branches: { name?: string }[];
  try {
    branches = await github<{ name?: string }[]>(
      [
        "repos",
        parsed.owner,
        parsed.repo,
        "git",
        "matching-refs",
        "heads",
        first,
      ],
      {},
      signal,
    );
  } catch {
    return parsed;
  }

  const target = `${parsed.ref}/${parsed.path}`;
  let longest = "";
  for (const branch of branches) {
    const name =
      typeof branch.name === "string"
        ? branch.name.replace(/^refs\/heads\//, "")
        : "";
    if (name.length > longest.length && target.startsWith(name)) longest = name;
  }
  if (!longest) return parsed;

  return {
    owner: parsed.owner,
    repo: parsed.repo,
    ref: longest,
    path: target.slice(longest.length).replace(/^\/+/, ""),
  };
}

/** The cached reading of one repository. Bounded by every constant above before it is written. */
export type RepoIndex = {
  /** `owner/repo`, which is what a person reads. */
  fullName: string;
  description: string | null;
  language: string | null;
  /** The branch this was read at. Differs from what was asked for only when none was. */
  ref: string;
  /** The tree's own sha, which is what identifies the content rather than the commit. */
  treeSha: string;
  /**
   * Every file path, with the subfolder stripped so the paths are the ones the author expects.
   *
   * Shallowest first, and alphabetical within a depth. Both halves are load-bearing: shallowest
   * first is what keeps the useful part of an oversized repository, and alphabetical within a depth
   * makes the cached index the same for two people reading the same commit rather than dependent on
   * whatever order the vendor serialised in.
   */
  tree: string[];
  /** The files carried whole: the README, the docs, the manifests. See {@link KEY_FILE_LIMIT}. */
  keyFiles: Record<string, string>;
  /** Whether the tree above is all of it. Never silently false. */
  truncated: boolean;
};

/** The vendor's view of the repository, which is a different shape from {@link RepoIndex}. */
type RepoMetadata = {
  full_name?: string;
  description?: string | null;
  language?: string | null;
  default_branch?: string;
  private?: boolean;
};

type TreeResponse = {
  sha?: string;
  truncated?: boolean;
  tree?: { path?: string; type?: string; sha?: string; size?: number }[];
};

type BlobResponse = {
  content?: string;
  encoding?: string;
  size?: number;
};

type ContentsResponse = {
  content?: string;
  encoding?: string;
  size?: number;
  type?: string;
};

type RateLimit = {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
};

/**
 * One call to GitHub, with every guard this module promises applied in one place.
 *
 * Built from `API` and segments that the parser has already validated. There is no branch in this
 * function that can put a host from the request into the URL, which is the whole of the security
 * argument for the module — so it is worth keeping the call sites narrow: they pass path segments,
 * never a URL they assembled.
 */
async function github<T>(
  segments: string[],
  query: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(
    `${API}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`,
  );
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const token = process.env.GITHUB_API_TOKEN?.trim();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "remii",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      // Composed rather than assigned: a call that outlasts the run it was made for must not
      // outlive it, and a call the caller has already given up on must stop costing GitHub nothing.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : undefined,
    });
  } catch (error) {
    const aborted =
      error instanceof DOMException && error.name === "TimeoutError";
    throw new RepoRefusedError(
      aborted
        ? "GitHub did not answer in time. Try again in a moment."
        : "GitHub could not be reached from here.",
      502,
    );
  }

  if (!response.ok) {
    /*
     * The body is read HERE, once, and handed over — because a `Response` body can only be read once
     * and `vendorRefusal` needs both the status and the vendor's sentence. The alternative, an async
     * `vendorRefusal(response)`, is one `await` away from reading a body that a caller has already
     * consumed, which fails with a confusing parse error rather than with the vendor's message.
     */
    throw vendorRefusal(
      response.status,
      response.headers,
      await response.text(),
    );
  }

  /*
   * The cap is checked from the header rather than by measuring what arrived, because the failure
   * being prevented is a multi-megabyte tree being read into this process before being counted.
   * Header or no header, the length is checked again below: a chunked response has no
   * `content-length`, and that is exactly the one where the header cannot be trusted to be there.
   */
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > RESPONSE_CAP_BYTES) {
    throw new RepoRefusedError(
      "That repository is too large to read here. Point the skill at a folder inside it rather than the whole repository.",
      400,
    );
  }

  const body = await response.text();
  if (body.length > RESPONSE_CAP_BYTES) {
    throw new RepoRefusedError(
      "That repository is too large to read here. Point the skill at a folder inside it rather than the whole repository.",
      400,
    );
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new RepoRefusedError(
      "GitHub answered with something this could not read.",
      502,
    );
  }
}

/**
 * GitHub's refusal, in a sentence the person holding the form can act on.
 *
 * The rate-limit case is spelled out rather than passed through, because it is the one a person
 * cannot fix by editing the URL and the one where silence is most expensive: an unauthenticated
 * deployment has sixty requests an hour for the whole server, so the honest answer names the setting
 * that raises it and says when the limit comes back. The vendor's own message is used for everything
 * else, since a 404 saying `Not Found` is genuinely more useful than anything written here — and a
 * 404 from GitHub on a repository that exists is what a private one looks like, which is why the
 * sentence this returns for it says so rather than leaving the person to guess.
 */
function vendorRefusal(
  status: number,
  headers: Headers,
  body: string,
): RepoRefusedError {
  let message = "";
  try {
    const parsed = JSON.parse(body || "{}") as { message?: string };
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // Nothing readable in it, which is its own answer below.
  }

  const limit = readRateLimit(headers);
  if ((status === 403 || status === 429) && limit.remaining === 0) {
    const reset = limit.reset
      ? new Date(limit.reset * 1000).toLocaleString("en-GB", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "shortly";
    return new RepoRefusedError(
      `This deployment has used its GitHub requests for now, and they come back at ${reset}. Unauthenticated GitHub allows ${limit.limit ?? 60} an hour for the whole server; set GITHUB_API_TOKEN to raise that.`,
      429,
    );
  }

  if (status === 404) {
    return new RepoRefusedError(
      `GitHub has no repository at that address, or it is private. Only public repositories can be read here.${message ? ` GitHub said: ${message}` : ""}`,
      400,
    );
  }

  if (status === 403) {
    return new RepoRefusedError(
      `GitHub refused that request.${message ? ` It said: ${message}` : ""}`,
      403,
    );
  }

  return new RepoRefusedError(
    `GitHub answered ${status}.${message ? ` It said: ${message}` : ""}`,
    502,
  );
}

function readRateLimit(headers: Headers): RateLimit {
  const read = (name: string): number | null => {
    const value = Number(headers.get(name));
    return Number.isFinite(value) ? value : null;
  };
  return {
    limit: read("x-ratelimit-limit"),
    remaining: read("x-ratelimit-remaining"),
    reset: read("x-ratelimit-reset"),
  };
}

/** What one repository is and where its default branch is. */
async function repositoryMetadata(
  spec: RepoSpec,
  signal?: AbortSignal,
): Promise<RepoMetadata> {
  const metadata = await github<RepoMetadata>(
    ["repos", spec.owner, spec.repo],
    {},
    signal,
  );
  if (metadata.private === true) {
    throw new RepoRefusedError(
      "That repository is private. Only public repositories can be read here.",
      400,
    );
  }
  return metadata;
}

/**
 * The files worth carrying whole, in the order they are worth carrying.
 *
 * A README first, because that is what answers "what is this", and manifests next, because they
 * answer "what is this built with and how do I run it". Documentation after both rather than beside
 * them: a repository with a hundred doc pages and one manifest wants the manifest read first, and a
 * repository whose only documentation is `CONTRIBUTING.md` still gets it, because this is a ranking
 * rather than a filter.
 *
 * EXPORTED because the ranking is a decision worth testing directly. Which forty files a deployment
 * carries is the difference between a search that finds the answer and one that does not, and a test
 * that could only reach it by building a whole repository would be a test nobody writes.
 */
export function isKeyFile(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();
  if (lower.startsWith("readme")) return true;
  if (lower === "agents.md" || lower === "claude.md" || lower === "gemini.md") {
    return true;
  }
  if (
    [
      "package.json",
      "pyproject.toml",
      "requirements.txt",
      "go.mod",
      "cargo.toml",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "composer.json",
      "gemfile",
      "makefile",
      "dockerfile",
      "docker-compose.yml",
      "docker-compose.yaml",
      "tsconfig.json",
    ].includes(lower)
  ) {
    return true;
  }
  // Markdown under a docs folder, which is where a project writes the thing a newcomer needs.
  return /(^|\/)docs?\//i.test(path) && /\.(md|mdx|rst|txt)$/i.test(path);
}

function isBinaryPath(path: string): boolean {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return BINARY_EXTENSIONS.has(name.slice(dot + 1));
}

/** Base64 to text, refusing rather than guessing when GitHub sends nothing usable. */
function decodeContent(body: BlobResponse | ContentsResponse): string | null {
  if (body.encoding !== "base64" || typeof body.content !== "string") {
    return null;
  }
  // GitHub wraps base64 at 60 columns. A stray newline in the middle of a chunk is not content.
  const joined = body.content.replace(/\s/g, "");
  try {
    return atob(joined);
  } catch {
    return null;
  }
}

/**
 * The repository and its file list, with nothing fetched beyond that.
 *
 * SPLIT OUT OF {@link buildIndex} BECAUSE THE TWO CALLERS WANT DIFFERENT AMOUNTS. Building a cached
 * index also carries up to {@link KEY_FILE_LIMIT} file contents, which is the expensive half and is
 * worth nothing before a skill has been saved — the Skills page's Check button needs to know whether
 * the address is real, whether it is public, and whether the folder exists, and all three are answered
 * by the metadata and the tree.
 *
 * This is the shape everything else in this module works on. Paths are relative to the subfolder,
 * because every path a person or a model sees is, and both things that can go wrong with an oversized
 * repository — GitHub's own truncation and ours — are decided here rather than at each use.
 */
export type RepoTree = {
  fullName: string;
  description: string | null;
  language: string | null;
  /** The branch actually read, which differs from what was asked for only when none was asked for. */
  ref: string;
  treeSha: string;
  /** Every file path, subfolder stripped, shallowest first, cut at {@link TREE_LIMIT}. */
  paths: string[];
  /**
   * Every blob GitHub described, with its size.
   *
   * Uncut, because the sizes are what {@link buildIndex} uses to decide which files are worth a request
   * and the cut would have thrown away exactly the ones nearest the top that it wants.
   */
  blobs: { path: string; sha: string; size: number }[];
  truncated: boolean;
};

/**
 * Shallowest first, alphabetical within a depth.
 *
 * Both halves are load-bearing. Shallowest first is what keeps the useful part of an oversized
 * repository, because a model looking for something starts at the top of it. Alphabetical within a
 * depth is what makes two people reading the same commit get the same list in the same order, rather
 * than a list that depends on whatever order the vendor happened to serialise in.
 */
function byDepthThenName(
  left: { path: string },
  right: { path: string },
): number {
  const depth = left.path.split("/").length - right.path.split("/").length;
  return depth !== 0 ? depth : left.path.localeCompare(right.path);
}

/**
 * Read a repository's metadata and file tree: two requests, or three when no branch was named.
 *
 * THE ONLY PLACE THAT ASKS GITHUB WHAT A REPOSITORY CONTAINS, so it is where every rule about what may
 * be read is applied: the host is {@link API}, the owner and repository are the two {@link parseRepoRef}
 * validated, and the subfolder is filtered BEFORE the cap so that pointing a skill at one package of a
 * monorepo is how somebody avoids the cap rather than running into it.
 */
export async function readTree(
  spec: RepoSpec,
  signal?: AbortSignal,
): Promise<RepoTree> {
  const metadata = await repositoryMetadata(spec, signal);
  /*
   * `HEAD` IS THE DEFAULT BRANCH, SPELLED THE WAY GITHUB SPELLS IT.
   *
   * It arrives here because a skill with no branch pinned is stored and shown as `.../tree/HEAD`: a
   * folder cannot be written into an address without a branch in it, and pinning to whatever the
   * default was on the day somebody saved a form would silently freeze a repository that was meant to
   * follow its default. Resolving it here, on every read, is what makes that address mean the same
   * thing on every read — and `ref` below is the real branch name, so the Skills page can say which.
   */
  const ref =
    !spec.ref || spec.ref === "HEAD" ? metadata.default_branch : spec.ref;
  if (!ref) {
    throw new RepoRefusedError(
      "GitHub did not say which branch that repository uses.",
      502,
    );
  }

  const tree = await github<TreeResponse>(
    ["repos", spec.owner, spec.repo, "git", "trees", ref],
    { recursive: "1" },
    signal,
  );
  const treeSha = tree.sha ?? "";
  if (!treeSha) {
    throw new RepoRefusedError(
      "GitHub did not describe that repository's files.",
      502,
    );
  }

  const described = (tree.tree ?? [])
    .filter(
      (entry) =>
        entry.type === "blob" && typeof entry.path === "string" && entry.path,
    )
    .map((entry) => ({
      path: entry.path as string,
      sha: entry.sha ?? "",
      size: typeof entry.size === "number" ? entry.size : 0,
    }));

  /*
   * A subfolder that matches nothing is refused rather than answered with an empty list. An empty list
   * is a plausible-looking answer that sends a Bot looking for files that are not there, and the folder
   * being wrong is by far the likeliest thing about it.
   */
  const prefix = spec.path ? `${spec.path}/` : "";
  const inside = described.filter((blob) => blob.path.startsWith(prefix));
  if (prefix && inside.length === 0) {
    throw new RepoRefusedError(
      `There is no folder "${spec.path}" in ${spec.owner}/${spec.repo} on ${ref}. The folder is a path inside the repository, like packages/api.`,
      400,
    );
  }

  const blobs = inside.map((blob) => ({
    ...blob,
    path: blob.path.slice(prefix.length),
  }));
  blobs.sort(byDepthThenName);

  return {
    fullName: metadata.full_name ?? `${spec.owner}/${spec.repo}`,
    description: metadata.description ?? null,
    language: metadata.language ?? null,
    ref,
    treeSha,
    paths: blobs.slice(0, TREE_LIMIT).map((blob) => blob.path),
    blobs,
    // Either of two things, and both are recorded as the same thing because a reader can act on it the
    // same way: point at a folder rather than the whole repository.
    truncated: tree.truncated === true || blobs.length > TREE_LIMIT,
  };
}

/**
 * Read a repository into a {@link RepoIndex}: {@link readTree}, plus the files worth carrying whole.
 *
 * Every request after the tree is one key file, and none is spent on a file the tree already told us is
 * too big — the recursive tree carries each blob's size, so {@link KEY_FILE_CAP_BYTES} is applied before a
 * request rather than after one.
 */
export async function buildIndex(
  spec: RepoSpec,
  signal?: AbortSignal,
): Promise<RepoIndex> {
  const tree = await readTree(spec, signal);

  /*
   * Which files are worth carrying, ranked. The sort is what puts a top-level README ahead of a nested
   * one and a manifest ahead of both, and the byte budget is spent in that order — so a repository with
   * two hundred documentation pages ends up with the forty nearest the root rather than whichever forty
   * GitHub serialised first.
   */
  const ranked = tree.blobs
    .filter(
      (blob) =>
        !isBinaryPath(blob.path) &&
        blob.size <= KEY_FILE_CAP_BYTES &&
        blob.size > 0,
    )
    .sort((left, right) => {
      const rank = (path: string) =>
        isKeyFile(path) ? (path.split("/").length === 1 ? 0 : 1) : 2;
      const byRank = rank(left.path) - rank(right.path);
      return byRank !== 0 ? byRank : byDepthThenName(left, right);
    });

  const keyFiles: Record<string, string> = {};
  let carried = 0;
  let bytes = 0;
  for (const blob of ranked) {
    if (!isKeyFile(blob.path)) continue;
    if (carried >= KEY_FILE_LIMIT) break;
    // Skipped rather than truncated at the boundary: half a manifest is worse than no manifest.
    if (bytes + blob.size > KEY_FILE_BYTES) continue;
    const body = await github<BlobResponse>(
      ["repos", spec.owner, spec.repo, "git", "blobs", blob.sha],
      {},
      signal,
    );
    const text = decodeContent(body);
    /*
     * A blob GitHub will not hand over as base64 is not one to retry per file. The file is simply not
     * among the carried ones, and the tree still lists it as a path — so `repo_read_file` can still read
     * it, which is a better answer than a cache that fills with retries.
     */
    if (text === null) continue;
    keyFiles[blob.path] = text;
    carried += 1;
    bytes += blob.size;
  }

  return {
    fullName: tree.fullName,
    description: tree.description,
    language: tree.language,
    ref: tree.ref,
    treeSha: tree.treeSha,
    tree: tree.paths,
    keyFiles,
    truncated: tree.truncated,
  };
}
/**
 * One file, as text, or a sentence saying why not.
 *
 * `index` is required and consulted before anything is fetched, which is a second gate rather than
 * the first: the parser refuses a path that walks out of the repository, and this refuses one that is
 * not in the repository at all. Two checks that answer different questions, because the first says
 * "that path is not a shape we accept" and only the second can say "there is no such file here" —
 * which is the answer that helps, and the one a path-shaped filter alone would turn into a 400.
 */
export async function readFile(
  spec: RepoSpec,
  path: string,
  index: RepoIndex,
  signal?: AbortSignal,
): Promise<string> {
  const wanted = path.trim().replace(/^\/+/, "");
  if (
    !wanted ||
    wanted.split("/").some((segment) => segment === ".." || segment === ".") ||
    wanted.includes("\\")
  ) {
    throw new RepoRefusedError(
      "Give a path to a file inside the repository, as repo_overview printed it.",
      400,
    );
  }
  if (!index.tree.includes(wanted)) {
    throw new RepoRefusedError(
      `There is no file at "${wanted}" in this repository${index.truncated ? " as far as the cached file list goes" : ""}. repo_overview lists the paths there are.`,
      400,
    );
  }

  const body = await github<ContentsResponse>(
    ["repos", spec.owner, spec.repo, "contents", ...wanted.split("/")],
    { ref: index.ref },
    signal,
  );
  if (body.type === "dir") {
    throw new RepoRefusedError(
      `"${wanted}" is a folder. repo_overview lists what is inside it.`,
      400,
    );
  }
  /*
   * GitHub sends no content at all for anything over its own 1MB ceiling, with `encoding: "none"`.
   * That is a signal rather than a failure, so it is reported as the thing it is: too big to read,
   * and smaller than that is readable.
   */
  const text = decodeContent(body);
  if (text === null) {
    const size = body.size ? ` It is ${Math.round(body.size / 1000)}KB.` : "";
    throw new RepoRefusedError(
      `That file could not be read as text — it is too large or not text.${size}`,
      400,
    );
  }

  return clipToContext(text);
}

/**
 * As much of a file as one tool result may carry, and a sentence about what was left.
 *
 * Both limits are applied and the sentence says which one bound, because a model that has been given
 * the first two thousand lines of a file has no way to know whether that was the whole file. It will
 * otherwise reason about a truncated function as though the code below it did not exist.
 */
export function clipToContext(text: string): string {
  const lines = text.split("\n");
  const byLines = lines.slice(0, FILE_LINE_LIMIT);
  const clippedByLines = byLines.join("\n").length < text.length;
  let out = byLines.join("\n");
  let clippedByBytes = false;
  if (out.length > FILE_BYTE_LIMIT) {
    out = out.slice(0, FILE_BYTE_LIMIT);
    clippedByBytes = true;
  }

  if (!clippedByLines && !clippedByBytes) return out;

  const shownLines = out.split("\n").length;
  const reasons = [
    clippedByLines ? `it is ${lines.length} lines long` : null,
    clippedByBytes ? "the first part is very long lines" : null,
  ].filter(Boolean);
  return `${out}\n\n[Showing the first ${shownLines} of ${lines.length} lines, because ${reasons.join(" and ")}. Read the rest with startLine and endLine.]`;
}

/** One hit, in the shape {@link searchIndex} hands a model. */
export type RepoSearchHit = {
  path: string;
  /** Only for content hits: the line number within the file. Absent on a path hit. */
  line?: number;
  text: string;
};

/**
 * Search the file paths and the carried files, and be exact about which those are.
 *
 * NOT A FULL-TEXT SEARCH OVER THE REPOSITORY, and the reason is {@link KEY_FILE_LIMIT}: fetching
 * every blob to grep it is not something a run does on the strength of one `/` command, on a public
 * API with a sixty-request hourly ceiling. So this covers what a model actually needs to find
 * something — the name of a path, and the string in the README that explains what the thing is — and
 * every caller describes it that way rather than as a search.
 *
 * Matching is case-insensitive substring rather than a regular expression, for the same reason the
 * callers' tools take plain strings: a pattern language handed to a model from a field is a way to
 * run someone else's expression against a cache, and a substring is right often enough that the
 * difference does not matter for finding a file.
 */
export function searchIndex(
  index: RepoIndex,
  query: string,
): { paths: RepoSearchHit[]; contents: RepoSearchHit[] } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { paths: [], contents: [] };

  const paths: RepoSearchHit[] = [];
  for (const path of index.tree) {
    if (paths.length >= SEARCH_PATH_LIMIT) break;
    if (!path.toLowerCase().includes(needle)) continue;
    paths.push({ path, text: path });
  }

  const contents: RepoSearchHit[] = [];
  for (const [path, text] of Object.entries(index.keyFiles)) {
    if (contents.length >= SEARCH_CONTENT_LIMIT) break;
    const lines = text.split("\n");
    for (const [offset, line] of lines.entries()) {
      if (contents.length >= SEARCH_CONTENT_LIMIT) break;
      if (!line.toLowerCase().includes(needle)) continue;
      contents.push({
        path,
        line: offset + 1,
        // A minified bundle or a data table has a line long enough to be the whole result on its own.
        text: line.trim().slice(0, 400),
      });
    }
  }

  return { paths, contents };
}
