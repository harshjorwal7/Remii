import { z } from "zod";

/**
 * The five things a person decides about a skill.
 *
 * THE LIMITS MATCH THE SERVER'S PARSER EXACTLY, so a form that submits is a form that will be
 * accepted, and a rejection is shown next to the field that caused it rather than as a failed
 * request with a sentence at the top of the page.
 *
 * The slug pattern is `routes.ts`'s, character for character: lower-case letters, digits and
 * hyphens, starting and ending on an alphanumeric, 2 to 40 long. Loosening it here would only move
 * the refusal later, to a place where it reads as the save being broken.
 */
export const skillFormSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1, "A command is required.")
    .regex(
      /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/,
      "Lower-case letters, numbers and hyphens, 2 to 40 characters.",
    ),
  title: z
    .string()
    .trim()
    .min(1, "A title is required.")
    .max(120, "Title must be 120 characters or fewer."),
  /** Optional on the server too, which is why there is no minimum here. */
  summary: z
    .string()
    .trim()
    .max(200, "The one-liner must be 200 characters or fewer."),
  instructions: z
    .string()
    .trim()
    .min(1, "Instructions are required — this is what the Bot follows."),
  /**
   * The tools this skill says it needs, as `<serverId>/<toolName>` refs.
   *
   * No minimum, and no validation of the refs themselves. A skill needing no tool is ordinary — most
   * are prose — and the server already refuses a ref it has never seen with a sentence naming it,
   * which is a better answer than anything this file could reconstruct about which tools exist.
   *
   * Part of the form rather than saved on press, unlike granting. What a skill needs is the author's
   * draft until they save it, so unticking one and closing the panel has to change nothing.
   */
  tools: z.array(z.string()),
  /**
   * The public repository this skill is about, or null for a skill that is only prose.
   *
   * ONE STRING RATHER THAN THREE FIELDS, because a repository is one thing a person names and the
   * branch and folder are parts of the address rather than separate decisions. Somebody pasting
   * `github.com/owner/repo/tree/release/2.4/packages/api` should get that repository, that branch and
   * that folder without having to notice they pasted all three — which is why the parser here is the
   * same one the server runs, and why a saved skill stores the four values it produced rather than the
   * string it was given. See {@link splitRepoUrl}.
   *
   * Null rather than undefined, and the difference is load-bearing on the wire: the server replaces the
   * pointer on every save, so an absent field would leave whatever was there before and emptying this
   * box would silently do nothing. A field that cannot be left out is the one whose clearing works.
   *
   * The URL itself is NOT validated here. {@link repoUrlRefusal} mirrors the server's parser for the
   * immediate feedback, but the rules are the server's, and this file's own contract at the top is
   * that the limits match exactly rather than approximately — a second implementation of "is this a
   * GitHub address" is one more thing to drift, and the server's sentence is the better one.
   */
  repo: z.string().nullable(),
});

export type SkillFormValues = z.infer<typeof skillFormSchema>;

export const emptySkillForm: SkillFormValues = {
  slug: "",
  title: "",
  summary: "",
  instructions: "",
  tools: [],
  repo: null,
};

/**
 * A repository address split into what the server stores, for showing somebody what they pasted.
 *
 * A COPY OF `parseRepoRef`, not an import of it: the parser is in `server/src`, and importing from
 * there into the app bundle would pull a module that reads `process.env` into code that runs in a
 * browser. So this mirrors the shapes and nothing else — no fetching, no environment, no schema — and
 * every decision it makes is one the server re-makes and can refuse. Where the two disagree the server
 * wins and its sentence is what the person reads, which is the outcome this duplication is allowed to
 * have; the only thing this buys is showing the split address before the save rather than after it.
 *
 * Returns null for anything it cannot read confidently, which the caller treats as "leave it alone"
 * rather than as an error: the Check button's answer is GitHub's, not this function's.
 */
type ParsedRepo = {
  owner: string;
  repo: string;
  ref: string | null;
  path: string;
};

export function splitRepoUrl(
  input: string,
): { owner: string; repo: string; ref: string | null; path: string } | null {
  const shape = repoShape(input);
  if (!shape) return null;
  return shape.split;
}

/**
 * What the form can say about an address, before asking GitHub.
 *
 * Null when there is nothing to say, which is the ordinary case: anything GitHub can decide — whether
 * the repository exists, whether it is public, whether the folder is in it — is asked of GitHub by the
 * Check button rather than guessed at here. Only the failures that are visible without a network call
 * are answered, because a locally invented "that repository does not exist" on an address the server
 * would have read is the one failure this screen must not have.
 *
 * THE MESSAGES ARE THE SERVER'S, VERBATIM, and that is the whole of this function's contract. It exists
 * so the sentence beside the field and the sentence in the banner after a refused save are the same
 * one; if they ever drift, the screen starts contradicting itself about the same mistake. The tests are
 * what hold them to that.
 */
export function repoUrlRefusal(input: string): string | null {
  return repoShape(input)?.error ?? null;
}

function repoShape(
  input: string,
): { split: ParsedRepo; error: null } | { split: null; error: string } | null {
  const raw = input.trim();
  if (!raw) return { split: null, error: "A repository URL is required." };

  /*
   * The server's first check, and first for the same reason: `new URL()` resolves dot segments itself,
   * so `.../tree/main/a/../../b` arrives here already collapsed to `b` and would look like a branch
   * somebody asked for. The evidence exists only on the raw string.
   */
  if (/(?:^|\/)\.\.(?:\/|$)/.test(raw)) {
    return {
      split: null,
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
      return { split: null, error: "That is not a URL this can read." };
    }
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") {
      return {
        split: null,
        error:
          "Only GitHub repositories can be read here. Give a github.com address — a repository on any other host is not reachable.",
      };
    }
    if (url.protocol !== "https:") {
      return { split: null, error: "Use the https address of the repository." };
    }
    if (url.search !== "" || url.hash !== "") {
      return {
        split: null,
        error:
          "Give the repository address itself, without a link's options. Use github.com/owner/repo/tree/main to name a branch.",
      };
    }
    rest = url.pathname;
  } else if (/^github\.com\//i.test(raw)) {
    rest = raw.replace(/^github\.com\//i, "");
  } else if (/^[\w.-]+\/[\w.-]+(?:\/.*)?$/.test(raw)) {
    // The hostless form, with or without a branch and folder.
    rest = raw;
  } else {
    return {
      split: null,
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
        return segment;
      }
    })
    .filter((segment) => segment.length > 0);

  if (segments.length < 2) {
    return {
      split: null,
      error:
        "A repository address names an owner and a repository — for example https://github.com/owner/repo.",
    };
  }

  const owner = segments[0] ?? "";
  const repo = (segments[1] ?? "").replace(/\.git$/i, "");
  const segment = /^[A-Za-z0-9._-]{1,100}$/;
  if (!segment.test(owner) || !segment.test(repo)) {
    return {
      split: null,
      error:
        "That address has characters a GitHub owner or repository name cannot contain.",
    };
  }

  let ref: string | null = null;
  let path = "";
  const third = segments[2];
  if (third === "tree") {
    ref = segments[3] ?? null;
    path = segments.slice(4).join("/");
  } else if (third === "commit") {
    ref = segments[3] ?? null;
  } else if (third !== undefined) {
    return {
      split: null,
      error:
        "Point at the repository itself, or at a branch or folder inside it — github.com/owner/repo, or github.com/owner/repo/tree/main/packages/api.",
    };
  }

  if (
    ref !== null &&
    !/^(?![./])(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]{1,255}$/.test(ref)
  ) {
    return {
      split: null,
      error: "That branch, tag or commit name cannot be read.",
    };
  }

  path = path.replace(/^\/+|\/+$/g, "");
  if (
    path.split("/").some((part) => part === "..") ||
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path)
  ) {
    return {
      split: null,
      error:
        "A folder inside the repository cannot step outside it. Give a path like packages/api.",
    };
  }

  return { split: { owner, repo, ref, path }, error: null };
}

/**
 * The declared refs no connected server offers.
 *
 * WHY THIS EXISTS. The picker draws the tools of the servers this deployment has connected, and a
 * skill's declared set is not confined to those: a package ships skills declaring tools for
 * connectors nobody has added yet, and a person's own skill outlives the server it was written
 * against. Rendering only what matched meant the screen showed a subset of the declaration and
 * presented it as the whole thing — a skill needing two tools drew one, and nothing said the other
 * was there. Editing it silently kept a tool the author had just been shown they did not have.
 *
 * A wrong number on a screen somebody governs with is worse than no number, so the leftovers are
 * named rather than dropped. They are not an error: a ref for a connector that does not exist here
 * loads nothing, because the offer is intersected with the Bot's grants.
 */
export function undeclaredElsewhere(
  selected: readonly string[],
  offered: readonly string[],
): string[] {
  const known = new Set(offered);
  return selected.filter((ref) => !known.has(ref));
}
